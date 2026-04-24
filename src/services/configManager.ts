import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ByokConfig,
  ProviderConfig,
  FeatureFlags,
  DebugConfig,
  ValidationResult,
} from '../context/types';
import { IConfigManager } from '../context/contracts';
import { Logger } from './logger';

const CONFIG_SECTION = 'sukiTab';
const CONFIG_PATH_SETTING = 'configFilePath';
const DEFAULT_CONFIG_FILE = 'byok-config.json';
const WATCH_DEBOUNCE_MS = 300;

function createDefaultConfigTemplate(): ByokConfig {
  return {
    providers: [
      {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/beta',
        apiKey: '',
        apiType: 'completions',
        model: 'deepseek-chat',
        temperature: 0.2,
        maxTokens: 4096,
        contextLength: 8192,
        stopTokens: [],
        fimTemplate: null,
        customPrompt: null,
      },
    ],
    activeProvider: 'deepseek',
    features: {
      enabled: true,
      enableInlineSuggestions: true,
      enablePrediction: true,
      enableDiagnosticsHints: true,
      enableAdditionalFilesContext: true,
      triggerInComments: true,
      excludedLanguages: [],
    },
    debug: {
      enabled: false,
      logStream: false,
      logPayloads: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function serializeConfig(config: ByokConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function readFileUtf8(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (error, data) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(data);
    });
  });
}

function writeFileUtf8(filePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, content, 'utf8', (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function mkdirRecursive(dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdir(dirPath, { recursive: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class ConfigManager implements IConfigManager, vscode.Disposable {
  private readonly logger = Logger.getInstance();
  private readonly changeEmitter = new vscode.EventEmitter<ByokConfig>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly context: vscode.ExtensionContext;
  private readonly ready: Promise<void>;

  private currentConfig: ByokConfig = createDefaultConfigTemplate();
  private lastSerializedConfig = serializeConfig(this.currentConfig);
  private configFilePath: string;
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.configFilePath = this.resolveConfigFilePath();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_PATH_SETTING}`)) {
          return;
        }

        void this.handleConfigPathSettingChanged();
      })
    );

    this.ready = this.initialize();
  }

  get config(): ByokConfig {
    return this.currentConfig;
  }

  get activeProvider(): ProviderConfig {
    return (
      this.currentConfig.providers.find(
        (provider) => provider.name === this.currentConfig.activeProvider
      ) ?? this.currentConfig.providers[0]
    );
  }

  get features(): FeatureFlags {
    return this.currentConfig.features;
  }

  get debug(): DebugConfig {
    return this.currentConfig.debug;
  }

  getConfigFilePath(): string {
    return this.configFilePath;
  }

  getProviders(): ProviderConfig[] {
    return this.currentConfig.providers;
  }

  async setActiveProvider(name: string): Promise<void> {
    await this.ready;

    const normalizedName = name.trim();
    if (!isNonEmptyString(normalizedName)) {
      throw new Error('Provider name cannot be empty.');
    }

    const exists = this.currentConfig.providers.some((provider) => provider.name === normalizedName);
    if (!exists) {
      throw new Error(`Provider '${normalizedName}' was not found in the BYOK config.`);
    }

    if (normalizedName === this.currentConfig.activeProvider) {
      return;
    }

    await this.writeConfig(
      {
        ...this.currentConfig,
        activeProvider: normalizedName,
      },
      true
    );
  }

  async updateConfig(config: ByokConfig): Promise<void> {
    await this.ready;
    await this.writeConfig(config, true);
  }

  validateProvider(provider: ProviderConfig): ValidationResult {
    const issues: string[] = [];

    if (!isNonEmptyString(provider.name)) {
      issues.push('Provider name must not be empty.');
    }
    if (!provider.baseUrl.startsWith('http')) {
      issues.push('Provider baseUrl must start with http.');
    }
    if (!isNonEmptyString(provider.apiKey)) {
      issues.push('Provider apiKey must not be empty.');
    }
    if (!isNonEmptyString(provider.model)) {
      issues.push('Provider model must not be empty.');
    }
    if (!Number.isFinite(provider.temperature) || provider.temperature < 0 || provider.temperature > 2) {
      issues.push('Provider temperature must be between 0 and 2.');
    }
    if (!Number.isFinite(provider.maxTokens) || provider.maxTokens <= 0) {
      issues.push('Provider maxTokens must be greater than 0.');
    }
    if (!Number.isFinite(provider.contextLength) || provider.contextLength <= 0) {
      issues.push('Provider contextLength must be greater than 0.');
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  async createDefaultConfigFile(): Promise<void> {
    await this.ready;
    await this.createDefaultConfigFileInternal(true);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }

    this.watcher?.close();
    this.watcher = undefined;

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.disposables.length = 0;
    this.changeEmitter.dispose();
  }

  private async initialize(): Promise<void> {
    await this.loadConfigFromDisk(true);
    this.resetWatcher();
  }

  private async handleConfigPathSettingChanged(): Promise<void> {
    const nextPath = this.resolveConfigFilePath();
    if (nextPath === this.configFilePath) {
      return;
    }

    this.configFilePath = nextPath;
    this.logger.info(`[ConfigManager] Using BYOK config file: ${this.configFilePath}`);

    await this.loadConfigFromDisk(true);
    this.resetWatcher();
  }

  private resolveConfigFilePath(): string {
    const configuredValue = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>(CONFIG_PATH_SETTING, '');
    const trimmedPath = configuredValue.trim();

    if (trimmedPath.length > 0 && trimmedPath !== DEFAULT_CONFIG_FILE) {
      if (path.isAbsolute(trimmedPath)) {
        return path.normalize(trimmedPath);
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        return path.resolve(workspaceRoot, trimmedPath);
      }

      return path.resolve(this.context.globalStorageUri.fsPath, trimmedPath);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const projectConfigPath = path.join(workspaceRoot, '.vscode', DEFAULT_CONFIG_FILE);
      if (fs.existsSync(projectConfigPath)) {
        return projectConfigPath;
      }
    }

    return path.resolve(this.context.globalStorageUri.fsPath, DEFAULT_CONFIG_FILE);
  }

  private resetWatcher(): void {
    if (this.disposed) {
      return;
    }

    this.watcher?.close();
    this.watcher = undefined;

    try {
      this.watcher = fs.watch(this.configFilePath, (eventType) => {
        this.scheduleReload(eventType);
      });
      this.watcher.on('error', (error) => {
        this.logger.error(`[ConfigManager] File watcher error for ${this.configFilePath}`, error);
      });
    } catch (error) {
      this.logger.error(`[ConfigManager] Failed to watch BYOK config: ${this.configFilePath}`, error);
    }
  }

  private scheduleReload(eventType: string): void {
    if (this.disposed) {
      return;
    }

    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reloadFromWatcher(eventType);
    }, WATCH_DEBOUNCE_MS);
  }

  private async reloadFromWatcher(eventType: string): Promise<void> {
    await this.loadConfigFromDisk(true);

    if (eventType === 'rename') {
      this.resetWatcher();
    }
  }

  private async loadConfigFromDisk(fireEvent: boolean): Promise<void> {
    try {
      const rawContent = await readFileUtf8(this.configFilePath);
      const parsed = JSON.parse(rawContent) as unknown;
      const normalizedConfig = this.normalizeConfig(parsed);
      this.applyConfig(normalizedConfig, fireEvent);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.logger.warn(
          `[ConfigManager] BYOK config file not found at ${this.configFilePath}. Creating default template.`
        );
        await this.createDefaultConfigFileInternal(fireEvent);
        return;
      }

      if (error instanceof SyntaxError) {
        this.logger.error(`[ConfigManager] Failed to parse BYOK config at ${this.configFilePath}`, error);
        void vscode.window.showWarningMessage(
          `SukiTab BYOK 配置文件解析失败：${this.configFilePath}。已继续使用上一次有效配置。`
        );
        return;
      }

      this.logger.error(`[ConfigManager] Failed to load BYOK config from ${this.configFilePath}`, error);
    }
  }

  private async createDefaultConfigFileInternal(fireEvent: boolean): Promise<void> {
    const defaultConfig = createDefaultConfigTemplate();
    await this.writeConfig(defaultConfig, fireEvent);
    this.logger.warn(`[ConfigManager] Default BYOK config created at ${this.configFilePath}`);
  }

  private async writeConfig(config: ByokConfig, fireEvent: boolean): Promise<void> {
    const normalizedConfig = this.normalizeConfig(config);
    const serializedConfig = serializeConfig(normalizedConfig);

    await mkdirRecursive(path.dirname(this.configFilePath));
    await writeFileUtf8(this.configFilePath, serializedConfig);

    this.applyConfig(normalizedConfig, fireEvent, serializedConfig);
  }

  private applyConfig(
    nextConfig: ByokConfig,
    fireEvent: boolean,
    serializedConfig = serializeConfig(nextConfig)
  ): void {
    const changed = serializedConfig !== this.lastSerializedConfig;

    this.currentConfig = nextConfig;
    this.lastSerializedConfig = serializedConfig;

    if (fireEvent && changed) {
      this.changeEmitter.fire(this.currentConfig);
    }
  }

  private normalizeConfig(value: unknown): ByokConfig {
    const defaults = createDefaultConfigTemplate();
    if (!isRecord(value)) {
      return defaults;
    }

    const providerInputs = Array.isArray(value.providers) ? value.providers : [];
    const normalizedProviders = providerInputs
      .map((provider) => this.normalizeProvider(provider, defaults.providers[0]))
      .filter((provider) => provider.name.length > 0);

    const providers = normalizedProviders.length > 0 ? normalizedProviders : defaults.providers;
    const requestedActiveProvider =
      typeof value.activeProvider === 'string' ? value.activeProvider.trim() : defaults.activeProvider;
    const activeProvider =
      providers.find((provider) => provider.name === requestedActiveProvider)?.name ?? providers[0].name;

    return {
      providers,
      activeProvider,
      features: this.normalizeFeatures(value.features, defaults.features),
      debug: this.normalizeDebug(value.debug, defaults.debug),
    };
  }

  private normalizeProvider(value: unknown, fallback: ProviderConfig): ProviderConfig {
    if (!isRecord(value)) {
      return {
        ...fallback,
        stopTokens: [...fallback.stopTokens],
      };
    }

    return {
      name: typeof value.name === 'string' ? value.name.trim() : fallback.name,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim() : fallback.baseUrl,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : fallback.apiKey,
      apiType:
        value.apiType === 'chat' || value.apiType === 'completions' ? value.apiType : fallback.apiType,
      model: typeof value.model === 'string' ? value.model.trim() : fallback.model,
      temperature:
        typeof value.temperature === 'number' && Number.isFinite(value.temperature)
          ? value.temperature
          : fallback.temperature,
      maxTokens:
        typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens)
          ? value.maxTokens
          : fallback.maxTokens,
      contextLength:
        typeof value.contextLength === 'number' && Number.isFinite(value.contextLength)
          ? value.contextLength
          : fallback.contextLength,
      stopTokens: Array.isArray(value.stopTokens)
        ? value.stopTokens.filter((token): token is string => typeof token === 'string')
        : [...fallback.stopTokens],
      fimTemplate:
        typeof value.fimTemplate === 'string' || value.fimTemplate === null
          ? value.fimTemplate
          : fallback.fimTemplate,
      customPrompt:
        typeof value.customPrompt === 'string' || value.customPrompt === null
          ? value.customPrompt
          : fallback.customPrompt,
      headers: isRecord(value.headers) ? value.headers as Record<string, string> : fallback.headers,
      extraBody: isRecord(value.extraBody) ? value.extraBody as Record<string, unknown> : fallback.extraBody,
    };
  }

  private normalizeFeatures(value: unknown, fallback: FeatureFlags): FeatureFlags {
    if (!isRecord(value)) {
      return {
        ...fallback,
        excludedLanguages: [...fallback.excludedLanguages],
      };
    }

    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
      enableInlineSuggestions:
        typeof value.enableInlineSuggestions === 'boolean'
          ? value.enableInlineSuggestions
          : fallback.enableInlineSuggestions,
      enablePrediction:
        typeof value.enablePrediction === 'boolean'
          ? value.enablePrediction
          : fallback.enablePrediction,
      enableDiagnosticsHints:
        typeof value.enableDiagnosticsHints === 'boolean'
          ? value.enableDiagnosticsHints
          : fallback.enableDiagnosticsHints,
      enableAdditionalFilesContext:
        typeof value.enableAdditionalFilesContext === 'boolean'
          ? value.enableAdditionalFilesContext
          : fallback.enableAdditionalFilesContext,
      triggerInComments:
        typeof value.triggerInComments === 'boolean'
          ? value.triggerInComments
          : fallback.triggerInComments,
      excludedLanguages: Array.isArray(value.excludedLanguages)
        ? value.excludedLanguages.filter((language): language is string => typeof language === 'string')
        : [...fallback.excludedLanguages],
    };
  }

  private normalizeDebug(value: unknown, fallback: DebugConfig): DebugConfig {
    if (!isRecord(value)) {
      return { ...fallback };
    }

    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
      logStream: typeof value.logStream === 'boolean' ? value.logStream : fallback.logStream,
      logPayloads: typeof value.logPayloads === 'boolean' ? value.logPayloads : fallback.logPayloads,
    };
  }
}
