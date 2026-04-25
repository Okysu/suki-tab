import * as vscode from 'vscode';
import {
  ApiType,
  ByokConfig,
  ProviderConfig,
  FeatureFlags,
  DebugConfig,
  CompletionRequest,
  FlushResult,
  ConnectionTestResult,
  AdditionalFileInfo,
  LspSuggestionsContext,
  TriggerSource,
  ValidationResult,
} from './types';

export interface ILogger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface IConfigManager extends vscode.Disposable {
  readonly config: ByokConfig;
  readonly activeProvider: ProviderConfig;
  readonly features: FeatureFlags;
  readonly debug: DebugConfig;
  readonly onDidChange: vscode.Event<ByokConfig>;
  getConfigFilePath(): string;
  getProviders(): ProviderConfig[];
  setActiveProvider(name: string): Promise<void>;
  updateConfig(config: ByokConfig): Promise<void>;
  validateProvider(provider: ProviderConfig): ValidationResult;
  createDefaultConfigFile(): Promise<void>;
}

export interface ILLMClient extends vscode.Disposable {
  streamCompletion(request: CompletionRequest, requestId: string, signal?: AbortSignal): Promise<void>;
  flushCompletion(requestId: string): Promise<FlushResult>;
  cancelCompletion(requestId: string): void;
  updateProvider(provider: ProviderConfig): void;
  testConnection(): Promise<ConnectionTestResult>;
}

export interface IDocumentTracker extends vscode.Disposable {
  getHistory(uri: vscode.Uri): string[];
  clear(uri: vscode.Uri): void;
  getHistoryWithTimestamps(uri: vscode.Uri): Array<{ timestamp: number; change: string }>;
}

export interface IRelatedEditsService extends vscode.Disposable {
  checkRelatedEditsOnAccept(editor: vscode.TextEditor): void;
  reviewRelatedEdits(editor?: vscode.TextEditor): Promise<void>;
}

export interface IPredictionController extends vscode.Disposable {
  handleSuggestionAccepted(editor: vscode.TextEditor): Promise<void>;
  clearForDocument(document: vscode.TextDocument): void;
  showPredictionAt(editor: vscode.TextEditor, line: number): void;
}

export interface IDebounceManager extends vscode.Disposable {
  runRequest(): {
    generationUUID: string;
    startTime: number;
    abortController: AbortController;
    requestIdsToCancel: string[];
  };
  shouldDebounce(requestId: string): Promise<boolean>;
  removeRequest(requestId: string): void;
  abortRequest(requestId: string): void;
  abortAll(): void;
  getRequestCount(): number;
  setDebounceDurations(options: {
    clientDebounceDuration?: number;
    totalDebounceDuration?: number;
    maxConcurrentStreams?: number;
  }): void;
}

export interface IRecentFilesTracker extends vscode.Disposable {
  getAdditionalFilesContext(
    currentUri: vscode.Uri,
    fetchContent?: boolean
  ): Promise<AdditionalFileInfo[]>;
}

export interface ILspSuggestionsTracker extends vscode.Disposable {
  recordSuggestions(documentUri: string, suggestions: string[]): void;
  getRelevantSuggestions(documentUri: string): LspSuggestionsContext;
  captureCompletionsAt(document: vscode.TextDocument, position: vscode.Position): Promise<void>;
}

export interface ITelemetryService extends vscode.Disposable {
  recordTriggerStart(requestId: string): void;
  recordTriggerEvent(
    document: vscode.TextDocument,
    requestId: string,
    position: vscode.Position,
    source: TriggerSource
  ): void;
  recordSuggestionEvent(
    document: vscode.TextDocument,
    requestId: string,
    suggestionText: string
  ): void;
  recordAcceptEvent(document: vscode.TextDocument, requestId: string, acceptedLength: number): void;
  recordRejectEvent(document: vscode.TextDocument, requestId: string, reason?: string): void;
  recordPartialAcceptEvent(
    document: vscode.TextDocument,
    requestId: string,
    acceptedLength: number,
    kind: 'word' | 'line' | 'suggest' | 'unknown'
  ): void;
  recordGenerationFinished(requestId: string, success: boolean): void;
  recordDiagnosticsDiff(
    requestId: string,
    payload: {
      resolved: number;
      introduced: number;
      unchanged: number;
    }
  ): void;
}
