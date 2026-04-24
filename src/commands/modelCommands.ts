import * as vscode from 'vscode';
import { IConfigManager } from '../context/contracts';

export function registerModelCommands(
  context: vscode.ExtensionContext,
  configManager: IConfigManager,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand('suki-tab.selectModel', async () => {
      const providers = configManager.getProviders();
      const items: vscode.QuickPickItem[] = providers.map((p) => ({
        label: `$(server) ${p.name}`,
        description: `${p.model} (${p.apiType})`,
        detail: p.name === configManager.activeProvider.name ? '$(check) Currently active' : undefined,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select Model / Provider',
        placeHolder: 'Choose provider and model for completions',
      });

      if (selected) {
        const providerName = selected.label.replace('$(server) ', '');
        await configManager.setActiveProvider(providerName);
        vscode.window.showInformationMessage(`Switched to ${providerName}`);
      }
    }),
  );

  return disposables;
}
