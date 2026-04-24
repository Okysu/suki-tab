import * as vscode from 'vscode';
import { Logger } from '../services/logger';
import { CompletionStateMachine } from '../services/completionStateMachine';

export function registerInlineAcceptCommand(
  stateMachine: CompletionStateMachine,
  logger: Logger,
  subscriptions: vscode.Disposable[],
): void {
  const command = vscode.commands.registerCommand(
    'suki-tab.inlineAccept',
    async (
      requestId?: string,
      _bindingId?: string,
      acceptedLength?: number
    ) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      try {
        await stateMachine.handleAccept(editor, requestId, _bindingId, acceptedLength);
      } catch (error) {
        logger.error('Failed to handle inline accept', error);
      }
    }
  );
  subscriptions.push(command);
}