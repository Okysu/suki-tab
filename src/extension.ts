import * as vscode from 'vscode';
import { ServiceContainer } from './container/serviceContainer';
import { Logger } from './services/logger';
import { DocumentTracker } from './services/documentTracker';
import { CompletionStateMachine } from './services/completionStateMachine';
import { ConfigManager } from './services/configManager';
import { OpenAIClient } from './api/openAIClient';
import { PredictionController } from './controllers/predictionController';
import { registerInlineCompletionProvider } from './providers/inlineCompletionProvider';
import { registerInlineAcceptCommand } from './commands/inlineAcceptCommand';
import { registerProviderCommands } from './commands/providerCommands';
import { registerModelCommands } from './commands/modelCommands';
import { DebounceManager } from './services/debounceManager';
import { RecentFilesTracker } from './services/recentFilesTracker';
import { TelemetryService } from './services/telemetryService';
import { LspSuggestionsTracker } from './services/lspSuggestionsTracker';
import { DiagnosticsTracker } from './services/diagnosticsTracker';
import { TriggerSource } from './context/types';
import { SnoozeService } from './services/snoozeService';
import { ensureProposedApiEnabled, resetIgnoreProposalCheck, checkAndPromptProposedApiOnStartup } from './services/productJsonPatcher';
import { StatusBar, StatusBarState } from './ui/statusBar';
import { SettingsPanel } from './ui/settingsPanel';
import { StatusBarPicker } from './ui/statusBarPicker';
import { IRelatedEditsService } from './context/contracts';
import { RelatedEditsService } from './services/relatedEditsService';

export async function activate(context: vscode.ExtensionContext) {
	const extensionId = 'Okysu.suki-tab';
	const requiredProposals = ['inlineCompletionsAdditions'];

	const canActivate = await ensureProposedApiEnabled(context, extensionId, requiredProposals);
	if (!canActivate) {return;}

	const container = new ServiceContainer(context);

	container.registerSingleton('logger', () => new Logger());
	container.registerSingleton('tracker', () => new DocumentTracker());
	container.registerSingleton('configManager', () => new ConfigManager(context));
	container.registerSingleton('debounceManager', (c) => new DebounceManager(c.resolve('logger')));
	container.registerSingleton('recentFilesTracker', (c) => new RecentFilesTracker(c.resolve('logger')));
	container.registerSingleton('telemetryService', (c) => new TelemetryService(c.resolve('logger')));
	container.registerSingleton('lspSuggestionsTracker', (c) => new LspSuggestionsTracker(c.resolve('logger')));
	container.registerSingleton('diagnosticsTracker', (c) => new DiagnosticsTracker(c.resolve('logger')));
	container.registerSingleton('relatedEditsService', (c) => new RelatedEditsService(c.resolve('logger')));

	const logger = container.resolve<Logger>('logger');
	const configManager = container.resolve<ConfigManager>('configManager');

	let llmClient = new OpenAIClient(configManager.activeProvider);

	container.registerSingleton('predictionController', (c) =>
		new PredictionController(c.resolve('logger'))
	);

	const predictionController = container.resolve<PredictionController>('predictionController');

	container.registerSingleton('stateMachine', (c) =>
		new CompletionStateMachine(
			c.resolve('tracker'),
			llmClient,
			c.resolve('logger'),
			configManager,
			predictionController,
			c.resolve('debounceManager'),
			c.resolve('recentFilesTracker'),
			c.resolve('telemetryService'),
			c.resolve('lspSuggestionsTracker'),
			c.resolve('relatedEditsService'),
		)
	);

	const stateMachine = container.resolve<CompletionStateMachine>('stateMachine');
	const diagnosticsTracker = container.resolve<DiagnosticsTracker>('diagnosticsTracker');
	const lspSuggestionsTracker = container.resolve<LspSuggestionsTracker>('lspSuggestionsTracker');
	const relatedEditsService = container.resolve<IRelatedEditsService>('relatedEditsService');
	const inlineEditTriggerer = stateMachine.getInlineEditTriggerer();

	diagnosticsTracker.onNewErrors(({ document, position }) => {
		inlineEditTriggerer.manualTrigger(document, position, TriggerSource.LinterErrors);
	});

	lspSuggestionsTracker.onParameterHintsChange(({ document, position }) => {
		inlineEditTriggerer.manualTrigger(document, position, TriggerSource.ParameterHints);
	});

	lspSuggestionsTracker.onCompletionsAvailable(({ document, position }) => {
		inlineEditTriggerer.manualTrigger(document, position, TriggerSource.LspSuggestions);
	});

	registerInlineCompletionProvider(stateMachine, logger, context.subscriptions);
	registerInlineAcceptCommand(stateMachine, logger, context.subscriptions);

	const refreshClient = () => {
		llmClient.dispose();
		llmClient = new OpenAIClient(configManager.activeProvider);
	};

	const providerCommandDisposables = registerProviderCommands(context, configManager, refreshClient);
	context.subscriptions.push(...providerCommandDisposables);

	const modelCommandDisposables = registerModelCommands(context, configManager);
	context.subscriptions.push(...modelCommandDisposables);

	configManager.onDidChange(() => {
		llmClient.updateProvider(configManager.activeProvider);
	});

	const snoozeService = SnoozeService.getInstance();
	const telemetryService = container.resolve<TelemetryService>('telemetryService');
	const statusBar = new StatusBar(configManager);
	statusBar.setTelemetryService(telemetryService);
	stateMachine.onRequestStarted(() => statusBar.setState(StatusBarState.Working));
	stateMachine.onRequestFinished((success) => statusBar.setState(success ? StatusBarState.Idle : StatusBarState.Idle));

	context.subscriptions.push(snoozeService);
	context.subscriptions.push(statusBar);

	const statusBarPicker = new StatusBarPicker();
	statusBarPicker.setConfigManager(configManager);
	statusBarPicker.setTelemetryService(telemetryService);
	context.subscriptions.push(statusBarPicker);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.showStatusMenu', () => {
			statusBarPicker.show();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.toggleEnabled', async () => {
			const cfg = vscode.workspace.getConfiguration('sukiTab');
			const current = cfg.get<boolean>('enabled', true);
			await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
			vscode.window.setStatusBarMessage(!current ? 'SukiTab: Enabled' : 'SukiTab: Disabled', 2000);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.showLogs', () => {
			logger.show();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.manualTriggerCompletion', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor && !snoozeService.isSnoozing()) {
				inlineEditTriggerer.manualTrigger(editor.document, editor.selection.active, TriggerSource.ManualTrigger);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.reviewRelatedEdits', () => {
			return relatedEditsService.reviewRelatedEdits(vscode.window.activeTextEditor);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.showSnoozePicker', () => {
			const items: vscode.QuickPickItem[] = [
				{ label: 'Snooze 15 min', description: '15' },
				{ label: 'Snooze 30 min', description: '30' },
				{ label: 'Snooze 1 hour', description: '60' },
				{ label: 'Cancel Snooze', description: '0' },
			];
			vscode.window.showQuickPick(items, { title: 'Snooze SukiTab' }).then((item) => {
				if (!item) {return;}
				const mins = parseInt(item.description ?? '0', 10);
				if (mins > 0) {
					snoozeService.snooze(mins);
				} else {
					snoozeService.cancelSnooze();
				}
			});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.cancelSnooze', () => {
			snoozeService.cancelSnooze();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.enableProposedApi', async () => {
			await resetIgnoreProposalCheck(context);
			await checkAndPromptProposedApiOnStartup(context, extensionId, requiredProposals, logger);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.resetStatistics', () => {
			telemetryService.resetStatistics();
			vscode.window.showInformationMessage('SukiTab: Statistics reset');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('suki-tab.openSettings', () => {
			SettingsPanel.createOrShow(context.extensionUri, configManager, () => llmClient.testConnection());
		}),
	);

	logger.info('SukiTab BYOK extension activated');
}

export function deactivate() {}
