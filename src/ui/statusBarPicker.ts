import * as vscode from 'vscode';
import { TelemetryService, SessionStatistics } from '../services/telemetryService';
import { ConfigManager } from '../services/configManager';
import { SnoozeService } from '../services/snoozeService';
import { TriggerSource, ProviderConfig } from '../context/types';

interface StatusPickerItem extends vscode.QuickPickItem {
  action?: string;
  args?: any[];
}

const CMD_TOGGLE_ENABLED = 'suki-tab.toggleEnabled';
const CMD_SHOW_LOGS = 'suki-tab.showLogs';
const CMD_OPEN_SETTINGS = 'suki-tab.openSettings';
const CMD_SELECT_PROVIDER = 'suki-tab.selectProvider';
const CMD_TEST_CONNECTION = 'suki-tab.testConnection';
const CMD_OPEN_CONFIG_FILE = 'suki-tab.openConfigFile';
const CMD_SELECT_MODEL = 'suki-tab.selectModel';
const CMD_SNOOZE = 'suki-tab.showSnoozePicker';
const CMD_CANCEL_SNOOZE = 'suki-tab.cancelSnooze';
const CMD_RESET_STATS = 'suki-tab.resetStatistics';

export class StatusBarPicker implements vscode.Disposable {
  private telemetryService: TelemetryService | undefined;
  private configManager: ConfigManager | undefined;
  private snoozeService: SnoozeService;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.snoozeService = SnoozeService.getInstance();
  }

  setTelemetryService(telemetryService: TelemetryService): void {
    this.telemetryService = telemetryService;
  }

  setConfigManager(configManager: ConfigManager): void {
    this.configManager = configManager;
  }

  async show(): Promise<void> {
    const items = this.buildMenuItems();

    const quickPick = vscode.window.createQuickPick<StatusPickerItem>();
    quickPick.items = items;
    quickPick.title = 'SukiTab Status';
    quickPick.placeholder = 'Select an action or view statistics...';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected?.action) {
        quickPick.hide();
        await this.executeAction(selected.action, selected.args);
      }
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  private buildMenuItems(): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];
    const config = vscode.workspace.getConfiguration('sukiTab');
    const enabled = config.get<boolean>('enabled', true);

    items.push(this.newStatusItem(enabled));

    items.push({
      label: 'Session Statistics',
      kind: vscode.QuickPickItemKind.Separator
    });

    const stats = this.telemetryService?.getStatistics();
    if (stats) {
      items.push(...this.buildStatisticsItems(stats));
    } else {
      items.push({
        label: '$(info) No statistics available',
        description: 'Start using completions to see stats'
      });
    }

    if (stats && Object.keys(stats.triggersBySource).length > 0) {
      items.push({
        label: 'Triggers by Source',
        kind: vscode.QuickPickItemKind.Separator
      });
      items.push(...this.buildTriggerSourceItems(stats.triggersBySource));
    }

    items.push({
      label: 'Model',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...this.buildModelItems());

    items.push({
      label: 'Connection',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...this.buildProviderItems());

    items.push({
      label: 'Actions',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...this.buildActionItems(enabled));

    return items;
  }

  private newStatusItem(enabled: boolean): StatusPickerItem {
    let statusText: string;
    let statusIcon: string;

    if (!enabled) {
      statusText = 'Disabled';
      statusIcon = '$(circle-slash)';
    } else if (this.snoozeService.isSnoozing()) {
      const remaining = this.snoozeService.getRemainingMinutes();
      statusText = `Snoozed (${remaining}m remaining)`;
      statusIcon = '$(bell-slash)';
    } else {
      statusText = 'Ready';
      statusIcon = '$(sparkle)';
    }

    return {
      label: `${statusIcon} Status: ${statusText}`,
      description: enabled ? 'Click to toggle' : 'Click to enable',
      action: CMD_TOGGLE_ENABLED
    };
  }

  private buildStatisticsItems(stats: SessionStatistics): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    const sessionDuration = this.formatDuration(Date.now() - stats.sessionStartTime);
    items.push({
      label: '$(clock) Session Duration',
      description: sessionDuration
    });

    items.push({
      label: '$(code) Completions Shown',
      description: `${stats.suggestionCount} total`
    });

    const acceptRate = stats.suggestionCount > 0
      ? Math.round(stats.acceptRate * 100)
      : 0;
    items.push({
      label: '$(check) Accepted',
      description: `${stats.acceptCount} (${acceptRate}% rate)`
    });

    items.push({
      label: '$(x) Rejected',
      description: `${stats.rejectCount}`
    });

    if (stats.partialAcceptCount > 0) {
      items.push({
        label: '$(checklist) Partial Accepts',
        description: `${stats.partialAcceptCount}`
      });
    }

    if (stats.totalCharsAccepted > 0) {
      items.push({
        label: '$(text-size) Characters Accepted',
        description: this.formatNumber(stats.totalCharsAccepted)
      });
    }

    if (stats.avgGenerationTimeMs > 0) {
      items.push({
        label: '$(dashboard) Avg Generation Time',
        description: `${stats.avgGenerationTimeMs}ms`
      });
    }

    return items;
  }

  private buildTriggerSourceItems(triggersBySource: Record<string, number>): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    const sorted = Object.entries(triggersBySource)
      .sort(([, a], [, b]) => b - a);

    for (const [source, count] of sorted) {
      const icon = this.getSourceIcon(source as TriggerSource);
      const label = this.formatSourceName(source);
      items.push({
        label: `${icon} ${label}`,
        description: `${count} triggers`
      });
    }

    return items;
  }

  private buildModelItems(): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];
    const currentModel = this.configManager?.activeProvider.model ?? 'not configured';

    items.push({
      label: `$(beaker) Current Model: ${currentModel}`,
      description: 'Click to change model',
      action: CMD_SELECT_MODEL
    });

    return items;
  }

  private buildProviderItems(): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    if (this.configManager) {
      const provider = this.configManager.activeProvider;
      const providers = this.configManager.getProviders();

      items.push({
        label: `$(remote) Provider: ${provider.name}`,
        description: provider.baseUrl
      });

      items.push({
        label: '$(symbol-method) API Type',
        description: provider.apiType
      });

      items.push({
        label: '$(diff-added) Select Provider',
        description: `${providers.length} available`,
        action: CMD_SELECT_PROVIDER
      });

      items.push({
        label: '$(debug-alt) Test Connection',
        description: 'Verify API connectivity',
        action: CMD_TEST_CONNECTION
      });

      items.push({
        label: '$(file-code) Open Config File',
        description: 'Edit BYOK configuration',
        action: CMD_OPEN_CONFIG_FILE
      });
    } else {
      items.push({
        label: '$(warning) Provider not configured',
        description: 'Click to configure',
        action: CMD_SELECT_PROVIDER
      });
    }

    return items;
  }

  private buildActionItems(enabled: boolean): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    items.push({
      label: enabled ? '$(circle-slash) Disable Completions' : '$(circle-filled) Enable Completions',
      description: enabled ? 'Turn off AI completions' : 'Turn on AI completions',
      action: CMD_TOGGLE_ENABLED
    });

    if (enabled) {
      if (this.snoozeService.isSnoozing()) {
        items.push({
          label: '$(bell) Cancel Snooze',
          description: `${this.snoozeService.getRemainingMinutes()}m remaining`,
          action: CMD_CANCEL_SNOOZE
        });
      } else {
        items.push({
          label: '$(bell-slash) Snooze Completions',
          description: 'Temporarily pause',
          action: CMD_SNOOZE
        });
      }
    }

    items.push({
      label: '$(refresh) Reset Statistics',
      description: 'Clear session stats',
      action: CMD_RESET_STATS
    });

    items.push({
      label: '$(output) Show Logs',
      description: 'View output logs',
      action: CMD_SHOW_LOGS
    });

    items.push({
      label: '$(settings-gear) Open Settings',
      description: 'Configure SukiTab',
      action: CMD_OPEN_SETTINGS,
      args: ['sukiTab']
    });

    return items;
  }

  private async executeAction(action: string, args?: any[]): Promise<void> {
    switch (action) {
      case CMD_RESET_STATS:
        this.telemetryService?.resetStatistics();
        vscode.window.showInformationMessage('SukiTab: Statistics reset');
        break;

      default:
        if (args && args.length > 0) {
          await vscode.commands.executeCommand(action, ...args);
        } else {
          await vscode.commands.executeCommand(action);
        }
        break;
    }
  }

  private getSourceIcon(source: TriggerSource | string): string {
    const icons: Record<string, string> = {
      [TriggerSource.Unknown]: '$(question)',
      [TriggerSource.LineChange]: '$(edit)',
      [TriggerSource.Typing]: '$(keyboard)',
      [TriggerSource.OptionHold]: '$(key)',
      [TriggerSource.LinterErrors]: '$(error)',
      [TriggerSource.ParameterHints]: '$(symbol-parameter)',
      [TriggerSource.Prediction]: '$(arrow-right)',
      [TriggerSource.CursorPrediction]: '$(arrow-right)',
      [TriggerSource.ManualTrigger]: '$(play)',
      [TriggerSource.EditorChange]: '$(window)',
      [TriggerSource.LspSuggestions]: '$(symbol-method)',
    };
    return icons[source] || '$(circle-outline)';
  }

  private formatSourceName(source: string): string {
    return source
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
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

  private formatNumber(num: number): string {
    return num.toLocaleString();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
