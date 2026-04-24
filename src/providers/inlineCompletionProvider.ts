import * as vscode from 'vscode';
import { CompletionStateMachine, SuggestionContext } from '../services/completionStateMachine';
import { ILogger } from '../context/contracts';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly stateMachine: CompletionStateMachine,
    private readonly logger: ILogger,
  ) {
    this.stateMachine.onSuggestionCached(() => {
      this._onDidChange.fire();
    });
  }

  triggerRefresh(): void {
    this._onDidChange.fire();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | null> {
    const suggestionContext: SuggestionContext = {
      document,
      position,
      token,
      requestUuid: context.requestUuid,
      requestIssuedDateTime: (context as any).requestIssuedDateTime,
      earliestShownDateTime: (context as any).earliestShownDateTime,
      userPrompt: (context as any).userPrompt,
      triggerKind: context.triggerKind,
    };

    const suggestion = await this.stateMachine.requestSuggestion(suggestionContext);
    if (!suggestion) {return null;}

    const item = new vscode.InlineCompletionItem(suggestion.text, suggestion.range);

    item.command = {
      title: 'Accept',
      command: 'suki-tab.inlineAccept',
      arguments: [suggestion.text.length],
    };

    item.completeBracketPairs = false;

    const list = new vscode.InlineCompletionList([item]);
    (list as any).enableForwardStability = true;

    return list;
  }

  handleDidShowCompletionItem(_completionItem: vscode.InlineCompletionItem, _updatedInsertText: string): void {}

  handleDidPartiallyAcceptCompletionItem(
    completionItem: vscode.InlineCompletionItem,
    infoOrLength: any,
  ): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {return;}

    const acceptedLength = typeof infoOrLength === 'number'
      ? infoOrLength
      : (infoOrLength?.acceptedLength ?? 0);

    if (acceptedLength > 0) {
      const args = completionItem.command?.arguments ?? [];
      this.stateMachine.handlePartialAccept(editor, undefined, acceptedLength, 'unknown');
    }
  }

  handleEndOfLifetime(_completionItem: vscode.InlineCompletionItem, _reason: any): void {}
}

export function registerInlineCompletionProvider(
  stateMachine: CompletionStateMachine,
  logger: ILogger,
  subscriptions: vscode.Disposable[],
): InlineCompletionProvider {
  const provider = new InlineCompletionProvider(stateMachine, logger);

  const metadata: vscode.InlineCompletionItemProviderMetadata = {
    displayName: 'SukiTab',
    debounceDelayMs: 0,
    groupId: 'suki-tab',
    yieldTo: undefined,
    excludes: undefined,
  };

  const registration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider,
    metadata,
  );
  subscriptions.push(registration);
  return provider;
}
