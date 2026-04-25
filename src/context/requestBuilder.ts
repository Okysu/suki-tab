import * as vscode from 'vscode';
import {
  ContextRankerCandidate,
  ContextRankerSection,
  selectRelevantContext,
} from './contextRanker';
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
const ADDITIONAL_CONTEXT_RATIO = 0.2;
const MIN_PRIMARY_CONTEXT_CHARS = 1200;
const MIN_ADDITIONAL_CONTEXT_CHARS = 1200;
const MAX_ADDITIONAL_CONTEXT_CHARS = 6000;
const MAX_RANKING_PREFIX_CHARS = 6000;

export interface RequestContextOptions {
  document: vscode.TextDocument;
  position: vscode.Position;
  additionalFiles?: AdditionalFileInfo[];
  lspContextFiles?: AdditionalFileContext[];
  diagnostics?: vscode.Diagnostic[];
  lspSuggestions?: LspSuggestionsContext;
  parameterHints?: ParameterHintsContext;
  triggerSource?: TriggerSource;
  contextLength: number;
}

export function buildCompletionRequest(options: RequestContextOptions): CompletionRequest {
  const maxChars = getMaxContextChars(options.contextLength);
  const prefixText = options.document
    .getText()
    .slice(0, options.document.offsetAt(options.position));
  const additionalContextBudget = getAdditionalContextBudget(
    maxChars,
    options.additionalFiles ?? [],
    options.lspContextFiles ?? []
  );
  const primaryContextChars = Math.max(maxChars - additionalContextBudget, 0);
  const prefixChars = Math.max(Math.floor(primaryContextChars * PREFIX_RATIO), 0);
  const suffixChars = Math.max(primaryContextChars - prefixChars, 0);
  const prefix = truncatePrefix(prefixText, prefixChars);
  const suffix = extractSuffix(options.document, options.position, suffixChars);
  const filename = getFilename(options.document);

  return {
    prefix,
    suffix,
    language: options.document.languageId,
    filename,
    additionalFiles: buildRankedAdditionalFiles(options, additionalContextBudget, prefix),
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

function buildRankedAdditionalFiles(
  options: RequestContextOptions,
  additionalContextBudget: number,
  prefixText: string
): AdditionalFileContext[] {
  if (additionalContextBudget <= 0) {
    return [];
  }

  const candidates = [
    ...buildRecentFileCandidates(options.additionalFiles ?? []),
    ...buildLspFileCandidates(options.lspContextFiles ?? []),
  ];

  if (candidates.length === 0) {
    return [];
  }

  const rankingPrefix = prefixText.slice(-Math.min(MAX_RANKING_PREFIX_CHARS, prefixText.length));

  return selectRelevantContext({
    currentFilePath: getFilename(options.document),
    currentFilePrefix: rankingPrefix,
    candidates,
    maxChars: additionalContextBudget,
  });
}

function buildRecentFileCandidates(files: AdditionalFileInfo[]): ContextRankerCandidate[] {
  return files
    .map((file) => ({
      path: file.relativeWorkspacePath,
      sections: buildRecentFileSections(file),
      origin: 'recent' as const,
      isOpen: file.isOpen,
      lastViewedAt: file.lastViewedAt,
    }))
    .filter((candidate) => candidate.sections.length > 0);
}

function buildLspFileCandidates(files: AdditionalFileContext[]): ContextRankerCandidate[] {
  return files
    .map((file) => ({
      path: file.path,
      sections: [{ content: file.content }],
      origin: 'lsp' as const,
    }))
    .filter((candidate) => candidate.sections.some((section) => section.content.trim().length > 0));
}

function buildRecentFileSections(file: AdditionalFileInfo): ContextRankerSection[] {
  const sectionCount = Math.max(
    file.visibleRanges.length,
    file.visibleRangeContent.length,
    file.startLineNumberOneIndexed.length
  );

  if (sectionCount === 0) {
    return [];
  }

  const sections: ContextRankerSection[] = [];

  for (let index = 0; index < sectionCount; index += 1) {
    const content = (file.visibleRangeContent[index] ?? '').trim();
    const range = file.visibleRanges[index];
    const startLine = file.startLineNumberOneIndexed[index] ?? range?.startLineNumber ?? 1;
    const inferredEndLine = startLine + countNewlines(content);
    const endLine = range?.endLineNumberInclusive ?? inferredEndLine;

    if (!content) {
      continue;
    }

    sections.push({
      content,
      startLine,
      endLine,
    });
  }

  return sections;
}

function getAdditionalContextBudget(
  maxChars: number,
  additionalFiles: AdditionalFileInfo[],
  lspContextFiles: AdditionalFileContext[]
): number {
  if (maxChars <= MIN_PRIMARY_CONTEXT_CHARS) {
    return 0;
  }

  const hasCandidates = additionalFiles.length > 0 || lspContextFiles.length > 0;
  if (!hasCandidates) {
    return 0;
  }

  const proportionalBudget = Math.floor(maxChars * ADDITIONAL_CONTEXT_RATIO);
  const maxAllowedBudget = Math.max(maxChars - MIN_PRIMARY_CONTEXT_CHARS, 0);
  const boundedBudget = Math.min(proportionalBudget, MAX_ADDITIONAL_CONTEXT_CHARS, maxAllowedBudget);

  if (boundedBudget <= 0) {
    return 0;
  }

  return Math.max(Math.min(MIN_ADDITIONAL_CONTEXT_CHARS, maxAllowedBudget), boundedBudget);
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
