import * as vscode from 'vscode';

export type ApiType = 'completions' | 'chat';

/** Single provider definition in the config file */
export interface ProviderConfig {
  /** Display name for this provider */
  name: string;
  /** Base URL of the API endpoint (e.g. https://api.openai.com/v1) */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Which API route to use: completions (/v1/completions) or chat (/v1/chat/completions) */
  apiType: ApiType;
  /** Model name to send in requests */
  model: string;
  /** Sampling temperature (0.0–2.0, lower for code completion) */
  temperature: number;
  /** Maximum tokens to generate per completion */
  maxTokens: number;
  /** Maximum context length (tokens) — controls how much prefix/suffix/extra context to send */
  contextLength: number;
  /** Stop sequences for generation */
  stopTokens: string[];
  /**
   * FIM template for chat mode only.
   * Supports placeholders: {prefix}, {suffix}, {language}, {filename}
   * If null and apiType=chat, a default prompt format is used.
   * Ignored when apiType=completions (native prompt+suffix).
   */
  fimTemplate: string | null;
  /**
   * Custom system prompt. If null, a built-in default system prompt is used.
   */
  customPrompt: string | null;
  /**
   * Controls cross-file context injection for FIM completions.
   * - 'strict': only prefix/suffix, no additional files or LSP context (faster, less token usage)
   * - 'augmented': include recent files, LSP definitions, and diagnostics as context (default)
   */
  fimContextMode?: 'strict' | 'augmented';
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface ByokConfig {
  /** Array of provider definitions */
  providers: ProviderConfig[];
  /** Name of the currently active provider */
  activeProvider: string;
  /** Feature flags */
  features: FeatureFlags;
  /** Debug settings */
  debug: DebugConfig;
}

export interface FeatureFlags {
  /** Master switch — disables all functionality when false */
  enabled: boolean;
  /** Show inline ghost-text suggestions */
  enableInlineSuggestions: boolean;
  /** Show prediction decorations for next edit location */
  enablePrediction: boolean;
  /** Include linter diagnostics as context */
  enableDiagnosticsHints: boolean;
  /** Include recently-viewed files as context */
  enableAdditionalFilesContext: boolean;
  /** Allow triggering suggestions inside comments */
  triggerInComments: boolean;
  /** Language IDs where suggestions are disabled */
  excludedLanguages: string[];
}

export interface DebugConfig {
  /** Enable debug logging */
  enabled: boolean;
  /** Log SSE stream chunks */
  logStream: boolean;
  /** Log full request/response payloads */
  logPayloads?: boolean;
  logEditCombine?: boolean;
  logFileSync?: boolean;
  logRpc?: boolean;
  verbosePayloads?: boolean;
}

export enum TriggerSource {
  Unknown = 'unknown',
  LineChange = 'line_change',
  Typing = 'typing',
  OptionHold = 'option_hold',
  LinterErrors = 'lint_errors',
  ParameterHints = 'parameter_hints',
  Prediction = 'prediction',
  CursorPrediction = 'cursor_prediction',
  ManualTrigger = 'manual_trigger',
  EditorChange = 'editor_change',
  LspSuggestions = 'lsp_suggestions',
}

export interface CompletionRequest {
  /** Text before the cursor (prefix) */
  prefix: string;
  /** Text after the cursor (suffix) */
  suffix: string;
  /** Language ID of the document */
  language: string;
  /** File name/path */
  filename: string;
  /** Additional files to include as context */
  additionalFiles: AdditionalFileContext[];
  /** Formatted diagnostic errors text */
  diagnostics: string;
  /** What triggered this request */
  triggerSource: TriggerSource;
}

/** Additional file included in request context */
export interface AdditionalFileContext {
  /** Relative workspace path */
  path: string;
  /** File content (truncated if needed) */
  content: string;
}

export interface SuggestionResult {
  /** The completion text to display as ghost text */
  text: string;
  /** The range in the document this suggestion replaces */
  range: vscode.Range;
  /** Optional prediction target for next edit location */
  predictionTarget?: PredictionTarget;
}

/** Where the model predicts the next edit should happen */
export interface PredictionTarget {
  /** File path (relative to workspace) */
  filePath: string;
  /** Line number (1-indexed) */
  line: number;
  /** Whether to retrigger a suggestion after jumping here */
  shouldRetrigger: boolean;
}

export type FlushResult =
  | { type: 'success'; text: string; done: boolean }
  | { type: 'failure'; reason: string };

/** Result of testing API connection */
export interface ConnectionTestResult {
  success: boolean;
  message: string;
  latencyMs?: number;
  modelInfo?: string;
}

/** SSE event from the API stream */
export type SSEEvent =
  | { type: 'text'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AdditionalFileInfo {
  relativeWorkspacePath: string;
  visibleRangeContent: string[];
  startLineNumberOneIndexed: number[];
  visibleRanges: Array<{
    startLineNumber: number;
    endLineNumberInclusive: number;
  }>;
  isOpen: boolean;
  lastViewedAt?: number;
}

/** LSP suggestion item */
export interface LspSuggestionItem {
  label: string;
}

/** LSP suggestions context */
export interface LspSuggestionsContext {
  suggestions: LspSuggestionItem[];
}

/** Parameter hints context */
export interface ParameterHintsContext {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{
      label: string;
      documentation?: string;
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}
