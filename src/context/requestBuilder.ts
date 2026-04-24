import * as vscode from 'vscode';
import { TriggerSource } from './types';
import type {
  CompletionRequest,
  AdditionalFileContext,
  AdditionalFileInfo,
  LspSuggestionsContext,
  ParameterHintsContext,
} from './types';

const CHARS_PER_TOKEN = 4;
const PREFIX_RATIO = 0.7;
const TRUNCATION_MARKER = '// ... truncated ...';

export interface RequestContextOptions {
  document: vscode.TextDocument;
  position: vscode.Position;
  additionalFiles?: AdditionalFileInfo[];
  diagnostics?: vscode.Diagnostic[];
  lspSuggestions?: LspSuggestionsContext;
  parameterHints?: ParameterHintsContext;
  triggerSource?: TriggerSource;
  contextLength: number;
}

export function buildCompletionRequest(options: RequestContextOptions): CompletionRequest {
  const maxChars = getMaxContextChars(options.contextLength);
  const prefixChars = Math.max(Math.floor(maxChars * PREFIX_RATIO), 0);
  const suffixChars = Math.max(maxChars - prefixChars, 0);

  return {
    prefix: extractPrefix(options.document, options.position, prefixChars),
    suffix: extractSuffix(options.document, options.position, suffixChars),
    language: options.document.languageId,
    filename: getFilename(options.document),
    additionalFiles: buildAdditionalFiles(options.additionalFiles ?? []),
    diagnostics: formatDiagnostics(options.diagnostics ?? []),
    triggerSource: options.triggerSource ?? TriggerSource.Unknown,
  };
}

export function formatDiagnostics(diagnostics: vscode.Diagnostic[]): string {
  const relevantDiagnostics = diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === vscode.DiagnosticSeverity.Error ||
      diagnostic.severity === vscode.DiagnosticSeverity.Warning
  );

  if (relevantDiagnostics.length === 0) {
    return '';
  }

  return relevantDiagnostics
    .map((diagnostic) => {
      const severity =
        diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      const message = diagnostic.message.replace(/\s+/g, ' ').trim();

      return `line ${diagnostic.range.start.line + 1}: [${severity}] ${message}`;
    })
    .join('\n');
}

export function extractPrefix(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxChars: number
): string {
  const text = document.getText().slice(0, document.offsetAt(position));
  return truncatePrefix(text, maxChars);
}

export function extractSuffix(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxChars: number
): string {
  const text = document.getText().slice(document.offsetAt(position));
  return truncateSuffix(text, maxChars);
}

export function countNewlines(text: string): number {
  const matches = text.match(/\n/g);
  return matches ? matches.length : 0;
}

function getMaxContextChars(contextLength: number): number {
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    return 0;
  }

  return Math.floor(contextLength * CHARS_PER_TOKEN);
}

function getFilename(document: vscode.TextDocument): string {
  const relativePath = vscode.workspace.asRelativePath(document.uri, false);
  return relativePath || document.fileName;
}

function buildAdditionalFiles(files: AdditionalFileInfo[]): AdditionalFileContext[] {
  return files.map((file) => ({
    path: file.relativeWorkspacePath,
    content: formatAdditionalFileContent(file),
  }));
}

function formatAdditionalFileContent(file: AdditionalFileInfo): string {
  const sectionCount = Math.max(
    file.visibleRanges.length,
    file.visibleRangeContent.length,
    file.startLineNumberOneIndexed.length
  );

  if (sectionCount === 0) {
    return '';
  }

  const sections: string[] = [];

  for (let index = 0; index < sectionCount; index += 1) {
    const content = file.visibleRangeContent[index] ?? '';
    const range = file.visibleRanges[index];
    const startLine = file.startLineNumberOneIndexed[index] ?? range?.startLineNumber ?? 1;
    const inferredEndLine = startLine + countNewlines(content);
    const endLine = range?.endLineNumberInclusive ?? inferredEndLine;
    const lineLabel = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

    sections.push(content ? `lines ${lineLabel}\n${content}` : `lines ${lineLabel}`);
  }

  return sections.join('\n\n');
}

function truncatePrefix(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }

  if (text.length <= maxChars) {
    return text;
  }

  const availableChars = Math.max(maxChars - TRUNCATION_MARKER.length - 1, 0);
  if (availableChars <= 0) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }

  return `${TRUNCATION_MARKER}\n${text.slice(-availableChars)}`;
}

function truncateSuffix(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }

  if (text.length <= maxChars) {
    return text;
  }

  const availableChars = Math.max(maxChars - TRUNCATION_MARKER.length - 1, 0);
  if (availableChars <= 0) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }

  return `${text.slice(0, availableChars)}\n${TRUNCATION_MARKER}`;
}
