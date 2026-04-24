import * as vscode from 'vscode';
import { SnoozeService } from '../services/snoozeService';
import { TelemetryService, SessionStatistics } from '../services/telemetryService';
import { ConfigManager } from '../services/configManager';
import { ProviderConfig } from '../context/types';

export enum StatusBarState {
  Idle = 'idle',
  Working = 'working',
  Error = 'error',
  Disabled = 'disabled',
  Snoozing = 'snoozing'
}

export enum StatusIcon {
  Logo = '$(sparkle)',
  Working = '$(loading~spin)',
  Warning = '$(warning)',
  Error = '$(error)',
  Disabled = '$(circle-slash)',
  Snoozing = '$(bell-slash)',
}

export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private currentState: StatusBarState = StatusBarState.Idle;
  private snoozeService: SnoozeService;
  private configManager: ConfigManager;
  private telemetryService: TelemetryService | undefined;
  private lastStats: SessionStatistics | undefined;
  private lastProvider: ProviderConfig | undefined;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.snoozeService = SnoozeService.getInstance();
    this.lastProvider = configManager.activeProvider;

    this.statusBarItem = vscode.window.createStatusBarItem(
      'suki-tab.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'SukiTab';
    this.statusBarItem.command = 'suki-tab.showStatusMenu';

    this.registerListeners();
    this.updateStatusIndicator();
    this.statusBarItem.show();
  }

  setTelemetryService(telemetryService: TelemetryService): void {
    this.telemetryService = telemetryService;
    this.lastStats = telemetryService.getStatistics();
    
    this.disposables.push(
      telemetryService.onStatsChanged((stats) => {
        this.lastStats = stats;
        this.updateStatusIndicator();
      })
    );
    
    this.updateStatusIndicator();
  }

  setConfigManager(configManager: ConfigManager): void {
    this.configManager = configManager;
    this.lastProvider = configManager.activeProvider;
    
    this.updateStatusIndicator();
  }

  private registerListeners(): void {
    this.disposables.push(
      this.snoozeService.onSnoozeChanged(() => {
        this.updateStatusIndicator();
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sukiTab')) {
          this.updateStatusIndicator();
        }
      })
    );

    this.disposables.push(
      this.configManager.onDidChange(() => {
        this.lastProvider = this.configManager.activeProvider;
        this.updateStatusIndicator();
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatusIndicator();
      })
    );
  }

  setState(state: StatusBarState): void {
    this.currentState = state;
    this.updateStatusIndicator();
  }

  private updateStatusIndicator(): void {
    const vscodeConfig = vscode.workspace.getConfiguration('sukiTab');
    const enabled = vscodeConfig.get<boolean>('enabled', true);

    void vscode.commands.executeCommand('setContext', 'suki-tab.enabled', enabled);

    const model = this.configManager.activeProvider.model;
    const modelLabel = this.getModelLabel(model);

    if (!enabled) {
      this.statusBarItem.text = `${StatusIcon.Disabled} Suki`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.command = 'suki-tab.toggleEnabled';
    } else if (this.snoozeService.isSnoozing()) {
      const remaining = this.snoozeService.getRemainingMinutes();
      this.statusBarItem.text = `${StatusIcon.Snoozing} Suki (${remaining}m)`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.command = 'suki-tab.cancelSnooze';
    } else {
      switch (this.currentState) {
        case StatusBarState.Working:
          this.statusBarItem.text = `${StatusIcon.Working} Suki [${modelLabel}]`;
          this.statusBarItem.backgroundColor = undefined;
          break;

        case StatusBarState.Error:
          this.statusBarItem.text = `${StatusIcon.Error} Suki [${modelLabel}]`;
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
          this.statusBarItem.command = 'suki-tab.showLogs';
          break;

        case StatusBarState.Idle:
        default:
          this.statusBarItem.text = `${StatusIcon.Logo} Suki [${modelLabel}]`;
          this.statusBarItem.backgroundColor = undefined;
          this.statusBarItem.command = 'suki-tab.showStatusMenu';
          break;
      }
    }

    this.statusBarItem.tooltip = this.buildRichTooltip(enabled);
  }

  private buildRichTooltip(enabled: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    const statusIcon = this.getStatusIcon(enabled);
    const statusText = this.getStatusText(enabled);
    md.appendMarkdown(`### ${statusIcon} SukiTab\n\n`);
    md.appendMarkdown(`**Status:** ${statusText}\n\n`);

    if (this.lastStats) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`#### $(dashboard) Session Statistics\n\n`);
      
      const sessionDuration = this.formatDuration(Date.now() - this.lastStats.sessionStartTime);
      md.appendMarkdown(`$(clock) **Session Duration:** ${sessionDuration}\n\n`);
      
      md.appendMarkdown(`$(code) **Completions Shown:** ${this.lastStats.suggestionCount} total\n\n`);
      
      const acceptRate = this.lastStats.suggestionCount > 0
        ? Math.round(this.lastStats.acceptRate * 100)
        : 0;
      md.appendMarkdown(`$(check) **Accepted:** ${this.lastStats.acceptCount} (${acceptRate}% rate)\n\n`);
      
      md.appendMarkdown(`$(x) **Rejected:** ${this.lastStats.rejectCount}\n\n`);
      
      if (this.lastStats.partialAcceptCount > 0) {
        md.appendMarkdown(`$(checklist) **Partial Accepts:** ${this.lastStats.partialAcceptCount}\n\n`);
      }
      
      if (this.lastStats.totalCharsAccepted > 0) {
        md.appendMarkdown(`$(text-size) **Characters Accepted:** ${this.lastStats.totalCharsAccepted.toLocaleString()}\n\n`);
      }

      if (this.lastStats.avgGenerationTimeMs > 0) {
        md.appendMarkdown(`$(watch) **Avg Generation Time:** ${this.lastStats.avgGenerationTimeMs}ms\n\n`);
      }

      const triggersBySource = this.lastStats.triggersBySource;
      if (Object.keys(triggersBySource).length > 0) {
        md.appendMarkdown(`---\n\n`);
        md.appendMarkdown(`#### $(zap) Triggers by Source\n\n`);
        
        const sorted = Object.entries(triggersBySource)
          .sort(([, a], [, b]) => b - a);
        
        for (const [source, count] of sorted) {
          const icon = this.getTriggerSourceIcon(source);
          const label = this.formatTriggerSourceName(source);
          md.appendMarkdown(`${icon} **${label}:** ${count}\n\n`);
        }
      }
    }

    const provider = this.configManager.activeProvider;
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`#### $(beaker) Provider\n\n`);
    md.appendMarkdown(`$(symbol-method) **Provider:** ${provider.name}\n\n`);
    md.appendMarkdown(`$(hubot) **Model:** ${provider.model}\n\n`);
    md.appendMarkdown(`[$(pencil) Change Provider](command:suki-tab.selectProvider)\n\n`);

    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`#### $(globe) Connection\n\n`);
    
    md.appendMarkdown(`$(link) **Base URL:** ${provider.baseUrl}\n\n`);
    md.appendMarkdown(`$(symbol-class) **API Type:** ${provider.apiType}\n\n`);
    md.appendMarkdown(`$(remote) **Model:** ${provider.model}\n\n`);

    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`#### $(zap) Quick Actions\n\n`);
    
    if (enabled) {
      md.appendMarkdown(`[$(circle-slash) Disable Completions](command:suki-tab.toggleEnabled)\n\n`);
      if (!this.snoozeService.isSnoozing()) {
        md.appendMarkdown(`[$(bell-slash) Snooze Completions](command:suki-tab.showSnoozePicker)\n\n`);
      } else {
        md.appendMarkdown(`[$(bell) Cancel Snooze](command:suki-tab.cancelSnooze)\n\n`);
      }
    } else {
      md.appendMarkdown(`[$(circle-filled) Enable Completions](command:suki-tab.toggleEnabled)\n\n`);
    }
    
    md.appendMarkdown(`[$(refresh) Reset Statistics](command:suki-tab.resetStatistics)\n\n`);
    md.appendMarkdown(`[$(output) Show Logs](command:suki-tab.showLogs)\n\n`);
    md.appendMarkdown(`[$(settings-gear) Open Settings](command:suki-tab.openSettings)\n\n`);

    return md;
  }

  private getModelLabel(model: string): string {
    return model;
  }

  private getTriggerSourceIcon(source: string): string {
    const icons: Record<string, string> = {
      'unknown': '$(question)',
      'line_change': '$(edit)',
      'typing': '$(keyboard)',
      'option_hold': '$(key)',
      'lint_errors': '$(error)',
      'parameter_hints': '$(symbol-parameter)',
      'cursor_prediction': '$(arrow-right)',
      'manual': '$(play)',
      'editor_change': '$(window)',
      'lsp_suggestions': '$(symbol-method)',
    };
    return icons[source] || '$(circle-outline)';
  }

  private formatTriggerSourceName(source: string): string {
    const labels: Record<string, string> = {
      'unknown': 'Unknown',
      'line_change': 'Line Change',
      'typing': 'Typing',
      'option_hold': 'Option Hold',
      'lint_errors': 'Linter Errors',
      'parameter_hints': 'Parameter Hints',
      'cursor_prediction': 'Cursor Prediction',
      'manual': 'Manual Trigger',
      'editor_change': 'Editor Change',
      'lsp_suggestions': 'LSP Suggestions',
    };
    return labels[source] || source
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  private getStatusIcon(enabled: boolean): string {
    if (!enabled) {return '$(circle-slash)';}
    if (this.snoozeService.isSnoozing()) {return '$(bell-slash)';}
    switch (this.currentState) {
      case StatusBarState.Working: return '$(loading~spin)';
      case StatusBarState.Error: return '$(error)';
      default: return '$(sparkle)';
    }
  }

  private getStatusText(enabled: boolean): string {
    if (!enabled) {return 'Disabled';}
    if (this.snoozeService.isSnoozing()) {
      return `Snoozed (${this.snoozeService.getRemainingMinutes()}m remaining)`;
    }
    switch (this.currentState) {
      case StatusBarState.Working: return 'Generating...';
      case StatusBarState.Error: return 'Error occurred';
      default: return 'Ready';
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  getStatistics(): SessionStatistics | undefined {
    return this.lastStats;
  }

  getActiveProvider(): ProviderConfig | undefined {
    return this.configManager.activeProvider;
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
