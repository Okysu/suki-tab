import * as vscode from 'vscode';
import { IConfigManager } from '../context/contracts';
import { ByokConfig, ProviderConfig, FeatureFlags, DebugConfig, ApiType, ConnectionTestResult } from '../context/types';

/** Message from Webview → Host */
interface WebviewMessage {
  type: string;
  name?: string;
  provider?: ProviderConfig;
  features?: FeatureFlags;
  debug?: DebugConfig;
}

/** Message from Host → Webview */
interface HostMessage {
  type: string;
  config?: ByokConfig;
  result?: { success: boolean; message: string; latencyMs?: number };
  message?: string;
}

export class SettingsPanel {
  public static readonly viewType = 'sukiTab.settings';
  private static currentPanel: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly configManager: IConfigManager;
  private readonly testConnectionFn: () => Promise<ConnectionTestResult>;
  private disposables: vscode.Disposable[] = [];
  private configChangeDisposable: vscode.Disposable | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    configManager: IConfigManager,
    testConnectionFn: () => Promise<ConnectionTestResult>,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.configManager = configManager;
    this.testConnectionFn = testConnectionFn;

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message as WebviewMessage),
      undefined,
      this.disposables,
    );

    // Auto-refresh when config changes
    this.configChangeDisposable = configManager.onDidChange((config: ByokConfig) => {
      this.postOrQueueMessage({ type: 'config', config });
    });

    this.setHtmlForWebview(this.panel.webview);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    configManager: IConfigManager,
    testConnectionFn: () => Promise<ConnectionTestResult>,
  ): SettingsPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      SettingsPanel.currentPanel.refreshConfig();
      return SettingsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'SukiTab Settings',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, configManager, testConnectionFn);
    SettingsPanel.currentPanel.refreshConfig();
    return SettingsPanel.currentPanel;
  }

  private refreshConfig(): void {
    const config = this.configManager.config;
    this.postOrQueueMessage({ type: 'config', config });
  }

  private postOrQueueMessage(message: HostMessage): void {
    this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'getConfig': {
          this.refreshConfig();
          break;
        }

        case 'setActiveProvider': {
          if (message.name) {
            await this.configManager.setActiveProvider(message.name);
            this.refreshConfig();
          }
          break;
        }

        case 'addProvider': {
          if (message.provider) {
            const config = { ...this.configManager.config };
            config.providers = [...config.providers, message.provider];
            if (config.providers.length === 1) {
              config.activeProvider = message.provider.name;
            }
            await this.configManager.updateConfig(config);
            this.refreshConfig();
          }
          break;
        }

        case 'updateProvider': {
          if (message.name && message.provider) {
            const config = { ...this.configManager.config };
            config.providers = config.providers.map((p) =>
              p.name === message.name ? message.provider! : p,
            );
            if (config.activeProvider === message.name) {
              config.activeProvider = message.provider.name;
            }
            await this.configManager.updateConfig(config);
            this.refreshConfig();
          }
          break;
        }

        case 'deleteProvider': {
          if (message.name) {
            const config = { ...this.configManager.config };
            const remaining = config.providers.filter((p) => p.name !== message.name);
            if (remaining.length === 0) {
              this.postOrQueueMessage({
                type: 'error',
                message: 'Cannot delete the last provider.',
              });
              return;
            }
            config.providers = remaining;
            if (config.activeProvider === message.name) {
              config.activeProvider = remaining[0].name;
            }
            await this.configManager.updateConfig(config);
            this.refreshConfig();
          }
          break;
        }

        case 'updateFeatures': {
          if (message.features) {
            const config = { ...this.configManager.config };
            config.features = message.features;
            await this.configManager.updateConfig(config);
            this.refreshConfig();
          }
          break;
        }

        case 'updateDebug': {
          if (message.debug) {
            const config = { ...this.configManager.config };
            config.debug = message.debug;
            await this.configManager.updateConfig(config);
            this.refreshConfig();
          }
          break;
        }

        case 'openConfigFile': {
          vscode.commands.executeCommand('suki-tab.openConfigFile');
          break;
        }

        case 'testConnection': {
          if (!this.configManager.activeProvider) {
            this.postOrQueueMessage({
              type: 'connectionResult',
              result: { success: false, message: 'No active provider configured.' },
            });
            break;
          }
          const result = await this.testConnection();
          this.postOrQueueMessage({ type: 'connectionResult', result });
          break;
        }

        default: {
          this.postOrQueueMessage({
            type: 'error',
            message: `Unknown message type: ${message.type}`,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postOrQueueMessage({ type: 'error', message });
    }
  }

  private async testConnection(): Promise<{ success: boolean; message: string; latencyMs?: number }> {
    try {
      const result = await this.testConnectionFn();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Connection test failed: ${msg}` };
    }
  }

  private setHtmlForWebview(webview: vscode.Webview): void {
    webview.html = getHtmlForWebview(webview);
  }

  public dispose(): void {
    if (SettingsPanel.currentPanel === this) {
      SettingsPanel.currentPanel = undefined;
    }

    this.configChangeDisposable?.dispose();
    this.configChangeDisposable = undefined;

    this.panel.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}

/* ─────────────────────────────────────────────
   HTML / CSS / JS — Self-contained webview
   ───────────────────────────────────────────── */

function getHtmlForWebview(webview: vscode.Webview): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SukiTab Settings</title>
<style>
:root {
  --fg: var(--vscode-foreground, #ccc);
  --bg: var(--vscode-editor-background, #1e1e1e);
  --input-bg: var(--vscode-input-background, #3c3c3c);
  --input-border: var(--vscode-input-border, #555);
  --input-fg: var(--vscode-input-foreground, #ccc);
  --btn-bg: var(--vscode-button-background, #0e639c);
  --btn-fg: var(--vscode-button-foreground, #fff);
  --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
  --btn-secondary: var(--vscode-button-secondaryBackground, #555);
  --btn-secondary-hover: var(--vscode-button-secondaryHoverBackground, #666);
  --danger: var(--vscode-inputValidation-errorBorder, #f14c4c);
  --success: #4ec9b0;
  --focus: var(--vscode-focusBorder, #007fd4);
  --border: var(--vscode-panel-border, #555);
  --badge-bg: var(--vscode-badge-background, #4d4d4d);
  --badge-fg: var(--vscode-badge-foreground, #fff);
  --card-border: var(--vscode-widget-border, #555);
  --separator: var(--vscode-settings-dropdownListBorder, #555);
  --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  --size: var(--vscode-font-size, 13px);
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  font-size: var(--size);
  color: var(--fg);
  background: var(--bg);
  line-height: 1.4;
  padding: var(--spacing-lg);
}

h1 { font-size: 1.4em; font-weight: 600; margin-bottom: var(--spacing-sm); }
h2 { font-size: 1.1em; font-weight: 600; margin: var(--spacing-lg) 0 var(--spacing-sm); }
h3 { font-size: 1em; font-weight: 500; margin-bottom: var(--spacing-xs); }

a { color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-lg);
  padding-bottom: var(--spacing-md);
  border-bottom: 1px solid var(--border);
}
.header-left { display: flex; align-items: center; gap: var(--spacing-sm); }
.header-actions { display: flex; gap: var(--spacing-sm); align-items: center; }

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.85em;
  font-weight: 500;
  gap: 4px;
}
.badge-active {
  background: var(--success);
  color: #000;
}
.badge-inactive {
  background: var(--badge-bg);
  color: var(--badge-fg);
}

/* Sections */
.section {
  margin-bottom: var(--spacing-xl);
}

/* Cards */
.card {
  border: 1px solid var(--card-border);
  border-radius: 4px;
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-sm);
  position: relative;
}
.card.active {
  border-color: var(--success);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-xs);
}
.card-title { font-weight: 600; }

.card-details {
  font-size: 0.92em;
  opacity: 0.8;
  margin-bottom: var(--spacing-sm);
}
.card-details div { margin-bottom: 2px; }

.card-actions {
  display: flex;
  gap: var(--spacing-xs);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: 3px;
  font-size: var(--size);
  font-family: var(--font);
  cursor: pointer;
  color: var(--btn-fg);
  background: var(--btn-bg);
  transition: background 0.15s;
}
.btn:hover { background: var(--btn-hover); }
.btn:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }

.btn-secondary {
  background: var(--btn-secondary);
}
.btn-secondary:hover { background: var(--btn-secondary-hover); }

.btn-danger {
  background: var(--danger);
}
.btn-danger:hover { opacity: 0.85; }

.btn-sm {
  padding: 2px 8px;
  font-size: 0.88em;
}

.btn-icon {
  padding: 4px 6px;
  min-width: 28px;
  justify-content: center;
}

/* Forms */
.form-group {
  margin-bottom: var(--spacing-sm);
}
.form-group label {
  display: block;
  font-weight: 500;
  font-size: 0.92em;
  margin-bottom: var(--spacing-xs);
}
.form-group input[type="text"],
.form-group input[type="number"],
.form-group input[type="password"],
.form-group textarea,
.form-group select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--input-border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--input-fg);
  font-family: var(--font);
  font-size: var(--size);
}
.form-group textarea {
  resize: vertical;
  min-height: 60px;
}
.form-group input:focus,
.form-group textarea:focus,
.form-group select:focus {
  outline: 1px solid var(--focus);
  border-color: var(--focus);
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-sm);
}
.form-full { grid-column: 1 / -1; }

.form-actions {
  display: flex;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-md);
}

/* Toggle */
.toggle-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) 0;
  border-bottom: 1px solid var(--separator);
}
.toggle-group:last-child { border-bottom: none; }
.toggle-label { font-weight: 500; }
.toggle-description { font-size: 0.88em; opacity: 0.7; }

.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
}
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute;
  inset: 0;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 11px;
  cursor: pointer;
  transition: 0.2s;
}
.slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--fg);
  border-radius: 50%;
  transition: 0.2s;
}
.switch input:checked + .slider {
  background: var(--btn-bg);
  border-color: var(--btn-bg);
}
.switch input:checked + .slider::before {
  transform: translateX(18px);
}
.switch input:focus-visible + .slider {
  outline: 1px solid var(--focus);
  outline-offset: 1px;
}

/* Master toggle highlight */
.toggle-master {
  background: rgba(14, 99, 156, 0.08);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: 4px;
  border: 1px solid var(--separator);
  margin-bottom: var(--spacing-sm);
}

/* Password field wrapper */
.password-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}
.password-wrapper input { flex: 1; padding-right: 36px; }
.password-toggle {
  position: absolute;
  right: 6px;
  background: none;
  border: none;
  color: var(--fg);
  cursor: pointer;
  padding: 4px;
  font-size: 1em;
  opacity: 0.6;
}
.password-toggle:hover { opacity: 1; }

/* Status */
.status-message {
  padding: var(--spacing-sm);
  border-radius: 3px;
  margin-bottom: var(--spacing-sm);
  font-size: 0.92em;
}
.status-success { background: rgba(78, 201, 176, 0.12); border: 1px solid var(--success); }
.status-error { background: rgba(241, 76, 76, 0.12); border: 1px solid var(--danger); }
.status-info { background: rgba(0, 127, 212, 0.12); border: 1px solid var(--focus); }

/* Connection test */
.test-result {
  margin-top: var(--spacing-sm);
}

/* Edit form overlay */
.edit-overlay {
  background: var(--bg);
  border: 1px solid var(--card-border);
  border-radius: 4px;
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-sm);
}

/* Scrollable list */
.provider-list {
  max-height: 400px;
  overflow-y: auto;
}

/* Empty state */
.empty-state {
  text-align: center;
  padding: var(--spacing-xl);
  opacity: 0.6;
}

/* Separator */
.separator {
  height: 1px;
  background: var(--border);
  margin: var(--spacing-lg) 0;
}
</style>
</head>
<body>

<div id="app">
  <div class="header">
    <div class="header-left">
      <h1>SukiTab Settings</h1>
      <span id="activeBadge" class="badge badge-inactive"><span class="codicon codicon-server"></span> —</span>
    </div>
    <div class="header-actions">
      <a id="openConfigLink" href="#">Open Config File</a>
      <button class="btn btn-secondary btn-sm" id="testConnBtn">Test Connection</button>
    </div>
  </div>

  <div id="statusContainer"></div>

  <div class="section">
    <h2>Providers</h2>
    <div id="providerList" class="provider-list"></div>
    <div id="editFormContainer"></div>
    <button class="btn" id="addProviderBtn">Add Provider</button>
  </div>

  <div class="separator"></div>

  <div class="section">
    <h2>Feature Flags</h2>
    <div id="featuresList"></div>
  </div>

  <div class="separator"></div>

  <div class="section">
    <h2>Debug Settings</h2>
    <div id="debugList"></div>
  </div>

  <div class="test-result" id="testResult"></div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  let config = null;
  let editingProviderName = null;

  function post(msg) { vscode.postMessage(msg); }

  function $(sel) { return document.querySelector(sel); }

  // Init: request config on load
  post({ type: 'getConfig' });

  // Handle messages from host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'config':
        config = msg.config;
        render();
        break;
      case 'connectionResult':
        renderTestResult(msg.result);
        break;
      case 'error':
        showStatus(msg.message, 'error');
        break;
    }
  });

  function render() {
    if (!config) return;
    renderHeader();
    renderProviders();
    renderFeatures();
    renderDebug();
  }

  function renderHeader() {
    const activeName = config.activeProvider || 'None';
    const badge = $('#activeBadge');
    const provider = config.providers.find(p => p.name === activeName);
    if (provider) {
      badge.className = 'badge badge-active';
      badge.innerHTML = provider.name;
    } else {
      badge.className = 'badge badge-inactive';
      badge.innerHTML = 'None';
    }
  }

  function renderProviders() {
    const list = $('#providerList');
    if (!config || !config.providers || config.providers.length === 0) {
      list.innerHTML = '<div class="empty-state">No providers configured. Add one below.</div>';
      return;
    }

    const activeName = config.activeProvider;
    list.innerHTML = config.providers.map(p => {
      const isActive = p.name === activeName;
      return '<div class="card ' + (isActive ? 'active' : '') + '">' +
        '<div class="card-header">' +
          '<span class="card-title">' + esc(p.name) + '</span>' +
          '<div class="card-actions">' +
            (isActive
              ? '<span class="badge badge-active">Active</span>'
              : '<button class="btn btn-secondary btn-sm" onclick="setActiveProvider(\\'' + escAttr(p.name) + '\\')">Set Active</button>') +
            '<button class="btn btn-secondary btn-icon btn-sm" onclick="editProvider(\\'' + escAttr(p.name) + '\\')" title="Edit">&#9998;</button>' +
            '<button class="btn btn-danger btn-icon btn-sm" onclick="deleteProvider(\\'' + escAttr(p.name) + '\\')" title="Delete">&#10005;</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-details">' +
          '<div>Model: ' + esc(p.model) + '</div>' +
          '<div>API Type: ' + esc(p.apiType) + '</div>' +
          '<div>Base URL: ' + esc(p.baseUrl) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderFeatures() {
    const f = config.features;
    const items = [
      { key: 'enabled', label: 'Enabled', desc: 'Master switch — disables all functionality when off', master: true },
      { key: 'enableInlineSuggestions', label: 'Inline Suggestions', desc: 'Show ghost-text suggestions in the editor' },
      { key: 'enablePrediction', label: 'Prediction', desc: 'Show prediction decorations for next edit location' },
      { key: 'enableDiagnosticsHints', label: 'Diagnostics Hints', desc: 'Include linter errors as context' },
      { key: 'enableAdditionalFilesContext', label: 'Additional Files Context', desc: 'Include recently-viewed files as context' },
      { key: 'triggerInComments', label: 'Trigger in Comments', desc: 'Allow suggestions inside comments' },
    ];

    const container = $('#featuresList');
    let html = items.map(item => {
      const cls = item.master ? 'toggle-group toggle-master' : 'toggle-group';
      return '<div class="' + cls + '">' +
        '<div><div class="toggle-label">' + item.label + '</div>' +
        '<div class="toggle-description">' + item.desc + '</div></div>' +
        '<label class="switch">' +
          '<input type="checkbox" ' + (f[item.key] ? 'checked' : '') + ' onchange="updateFeature(\\'' + item.key + '\\', this.checked)">' +
          '<span class="slider"></span>' +
        '</label>' +
      '</div>';
    }).join('');

    html += '<div class="form-group" style="margin-top:12px">' +
      '<label>Excluded Languages (comma-separated)</label>' +
      '<input type="text" value="' + escAttr((f.excludedLanguages || []).join(', ')) + '" ' +
      'onchange="updateExcludedLanguages(this.value)" ' +
      'placeholder="e.g. markdown, plaintext">' +
    '</div>';

    container.innerHTML = html;
  }

  function renderDebug() {
    const d = config.debug;
    const items = [
      { key: 'enabled', label: 'Debug Logging', desc: 'Enable debug logging' },
      { key: 'logStream', label: 'Log SSE Stream', desc: 'Log SSE stream chunks' },
      { key: 'logPayloads', label: 'Log Payloads', desc: 'Log full request/response payloads' },
    ];

    const container = $('#debugList');
    container.innerHTML = items.map(item => {
      return '<div class="toggle-group">' +
        '<div><div class="toggle-label">' + item.label + '</div>' +
        '<div class="toggle-description">' + item.desc + '</div></div>' +
        '<label class="switch">' +
          '<input type="checkbox" ' + (d[item.key] ? 'checked' : '') + ' onchange="updateDebug(\\'' + item.key + '\\', this.checked)">' +
          '<span class="slider"></span>' +
        '</label>' +
      '</div>';
    }).join('');
  }

  function renderEditForm(provider) {
    const container = $('#editFormContainer');
    const isNew = !provider;
    const p = provider || {
      name: '', baseUrl: '', apiKey: '', apiType: 'completions',
      model: '', temperature: 0.2, maxTokens: 4096, contextLength: 8192,
      stopTokens: [], fimTemplate: '', customPrompt: '', fimContextMode: 'augmented'
    };
    const title = isNew ? 'Add Provider' : 'Edit Provider: ' + esc(p.name);

    container.innerHTML = '<div class="edit-overlay">' +
      '<h3>' + title + '</h3>' +
      '<div class="form-row">' +
        (isNew ? '<div class="form-group"><label>Name</label><input type="text" id="edit-name" value="' + escAttr(p.name) + '" placeholder="e.g. deepseek"></div>' : '') +
        '<div class="form-group"><label>Base URL</label><input type="text" id="edit-baseUrl" value="' + escAttr(p.baseUrl) + '" placeholder="https://api.example.com/v1"></div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>API Key</label>' +
        '<div class="password-wrapper">' +
          '<input type="password" id="edit-apiKey" value="' + escAttr(p.apiKey) + '">' +
          '<button class="password-toggle" onclick="toggleApiKeyVisibility()">&#128065;</button>' +
        '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>API Type</label>' +
          '<select id="edit-apiType"><option value="completions" ' + (p.apiType === 'completions' ? 'selected' : '') + '>completions</option>' +
          '<option value="chat" ' + (p.apiType === 'chat' ? 'selected' : '') + '>chat</option></select></div>' +
        '<div class="form-group"><label>Model</label><input type="text" id="edit-model" value="' + escAttr(p.model) + '" placeholder="e.g. gpt-4o-mini"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Temperature (0–2, step 0.1)</label><input type="number" id="edit-temperature" value="' + p.temperature + '" step="0.1" min="0" max="2"></div>' +
        '<div class="form-group"><label>Max Tokens</label><input type="number" id="edit-maxTokens" value="' + p.maxTokens + '" min="1"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Context Length</label><input type="number" id="edit-contextLength" value="' + p.contextLength + '" min="1"></div>' +
        '<div class="form-group"><label>Stop Tokens (comma-separated)</label><input type="text" id="edit-stopTokens" value="' + escAttr((p.stopTokens || []).join(',')) + '" placeholder="\\\\n\\\\n,\\\\n"></div>' +
      '</div>' +
      '<div class="form-group"><label>FIM Context Mode</label>' +
        '<select id="edit-fimContextMode">' +
          '<option value="augmented" ' + ((p.fimContextMode || 'augmented') === 'augmented' ? 'selected' : '') + '>augmented</option>' +
          '<option value="strict" ' + (p.fimContextMode === 'strict' ? 'selected' : '') + '>strict</option>' +
        '</select></div>' +
      '<div class="form-group"><label>FIM Template (optional, chat mode only)</label><textarea id="edit-fimTemplate" placeholder="{prefix}, {suffix}, {language}, {filename}">' + esc(p.fimTemplate || '') + '</textarea></div>' +
      '<div class="form-group"><label>Custom System Prompt (optional)</label><textarea id="edit-customPrompt" placeholder="Leave blank for default system prompt.">' + esc(p.customPrompt || '') + '</textarea></div>' +
      '<div class="form-group"><label>Extra Headers (JSON, optional)</label><textarea id="edit-headers" placeholder="e.g. {&quot;X-Custom-Header&quot;: &quot;value&quot;}">' + esc(p.headers ? JSON.stringify(p.headers) : '') + '</textarea></div>' +
      '<div class="form-group"><label>Extra Body Params (JSON, optional)</label><textarea id="edit-extraBody" placeholder="e.g. {&quot;chat_template_kwargs&quot;: {&quot;enable_thinking&quot;: false}}">' + esc(p.extraBody ? JSON.stringify(p.extraBody) : '') + '</textarea></div>' +
      '<div class="form-actions">' +
        '<button class="btn" onclick="saveProvider(\\'' + (isNew ? '' : escAttr(p.name)) + '\\')">Save</button>' +
        '<button class="btn btn-secondary" onclick="cancelEdit()">Cancel</button>' +
      '</div>' +
    '</div>';
  }

  // ── Event handlers ──

  window.setActiveProvider = function(name) {
    post({ type: 'setActiveProvider', name: name });
  };

  window.editProvider = function(name) {
    const provider = config.providers.find(p => p.name === name);
    if (provider) {
      editingProviderName = name;
      renderEditForm(provider);
    }
  };

  window.deleteProvider = function(name) {
    if (!confirm('Delete provider "' + name + '"? This cannot be undone.')) return;
    post({ type: 'deleteProvider', name: name });
  };

  window.updateFeature = function(key, value) {
    const features = { ...config.features, [key]: value };
    post({ type: 'updateFeatures', features: features });
  };

  window.updateExcludedLanguages = function(value) {
    const langs = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const features = { ...config.features, excludedLanguages: langs };
    post({ type: 'updateFeatures', features: features });
  };

  window.updateDebug = function(key, value) {
    const debug = { ...config.debug, [key]: value };
    post({ type: 'updateDebug', debug: debug });
  };

  window.toggleApiKeyVisibility = function() {
    const input = document.getElementById('edit-apiKey');
    if (input.type === 'password') { input.type = 'text'; }
    else { input.type = 'password'; }
  };

  window.saveProvider = function(originalName) {
    const name = document.getElementById('edit-name')?.value?.trim() || originalName;
    const baseUrl = document.getElementById('edit-baseUrl').value.trim();
    const apiKey = document.getElementById('edit-apiKey').value.trim();
    const apiType = document.getElementById('edit-apiType').value;
    const model = document.getElementById('edit-model').value.trim();
    const temperature = parseFloat(document.getElementById('edit-temperature').value) || 0.2;
    const maxTokens = parseInt(document.getElementById('edit-maxTokens').value, 10) || 4096;
    const contextLength = parseInt(document.getElementById('edit-contextLength').value, 10) || 8192;
    const stopTokens = document.getElementById('edit-stopTokens').value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const fimContextMode = document.getElementById('edit-fimContextMode').value === 'strict' ? 'strict' : 'augmented';
    const fimTemplate = document.getElementById('edit-fimTemplate').value || null;
    const customPrompt = document.getElementById('edit-customPrompt').value || null;

    let headers = undefined;
    try {
      const headersRaw = document.getElementById('edit-headers')?.value?.trim();
      if (headersRaw) { headers = JSON.parse(headersRaw); }
    } catch (e) { showStatus('Invalid Headers JSON: ' + e.message, 'error'); return; }

    let extraBody = undefined;
    try {
      const extraBodyRaw = document.getElementById('edit-extraBody')?.value?.trim();
      if (extraBodyRaw) { extraBody = JSON.parse(extraBodyRaw); }
    } catch (e) { showStatus('Invalid Extra Body JSON: ' + e.message, 'error'); return; }

    if (!name || !baseUrl || !apiKey || !model) {
      showStatus('Please fill in Name, Base URL, API Key, and Model.', 'error');
      return;
    }

    const provider = {
      name, baseUrl, apiKey, apiType, model, temperature,
      maxTokens, contextLength, stopTokens, fimContextMode, fimTemplate, customPrompt,
      ...(headers ? { headers } : {}),
      ...(extraBody ? { extraBody } : {}),
    };

    if (originalName) {
      post({ type: 'updateProvider', name: originalName, provider: provider });
    } else {
      post({ type: 'addProvider', provider: provider });
    }
    cancelEdit();
  };

  window.cancelEdit = function() {
    editingProviderName = null;
    $('#editFormContainer').innerHTML = '';
  };

  var _addProviderOpen = false;
  $('#addProviderBtn').addEventListener('click', function() {
    if ($('#editFormContainer').innerHTML.trim() !== '') {
      cancelEdit();
    }
    renderEditForm(null);
  });

  $('#testConnBtn').addEventListener('click', function() {
    $('#testResult').innerHTML = '';
    post({ type: 'testConnection' });
  });

  $('#openConfigLink').addEventListener('click', function(e) {
    e.preventDefault();
    post({ type: 'openConfigFile' });
  });

  function renderTestResult(result) {
    const el = $('#testResult');
    if (!result) { el.innerHTML = ''; return; }
    const cls = result.success ? 'status-success' : 'status-error';
    const latency = result.latencyMs != null ? ' (' + result.latencyMs + 'ms)' : '';
    el.innerHTML = '<div class="' + cls + '">' + (result.success ? '✓' : '✗') + ' ' + esc(result.message) + latency + '</div>';
  }

  function showStatus(message, type) {
    const container = $('#statusContainer');
    const cls = type === 'error' ? 'status-error' : type === 'success' ? 'status-success' : 'status-info';
    container.innerHTML = '<div class="' + cls + '">' + esc(message) + '</div>';
    setTimeout(() => { container.innerHTML = ''; }, 5000);
  }

  // Utility: escape HTML
  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(str) {
    return esc(str).replace(/'/g, '&#39;');
  }

  // Handle openConfigFile message back
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'openConfigFile') {
      // Already handled in handleMessage; this is just informational
    }
  });
})();
</script>
</body>
</html>`;
}
