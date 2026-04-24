import * as vscode from 'vscode';
import { IConfigManager } from '../context/contracts';
import { ProviderConfig } from '../context/types';

export function registerProviderCommands(
  context: vscode.ExtensionContext,
  configManager: IConfigManager,
  refreshClient: () => void,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand('suki-tab.selectProvider', async () => {
      const providers = configManager.getProviders();
      const currentName = configManager.activeProvider.name;

      const items: vscode.QuickPickItem[] = providers.map((p) => ({
        label: p.name,
        description: `${p.apiType} | ${p.model}`,
        detail: p.name === currentName ? '$(check) Currently active' : undefined,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select AI Provider',
        placeHolder: 'Choose which provider to use for completions',
      });

      if (selected) {
        await configManager.setActiveProvider(selected.label);
        refreshClient();
        vscode.window.showInformationMessage(`Switched to provider: ${selected.label}`);
      }
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('suki-tab.showProviderInfo', async () => {
      const provider = configManager.activeProvider;
      const validation = configManager.validateProvider(provider);

      const lines = [
        `**Provider:** ${provider.name}`,
        `**Base URL:** ${provider.baseUrl}`,
        `**API Type:** ${provider.apiType}`,
        `**Model:** ${provider.model}`,
        `**Temperature:** ${provider.temperature}`,
        `**Max Tokens:** ${provider.maxTokens}`,
        `**Context Length:** ${provider.contextLength}`,
        `**API Key:** ${provider.apiKey ? '••••' + provider.apiKey.slice(-4) : '(not set)'}`,
        `**Valid:** ${validation.valid ? '✅' : '❌ ' + validation.issues.join(', ')}`,
      ];

      const action = await vscode.window.showInformationMessage(
        'SukiTab — Provider Info',
        { modal: false, detail: lines.join('\n') },
        'Change Provider',
        'Open Config File',
        'Test Connection',
      );

      if (action === 'Change Provider') {
        await vscode.commands.executeCommand('suki-tab.selectProvider');
      } else if (action === 'Open Config File') {
        await vscode.commands.executeCommand('suki-tab.openConfigFile');
      } else if (action === 'Test Connection') {
        await vscode.commands.executeCommand('suki-tab.testConnection');
      }
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('suki-tab.testConnection', async () => {
      const provider = configManager.activeProvider;
      const validation = configManager.validateProvider(provider);

      if (!validation.valid) {
        vscode.window.showWarningMessage(`Provider config invalid: ${validation.issues.join(', ')}`);
        return;
      }

      vscode.window.showInformationMessage(`Testing connection to ${provider.name}...`);
      // The actual test will be done via the LLM client, triggered by refreshClient
      // For now we just validate — the actual connection test needs the client
      refreshClient();
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('suki-tab.openConfigFile', async () => {
      const absolutePath = configManager.getConfigFilePath();

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
        await vscode.window.showTextDocument(doc);
      } catch {
        vscode.window.showWarningMessage(`Config file not found at ${absolutePath}. Creating default...`);
        await configManager.createDefaultConfigFile();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
        await vscode.window.showTextDocument(doc);
      }
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('suki-tab.createDefaultConfig', async () => {
      await configManager.createDefaultConfigFile();
      vscode.window.showInformationMessage('Default config file created.');
    }),
  );

  return disposables;
}
