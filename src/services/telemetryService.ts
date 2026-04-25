import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';
import { TriggerSource } from '../context/types';

export interface SessionStatistics {
  triggerCount: number;
  suggestionCount: number;
  acceptCount: number;
  rejectCount: number;
  partialAcceptCount: number;
  totalCharsAccepted: number;
  triggersBySource: Record<string, number>;
  sessionStartTime: number;
  avgGenerationTimeMs: number;
  acceptRate: number;
  diagnosticsResolved: number;
  diagnosticsIntroduced: number;
}

export enum CompletionEventType {
  Trigger = 'trigger',
  Suggestion = 'suggestion',
  Accept = 'accept',
  Reject = 'reject',
  PartialAccept = 'partial_accept',
  GenerationFinished = 'generation_finished',
  LspSuggestion = 'lsp_suggestion',
  DiagnosticsDiff = 'diagnostics_diff',
}

interface CompletionEventBase {
  type: CompletionEventType;
  timestamp: number;
  requestId: string;
  documentUri?: string;
  documentVersion?: number;
}

export interface CompletionTriggerEvent extends CompletionEventBase {
  type: CompletionEventType.Trigger;
  source: TriggerSource;
  cursorPosition: { line: number; column: number };
}

export interface CompletionSuggestionEvent extends CompletionEventBase {
  type: CompletionEventType.Suggestion;
  suggestionLength: number;
  lineCount: number;
}

export interface CompletionAcceptEvent extends CompletionEventBase {
  type: CompletionEventType.Accept;
  acceptedLength: number;
}

export interface CompletionRejectEvent extends CompletionEventBase {
  type: CompletionEventType.Reject;
  reason?: string;
}

export interface CompletionPartialAcceptEvent extends CompletionEventBase {
  type: CompletionEventType.PartialAccept;
  acceptedLength: number;
  kind: 'word' | 'line' | 'suggest' | 'unknown';
}

export interface CompletionGenerationFinishedEvent extends CompletionEventBase {
  type: CompletionEventType.GenerationFinished;
  durationMs: number;
  success: boolean;
}

export interface CompletionLspSuggestionEvent extends CompletionEventBase {
  type: CompletionEventType.LspSuggestion;
  suggestionCount: number;
  labels: string[];
}

export interface CompletionDiagnosticsDiffEvent extends CompletionEventBase {
  type: CompletionEventType.DiagnosticsDiff;
  resolved: number;
  introduced: number;
  unchanged: number;
}

type CompletionEvent =
  | CompletionTriggerEvent
  | CompletionSuggestionEvent
  | CompletionAcceptEvent
  | CompletionRejectEvent
  | CompletionPartialAcceptEvent
  | CompletionGenerationFinishedEvent
  | CompletionLspSuggestionEvent
  | CompletionDiagnosticsDiffEvent;

const MAX_EVENTS = 100;

export class TelemetryService implements vscode.Disposable {
  private events: CompletionEvent[] = [];
  private requestStartTimes = new Map<string, number>();

  private stats = {
    triggerCount: 0,
    suggestionCount: 0,
    acceptCount: 0,
    rejectCount: 0,
    partialAcceptCount: 0,
    totalCharsAccepted: 0,
    triggersBySource: {} as Record<string, number>,
    generationTimes: [] as number[],
    sessionStartTime: Date.now(),
    diagnosticsResolved: 0,
    diagnosticsIntroduced: 0,
  };

  private readonly _onStatsChanged = new vscode.EventEmitter<SessionStatistics>();
  public readonly onStatsChanged = this._onStatsChanged.event;

  constructor(private readonly logger: ILogger) {}

  dispose(): void {
    this.events = [];
    this.requestStartTimes.clear();
    this._onStatsChanged.dispose();
  }

  recordTriggerStart(requestId: string): void {
    this.requestStartTimes.set(requestId, performance.now());
  }

  recordTriggerEvent(
    document: vscode.TextDocument,
    requestId: string,
    position: vscode.Position,
    source: TriggerSource
  ): void {
    const event: CompletionTriggerEvent = {
      type: CompletionEventType.Trigger,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      source,
      cursorPosition: {
        line: position.line + 1,
        column: position.character + 1,
      },
    };
    this.addEvent(event);

    this.stats.triggerCount++;
    this.stats.triggersBySource[source] = (this.stats.triggersBySource[source] || 0) + 1;
    this.notifyStatsChanged();

    this.logger.info(
      `[Telemetry] Trigger: ${source} at ${position.line + 1}:${position.character + 1}`
    );
  }

  recordSuggestionEvent(
    document: vscode.TextDocument,
    requestId: string,
    suggestionText: string
  ): void {
    const lineCount = suggestionText.split('\n').length;
    const event: CompletionSuggestionEvent = {
      type: CompletionEventType.Suggestion,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      suggestionLength: suggestionText.length,
      lineCount,
    };
    this.addEvent(event);

    this.stats.suggestionCount++;
    this.notifyStatsChanged();

    this.logger.info(
      `[Telemetry] Suggestion shown: ${suggestionText.length} chars, ${lineCount} lines`
    );
  }

  recordAcceptEvent(document: vscode.TextDocument, requestId: string, acceptedLength: number): void {
    const event: CompletionAcceptEvent = {
      type: CompletionEventType.Accept,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      acceptedLength,
    };
    this.addEvent(event);

    this.stats.acceptCount++;
    this.stats.totalCharsAccepted += acceptedLength;
    this.notifyStatsChanged();

    this.logger.info(`[Telemetry] Accept: ${acceptedLength} chars`);
  }

  recordRejectEvent(document: vscode.TextDocument, requestId: string, reason?: string): void {
    const event: CompletionRejectEvent = {
      type: CompletionEventType.Reject,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      reason,
    };
    this.addEvent(event);

    this.stats.rejectCount++;
    this.notifyStatsChanged();

    this.logger.info(`[Telemetry] Reject${reason ? `: ${reason}` : ''}`);
  }

  recordPartialAcceptEvent(
    document: vscode.TextDocument,
    requestId: string,
    acceptedLength: number,
    kind: 'word' | 'line' | 'suggest' | 'unknown'
  ): void {
    const event: CompletionPartialAcceptEvent = {
      type: CompletionEventType.PartialAccept,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      acceptedLength,
      kind,
    };
    this.addEvent(event);

    this.stats.partialAcceptCount++;
    this.stats.totalCharsAccepted += acceptedLength;
    this.notifyStatsChanged();

    this.logger.info(`[Telemetry] Partial accept: ${acceptedLength} chars, kind=${kind}`);
  }

  recordGenerationFinished(requestId: string, success: boolean): void {
    const startTime = this.requestStartTimes.get(requestId);
    const durationMs = startTime ? performance.now() - startTime : 0;
    this.requestStartTimes.delete(requestId);

    const event: CompletionGenerationFinishedEvent = {
      type: CompletionEventType.GenerationFinished,
      timestamp: Date.now(),
      requestId,
      durationMs,
      success,
    };
    this.addEvent(event);

    if (success && durationMs > 0) {
      this.stats.generationTimes.push(durationMs);
      if (this.stats.generationTimes.length > 100) {
        this.stats.generationTimes.shift();
      }
      this.notifyStatsChanged();
    }

    this.logger.info(
      `[Telemetry] Generation ${success ? 'succeeded' : 'failed'} in ${Math.round(durationMs)}ms`
    );
  }

  recordLspSuggestionEvent(
    document: vscode.TextDocument,
    requestId: string,
    labels: string[]
  ): void {
    const event: CompletionLspSuggestionEvent = {
      type: CompletionEventType.LspSuggestion,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      suggestionCount: labels.length,
      labels: labels.slice(0, 10),
    };
    this.addEvent(event);
    this.logger.info(`[Telemetry] LSP suggestions: ${labels.length} items`);
  }

  recordDiagnosticsDiff(
    requestId: string,
    payload: { resolved: number; introduced: number; unchanged: number },
  ): void {
    const event: CompletionDiagnosticsDiffEvent = {
      type: CompletionEventType.DiagnosticsDiff,
      timestamp: Date.now(),
      requestId,
      resolved: payload.resolved,
      introduced: payload.introduced,
      unchanged: payload.unchanged,
    };
    this.addEvent(event);
    this.stats.diagnosticsResolved += payload.resolved;
    this.stats.diagnosticsIntroduced += payload.introduced;
    this.notifyStatsChanged();
    this.logger.info(
      `[Telemetry] Diagnostics diff: resolved=${payload.resolved}, introduced=${payload.introduced}, unchanged=${payload.unchanged}`,
    );
  }

  getRecentEvents(count = 20): CompletionEvent[] {
    return this.events.slice(-count);
  }

  getEventsForRequest(requestId: string): CompletionEvent[] {
    return this.events.filter((e) => e.requestId === requestId);
  }

  clearEvents(): void {
    this.events = [];
  }

  getStatistics(): SessionStatistics {
    const avgTime = this.stats.generationTimes.length > 0
      ? this.stats.generationTimes.reduce((a, b) => a + b, 0) / this.stats.generationTimes.length
      : 0;

    const acceptRate = this.stats.suggestionCount > 0
      ? (this.stats.acceptCount + this.stats.partialAcceptCount) / this.stats.suggestionCount
      : 0;

    return {
      triggerCount: this.stats.triggerCount,
      suggestionCount: this.stats.suggestionCount,
      acceptCount: this.stats.acceptCount,
      rejectCount: this.stats.rejectCount,
      partialAcceptCount: this.stats.partialAcceptCount,
      totalCharsAccepted: this.stats.totalCharsAccepted,
      triggersBySource: { ...this.stats.triggersBySource },
      sessionStartTime: this.stats.sessionStartTime,
      avgGenerationTimeMs: Math.round(avgTime),
      acceptRate: Math.round(acceptRate * 100) / 100,
      diagnosticsResolved: this.stats.diagnosticsResolved,
      diagnosticsIntroduced: this.stats.diagnosticsIntroduced,
    };
  }

  resetStatistics(): void {
    this.stats = {
      triggerCount: 0,
      suggestionCount: 0,
      acceptCount: 0,
      rejectCount: 0,
      partialAcceptCount: 0,
      totalCharsAccepted: 0,
      triggersBySource: {},
      generationTimes: [],
      sessionStartTime: Date.now(),
      diagnosticsResolved: 0,
      diagnosticsIntroduced: 0,
    };
    this.notifyStatsChanged();
    this.logger.info('[Telemetry] Statistics reset');
  }

  private notifyStatsChanged(): void {
    this._onStatsChanged.fire(this.getStatistics());
  }

  private addEvent(event: CompletionEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }
}
