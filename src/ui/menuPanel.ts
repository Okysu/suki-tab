import * as vscode from 'vscode';
import { SnoozeService } from '../services/snoozeService';

interface QuickActionItem extends vscode.QuickPickItem {
  action: string;
  args?: any[];
}

interface StatusInfo {
  enabled: boolean;
  isSnoozing: boolean;
  snoozeRemaining: number;
}

export class MenuPanel {
  private snoozeService: SnoozeService;

  constructor() {
    this.snoozeService = SnoozeService.getInstance();
  }

  async show(): Promise<void> {
    const statusInfo = this.getStatusInfo();
    const items = this.buildMenuItems(statusInfo);

    const quickPick = vscode.window.createQuickPick<QuickActionItem>();
    quickPick.items = items;
    quickPick.title = 'SukiTab';
    quickPick.placeholder = 'Select an action...';

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        quickPick.hide();
        await this.executeAction(selected.action, selected.args);
      }
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  private getStatusInfo(): StatusInfo {
    const config = vscode.workspace.getConfiguration('sukiTab');
    const enabled = config.get<boolean>('enabled', true);

    return {
      enabled,
      isSnoozing: this.snoozeService.isSnoozing(),
      snoozeRemaining: this.snoozeService.getRemainingMinutes()
    };
  }

  private buildMenuItems(statusInfo: StatusInfo): QuickActionItem[] {
    const items: QuickActionItem[] = [];

    items.push({
      label: 'Current Status',
      description: this.getStatusDescription(statusInfo),
      action: 'noop',
      kind: vscode.QuickPickItemKind.Separator
    } as any);

    const toggleIcon = statusInfo.enabled ? '$(circle-filled)' : '$(circle-outline)';
    const toggleText = statusInfo.enabled ? 'Disable Completions' : 'Enable Completions';
    items.push({
      label: `${toggleIcon} ${toggleText}`,
      description: statusInfo.enabled ? 'Turn off AI completions' : 'Turn on AI completions',
      action: 'toggleEnabled'
    });

    if (statusInfo.isSnoozing) {
      items.push({
        label: '$(bell) Cancel Snooze',
        description: `${statusInfo.snoozeRemaining} minutes remaining`,
        action: 'cancelSnooze'
      });
    } else if (statusInfo.enabled) {
      items.push({
        label: '$(bell-slash) Snooze Completions',
        description: 'Temporarily pause completions',
        action: 'showSnoozePicker'
      });
    }

    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator
    } as any);

    items.push({
      label: '$(server) Select AI Provider',
      description: 'Choose your AI provider',
      action: 'selectProvider'
    });

    items.push({
      label: '$(beaker) Select Model',
      description: 'Choose AI model',
      action: 'selectModel'
    });

    items.push({
      label: '$(plug) Test Connection',
      description: 'Verify provider connection',
      action: 'testConnection'
    });

    items.push({
      label: '$(file) Open Config File',
      description: 'Edit configuration',
      action: 'openConfigFile'
    });

    items.push({
      label: '$(file-add) Create Default Config',
      description: 'Generate default configuration',
      action: 'createDefaultConfig'
    });

    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator
    } as any);

    items.push({
      label: '$(settings-gear) Open Settings',
      description: 'Configure SukiTab',
      action: 'openSettings'
    });

    items.push({
      label: '$(output) Show Logs',
      description: 'View output logs',
      action: 'showLogs'
    });

    return items;
  }

  private getStatusDescription(statusInfo: StatusInfo): string {
    if (!statusInfo.enabled) {
      return 'Disabled';
    }
    if (statusInfo.isSnoozing) {
      return `Snoozed (${statusInfo.snoozeRemaining}m remaining)`;
    }
    return 'Active';
  }

  private async executeAction(action: string, args?: any[]): Promise<void> {
    switch (action) {
      case 'noop':
        break;

      case 'toggleEnabled':
        await vscode.commands.executeCommand('suki-tab.toggleEnabled');
        break;

      case 'cancelSnooze':
        await vscode.commands.executeCommand('suki-tab.cancelSnooze');
        break;

      case 'showSnoozePicker':
        await vscode.commands.executeCommand('suki-tab.showSnoozePicker');
        break;

      case 'selectProvider':
        await vscode.commands.executeCommand('suki-tab.selectProvider');
        break;

      case 'selectModel':
        await vscode.commands.executeCommand('suki-tab.selectModel');
        break;

      case 'testConnection':
        await vscode.commands.executeCommand('suki-tab.testConnection');
        break;

      case 'openConfigFile':
        await vscode.commands.executeCommand('suki-tab.openConfigFile');
        break;

      case 'createDefaultConfig':
        await vscode.commands.executeCommand('suki-tab.createDefaultConfig');
        break;

      case 'openSettings':
        await vscode.commands.executeCommand('suki-tab.openSettings');
        break;

      case 'showLogs':
        await vscode.commands.executeCommand('suki-tab.showLogs');
        break;

      default:
        console.warn(`Unknown menu action: ${action}`);
    }
  }
}

export async function showSnoozePicker(): Promise<void> {
  const snoozeService = SnoozeService.getInstance();
  
  const options = [
    { label: '$(clock) 5 minutes', minutes: 5 },
    { label: '$(clock) 15 minutes', minutes: 15 },
    { label: '$(clock) 30 minutes', minutes: 30 },
    { label: '$(clock) 1 hour', minutes: 60 },
    { label: '$(clock) 2 hours', minutes: 120 }
  ];

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Snooze AI Completions',
    placeHolder: 'Select duration'
  });

  if (selected) {
    snoozeService.snooze(selected.minutes);
    vscode.window.showInformationMessage(`SukiTab: Snoozed for ${selected.minutes} minutes`);
  }
}
