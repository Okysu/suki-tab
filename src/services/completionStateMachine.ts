import * as vscode from 'vscode';
import { withRetry } from './retry';
import { buildCompletionRequest, RequestContextOptions } from '../context/requestBuilder';
import {
  IDocumentTracker,
  ILLMClient,
  ILogger,
  IConfigManager,
  IPredictionController,
  IDebounceManager,
  IRecentFilesTracker,
  ITelemetryService,
  ILspSuggestionsTracker,
} from '../context/contracts';
import { CompletionRequest, FeatureFlags, TriggerSource, SuggestionResult, AdditionalFileContext } from '../context/types';
import { CompletionHeuristicsService } from './completionHeuristics';
import { InlineEditTriggerer } from './inlineEditTriggerer';

export interface SuggestionContext {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  readonly token: vscode.CancellationToken;
  readonly requestUuid?: string;
  readonly requestIssuedDateTime?: number;
  readonly earliestShownDateTime?: number;
  readonly userPrompt?: string;
  readonly triggerSource?: TriggerSource;
  readonly triggerKind?: vscode.InlineCompletionTriggerKind;
}

const MAX_CONCURRENT_STREAMS = 6;

interface CachedSuggestion {
  readonly suggestion: SuggestionResult;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly timestamp: number;
}

export class CompletionStateMachine implements vscode.Disposable {
  private readonly activeStreams = new Map<string, AbortController>();
  private readonly pendingControllers = new Map<string, AbortController>();
  private readonly supersededRequests = new Set<string>();
  private currentRequestByDocument = new Map<string, string>();
  private readonly suggestionCache: CachedSuggestion[] = [];
  private readonly maxCachedSuggestions = 5;
  private requestSeed = 0;
  private flags: FeatureFlags;
  private pendingTriggerSource?: TriggerSource;
  private pendingTriggerTimestamp = 0;
  private readonly pendingTriggerMaxAgeMs = 500;

  private readonly _onSuggestionCached = new vscode.EventEmitter<void>();
  readonly onSuggestionCached = this._onSuggestionCached.event;

  private readonly _onRequestStarted = new vscode.EventEmitter<void>();
  readonly onRequestStarted = this._onRequestStarted.event;

  private readonly _onRequestFinished = new vscode.EventEmitter<boolean>();
  readonly onRequestFinished = this._onRequestFinished.event;

  private readonly heuristics: CompletionHeuristicsService;
  private readonly inlineEditTriggerer: InlineEditTriggerer;

  constructor(
    private readonly tracker: IDocumentTracker,
    private readonly llmClient: ILLMClient,
    private readonly logger: ILogger,
    private readonly configManager: IConfigManager,
    private readonly predictionController: IPredictionController,
    private readonly debounceManager?: IDebounceManager,
    private readonly recentFilesTracker?: IRecentFilesTracker,
    private readonly telemetryService?: ITelemetryService,
    private readonly lspSuggestionsTracker?: ILspSuggestionsTracker,
  ) {
    this.flags = configManager.features;
    configManager.onDidChange(() => {
      this.flags = configManager.features;
    });

    this.heuristics = new CompletionHeuristicsService(logger);
    this.inlineEditTriggerer = new InlineEditTriggerer(logger);

    this.inlineEditTriggerer.onTrigger(({ triggerSource }) => {
      this.pendingTriggerSource = triggerSource;
      this.pendingTriggerTimestamp = Date.now();
    });
  }

  dispose(): void {
    for (const controller of this.activeStreams.values()) {
      controller.abort();
    }
    for (const controller of this.pendingControllers.values()) {
      controller.abort();
    }
    this.activeStreams.clear();
    this.pendingControllers.clear();
    this.currentRequestByDocument.clear();
    this.supersededRequests.clear();
    this.suggestionCache.length = 0;
    this.heuristics.dispose();
    this.inlineEditTriggerer.dispose();
    this._onSuggestionCached.dispose();
    this._onRequestStarted.dispose();
    this._onRequestFinished.dispose();
  }

  async requestSuggestion(ctx: SuggestionContext): Promise<SuggestionResult | null> {
    if (!this.flags.enableInlineSuggestions || !this.isEligible(ctx)) {
      return null;
    }

    const docKey = ctx.document.uri.toString();

    const cachedSuggestion = this.popCachedSuggestion(docKey, ctx.document.version);
    if (cachedSuggestion) {
      this.logger.info(`[Byok] Using cached suggestion`);
      return cachedSuggestion;
    }

    let requestId: string;
    let abortController: AbortController;

    if (this.debounceManager) {
      const runResult = this.debounceManager.runRequest();
      requestId = runResult.generationUUID;
      abortController = runResult.abortController;
      this.pendingControllers.set(requestId, abortController);
      for (const cancelId of runResult.requestIdsToCancel) {
        this.cancelStream(cancelId);
      }
      if (await this.debounceManager.shouldDebounce(requestId)) {
        this.logger.info(`[Byok] Request ${requestId.slice(0, 8)} debounced`);
        return null;
      }
    } else {
      abortController = new AbortController();
      requestId = ctx.requestUuid ?? `req-${Date.now()}-${this.requestSeed++}`;
    }

    this.registerStream(requestId, abortController);

    const prevRequestId = this.currentRequestByDocument.get(docKey);
    if (prevRequestId && prevRequestId !== requestId) {
      this.cancelStream(prevRequestId);
    }
    this.currentRequestByDocument.set(docKey, requestId);

    const triggerSource = this.getTriggerSource(ctx);

    this.telemetryService?.recordTriggerStart(requestId);
    this.telemetryService?.recordTriggerEvent(ctx.document, requestId, ctx.position, triggerSource);

    const diagnostics = vscode.languages.getDiagnostics(ctx.document.uri);

    const additionalFiles = this.flags.enableAdditionalFilesContext && this.recentFilesTracker
      ? await this.recentFilesTracker.getAdditionalFilesContext(ctx.document.uri)
      : undefined;

    const lspContextFiles = await this.getLspDefinitionContext(ctx.document, ctx.position);

    const lspSuggestions = this.lspSuggestionsTracker
      ? this.lspSuggestionsTracker.getRelevantSuggestions(ctx.document.uri.toString())
      : undefined;

    const provider = this.configManager.activeProvider;

    const requestContext: RequestContextOptions = {
      document: ctx.document,
      position: ctx.position,
      additionalFiles,
      lspContextFiles,
      diagnostics,
      lspSuggestions,
      triggerSource,
      contextLength: provider.contextLength,
    };

    const completionRequest = buildCompletionRequest(requestContext);
    let success = false;

    this._onRequestStarted.fire();

    try {
      const result = await withRetry(
        () => this.consumeStream(completionRequest, ctx, abortController, requestId),
        { retries: 1, delayMs: 100 },
      );
      success = result !== null;

      this.telemetryService?.recordGenerationFinished(requestId, result !== null);

      const currentRequest = this.currentRequestByDocument.get(docKey);
      if (currentRequest !== requestId) {
        this.logger.info(`[Byok] Request ${requestId.slice(0, 8)} superseded, caching result`);
        if (result) {
          this.addToSuggestionCache(result, ctx.document.uri.toString(), ctx.document.version);
        }
        return null;
      }

      if (result) {
        this.telemetryService?.recordSuggestionEvent(ctx.document, requestId, result.text);
      }
      return result;
    } catch (error: any) {
      this.logger.error(`[Byok] Request ${requestId.slice(0, 8)} failed: ${error?.message ?? String(error)}`);
      this.telemetryService?.recordGenerationFinished(requestId, false);
      return null;
    } finally {
      this.unregisterStream(requestId);
      this.debounceManager?.removeRequest(requestId);
      const wasStillActive = this.currentRequestByDocument.get(docKey) === requestId;
      this.supersededRequests.delete(requestId);
      if (wasStillActive) {
        this.currentRequestByDocument.delete(docKey);
      }
      this.pendingControllers.delete(requestId);
      if (wasStillActive) {
        this._onRequestFinished.fire(success);
      }
    }
  }

  async handleAccept(
    editor: vscode.TextEditor,
    requestId?: string,
    _bindingId?: string,
    acceptedLength?: number,
  ): Promise<void> {
    if (!requestId) {return;}

    const diagnosticsBefore = vscode.languages.getDiagnostics(editor.document.uri);
    this.telemetryService?.recordAcceptEvent(editor.document, requestId, acceptedLength ?? 0);
    void this.predictionController.handleSuggestionAccepted(editor);
    void this.recordDiagnosticsDiff(editor.document.uri, requestId, diagnosticsBefore);
  }

  handlePartialAccept(
    _editor: vscode.TextEditor,
    requestId: string | undefined,
    acceptedLength: number,
    kind: 'word' | 'line' | 'suggest' | 'unknown',
  ): void {
    if (!requestId) {return;}
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.telemetryService?.recordPartialAcceptEvent(editor.document, requestId, acceptedLength, kind);
    }
  }

  handleCompletionEnd(
    _editor: vscode.TextEditor,
    requestId: string | undefined,
    accepted: boolean,
  ): void {
    if (!requestId) {return;}
    if (!accepted) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this.telemetryService?.recordRejectEvent(editor.document, requestId);
      }
    }
  }

  private async recordDiagnosticsDiff(
    uri: vscode.Uri,
    requestId: string,
    before: readonly vscode.Diagnostic[],
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = vscode.languages.getDiagnostics(uri);

    const beforeKeys = new Set(before.map((d) => this.getDiagnosticKey(d)));
    const afterKeys = new Set(after.map((d) => this.getDiagnosticKey(d)));

    let resolved = 0;
    for (const key of beforeKeys) {
      if (!afterKeys.has(key)) {
        resolved += 1;
      }
    }

    let introduced = 0;
    for (const key of afterKeys) {
      if (!beforeKeys.has(key)) {
        introduced += 1;
      }
    }

    let unchanged = 0;
    for (const key of beforeKeys) {
      if (afterKeys.has(key)) {
        unchanged += 1;
      }
    }

    this.telemetryService?.recordDiagnosticsDiff(requestId, {
      resolved,
      introduced,
      unchanged,
    });
  }

  private getDiagnosticKey(diagnostic: vscode.Diagnostic): string {
    return [
      diagnostic.severity,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
      diagnostic.message.replace(/\s+/g, ' ').trim(),
    ].join('|');
  }

  private async getLspDefinitionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<AdditionalFileContext[]> {
    const results: AdditionalFileContext[] = [];
    const visitedUris = new Set<string>();
    const currentUriStr = document.uri.toString();
    const LSP_RADIUS_LINES = 30;
    const MAX_DEFINITIONS = 3;
    let count = 0;

    const commands = [
      'vscode.executeDefinitionProvider',
      'vscode.executeTypeDefinitionProvider',
    ] as const;

    for (const cmd of commands) {
      if (count >= MAX_DEFINITIONS) { break; }

      let locations: (vscode.Location | vscode.LocationLink)[] = [];
      try {
        locations = await Promise.race([
          vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
            cmd, document.uri, position,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 300),
          ),
        ]);
      } catch {
        continue;
      }

      if (!locations) { continue; }

      for (const loc of locations) {
        if (count >= MAX_DEFINITIONS) { break; }

        const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
        const range = 'targetRange' in loc ? loc.targetRange : loc.range;
        const uriStr = uri.toString();

        if (uriStr === currentUriStr) { continue; }
        if (visitedUris.has(uriStr)) { continue; }
        visitedUris.add(uriStr);

        const relativePath = vscode.workspace.asRelativePath(uri, false);
        if (!relativePath || relativePath === document.uri.fsPath) { continue; }

        try {
          const defDoc = await vscode.workspace.openTextDocument(uri);
          const startLine = Math.max(0, range.start.line - LSP_RADIUS_LINES);
          const endLine = Math.min(defDoc.lineCount - 1, range.end.line + LSP_RADIUS_LINES);
          const contentRange = new vscode.Range(startLine, 0, endLine + 1, 0);
          const content = defDoc.getText(contentRange);

          if (content.trim()) {
            results.push({ path: relativePath, content });
            count++;
            this.logger.info(`[LSP] Added definition context: ${relativePath} (line ${range.start.line})`);
          }
        } catch {
          // File not accessible
        }
      }
    }

    return results;
  }

  private async consumeStream(
    request: CompletionRequest,
    ctx: SuggestionContext,
    abortController: AbortController,
    requestId: string,
  ): Promise<SuggestionResult | null> {
    await this.llmClient.streamCompletion(request, requestId, abortController.signal);

    let accumulatedText = '';
    let streamDone = false;

    while (!streamDone) {
      if (ctx.token.isCancellationRequested || this.supersededRequests.has(requestId)) {
        this.llmClient.cancelCompletion(requestId);
        return null;
      }

      const result = await this.llmClient.flushCompletion(requestId);
      if (result.type === 'failure') {
        this.logger.warn(`[Byok] Stream flush failed: ${result.reason}`);
        return null;
      }

      accumulatedText += result.text;
      streamDone = result.done;

      if (!streamDone) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }

    if (!accumulatedText.trim()) {
      this.logger.info(`[Byok] Empty completion text`);
      return null;
    }

    const range = this.inferRange(ctx.document, ctx.position, accumulatedText);

    const isInlineSuggestionResult = this.isInlineSuggestion(ctx.position, ctx.document, range, accumulatedText);
    const originalText = ctx.document.getText(range);
    const isInlineEdit = !isInlineSuggestionResult && originalText !== accumulatedText;

    let showRange: vscode.Range | undefined;
    if (isInlineEdit) {
      const padding = 4;
      showRange = new vscode.Range(
        Math.max(range.start.line - padding, 0),
        0,
        range.end.line + padding,
        Number.MAX_SAFE_INTEGER,
      );
    }

    const validation = this.heuristics.isValidCompletion(
      ctx.document,
      range.start.line + 1,
      range.end.line + 1,
      accumulatedText,
    );

    if (!validation.valid) {
      this.logger.info(`[Byok] Suggestion rejected by heuristics: ${validation.invalidReason}`);
      return null;
    }

    return {
      text: accumulatedText,
      range,
      predictionTarget: undefined,
    };
  }

  private inferRange(
    document: vscode.TextDocument,
    position: vscode.Position,
    completionText: string,
  ): vscode.Range {
    return new vscode.Range(position, position);
  }

  private isEligible(ctx: SuggestionContext): boolean {
    const vscodeEnabled = vscode.workspace.getConfiguration('sukiTab').get<boolean>('enabled', true);
    if (!vscodeEnabled) {return false;}
    if (ctx.token.isCancellationRequested) {return false;}
    if (this.flags.excludedLanguages.includes(ctx.document.languageId)) {return false;}

    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {return false;}

    if (ctx.document.getText().length > 800_000) {
      this.logger.info(`[Byok] Skipping - file too large`);
      return false;
    }

    const isManualTrigger = ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    if (!this.flags.triggerInComments && !isManualTrigger && this.isInCommentArea(ctx.document, ctx.position)) {
      return false;
    }

    return true;
  }

  private getTriggerSource(ctx: SuggestionContext): TriggerSource {
    if (ctx.triggerSource) {return ctx.triggerSource;}

    if (this.pendingTriggerSource && Date.now() - this.pendingTriggerTimestamp < this.pendingTriggerMaxAgeMs) {
      const source = this.pendingTriggerSource;
      this.pendingTriggerSource = undefined;
      return source;
    }

    if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
      return TriggerSource.ManualTrigger;
    }
    return TriggerSource.Typing;
  }

  private isInCommentArea(document: vscode.TextDocument, position: vscode.Position): boolean {
    const line = document.lineAt(position.line);
    const lineText = line.text;
    const charBefore = lineText.substring(0, position.character);

    const singleLinePatterns = ['//', '#', '--'];
    for (const pattern of singleLinePatterns) {
      const commentStart = lineText.indexOf(pattern);
      if (commentStart !== -1 && commentStart < position.character) {return true;}
    }

    const blockStart = lineText.lastIndexOf('/*', position.character);
    if (blockStart !== -1) {
      const blockEnd = lineText.indexOf('*/', blockStart + 2);
      if (blockEnd === -1 || blockEnd >= position.character) {return true;}
    }

    if (/^\s*\*(?!\/)/.test(lineText) && !lineText.includes('*/')) {return true;}

    const htmlStart = charBefore.lastIndexOf('<!--');
    if (htmlStart !== -1) {
      const htmlEnd = charBefore.indexOf('-->', htmlStart + 4);
      if (htmlEnd === -1) {return true;}
    }

    return false;
  }

  private isInlineSuggestion(
    cursorPos: vscode.Position,
    document: vscode.TextDocument,
    range: vscode.Range,
    newText: string,
  ): boolean {
    if (
      range.isEmpty &&
      cursorPos.line + 1 === range.start.line &&
      range.start.character === 0 &&
      document.lineAt(cursorPos.line).text.length === cursorPos.character &&
      newText.endsWith('\n')
    ) {
      return true;
    }

    if (range.start.line !== range.end.line || range.start.line !== cursorPos.line) {
      return false;
    }

    const cursorOffset = document.offsetAt(cursorPos);
    const rangeStartOffset = document.offsetAt(range.start);
    const cursorOffsetInReplacedText = cursorOffset - rangeStartOffset;

    if (cursorOffsetInReplacedText < 0) {return false;}

    const replacedText = document.getText(range);
    const textBeforeCursorIsEqual =
      replacedText.substring(0, cursorOffsetInReplacedText) ===
      newText.substring(0, cursorOffsetInReplacedText);

    if (!textBeforeCursorIsEqual) {return false;}

    return this.isSubword(replacedText, newText);
  }

  private isSubword(a: string, b: string): boolean {
    for (let aIdx = 0, bIdx = 0; aIdx < a.length; bIdx++) {
      if (bIdx >= b.length) {return false;}
      if (a[aIdx] === b[bIdx]) {aIdx++;}
    }
    return true;
  }

  private registerStream(requestId: string, controller: AbortController): void {
    this.pendingControllers.delete(requestId);
    this.activeStreams.set(requestId, controller);
    if (this.activeStreams.size > MAX_CONCURRENT_STREAMS) {
      const [oldest] = this.activeStreams.keys();
      this.supersededRequests.add(oldest);
    }
  }

  private unregisterStream(requestId: string): void {
    this.activeStreams.delete(requestId);
    this.pendingControllers.delete(requestId);
  }

  private cancelStream(requestId: string): void {
    const controller = this.activeStreams.get(requestId) ?? this.pendingControllers.get(requestId);
    if (controller) {
      this.supersededRequests.add(requestId);
      controller.abort();
    }
  }

  private addToSuggestionCache(suggestion: SuggestionResult, documentUri: string, documentVersion: number): void {
    this.suggestionCache.push({ suggestion, documentUri, documentVersion, timestamp: Date.now() });
    while (this.suggestionCache.length > this.maxCachedSuggestions) {
      this.suggestionCache.shift();
    }
    this._onSuggestionCached.fire();
  }

  private popCachedSuggestion(documentUri: string, documentVersion: number): SuggestionResult | null {
    const maxVersionDiff = 3;
    for (let i = this.suggestionCache.length - 1; i >= 0; i--) {
      const cached = this.suggestionCache[i];
      const versionDiff = documentVersion - cached.documentVersion;
      if (cached.documentUri === documentUri && versionDiff <= maxVersionDiff && versionDiff >= 0) {
        this.suggestionCache.splice(i, 1);
        return cached.suggestion;
      }
    }
    return null;
  }

  getInlineEditTriggerer(): InlineEditTriggerer {
    return this.inlineEditTriggerer;
  }

  getHeuristics(): CompletionHeuristicsService {
    return this.heuristics;
  }
}
