import type { AdditionalFileContext } from './types';

export type ContextCandidateOrigin = 'recent' | 'lsp';

export interface ContextRankerSection {
  content: string;
  startLine?: number;
  endLine?: number;
}

export interface ContextRankerCandidate {
  path: string;
  sections: ContextRankerSection[];
  origin: ContextCandidateOrigin;
  isOpen?: boolean;
  lastViewedAt?: number;
}

export interface ContextRankerOptions {
  currentFilePath: string;
  currentFilePrefix: string;
  candidates: ContextRankerCandidate[];
  maxChars: number;
  currentSymbol?: string;
  importPaths?: string[];
}

interface ContextWindow {
  path: string;
  content: string;
  origin: ContextCandidateOrigin;
  isOpen: boolean;
  lastViewedAt?: number;
  startLine?: number;
  endLine?: number;
  tokenSet: Set<string>;
}

interface ScoredContextWindow extends ContextWindow {
  score: number;
}

interface SelectedWindow {
  window: ContextWindow;
  formattedContent: string;
}

const TRUNCATION_MARKER = '// ... truncated ...';
const WINDOW_MAX_LINES = 60;
const WINDOW_OVERLAP_LINES = 12;
const WINDOW_MAX_CHARS = 1400;
const MAX_WINDOWS_PER_FILE = 2;
const CONTEXT_FILE_OVERHEAD = 80;
const IMPORT_SPECIFIER_PATTERN =
  /(?:import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const LOW_SIGNAL_TOKENS = new Set([
  'a',
  'an',
  'and',
  'as',
  'async',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'interface',
  'let',
  'lines',
  'new',
  'null',
  'number',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'string',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'undefined',
  'var',
  'void',
  'while',
]);

export function selectRelevantContext(options: ContextRankerOptions): AdditionalFileContext[] {
  if (options.maxChars <= 0 || options.candidates.length === 0) {
    return [];
  }

  const prefixTokens = tokenize(options.currentFilePrefix);
  const now = Date.now();
  const windows = options.candidates.flatMap((candidate) => buildWindows(candidate));

  if (windows.length === 0) {
    return [];
  }

  const scoredWindows = windows
    .map((window) => ({
      ...window,
      score: scoreWindow(
        window,
        prefixTokens,
        options.currentFilePath,
        now,
        options.currentSymbol,
        options.importPaths
      ),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.path !== right.path) {
        return left.path.localeCompare(right.path);
      }
      return (left.startLine ?? 0) - (right.startLine ?? 0);
    });

  return collectWindowsWithinBudget(scoredWindows, options.maxChars);
}

function buildWindows(candidate: ContextRankerCandidate): ContextWindow[] {
  const windows: ContextWindow[] = [];

  for (const section of candidate.sections) {
    const normalizedContent = section.content.replace(/\r\n?/g, '\n').trim();
    if (!normalizedContent) {
      continue;
    }

    const lines = normalizedContent.split('\n');
    let startIndex = 0;

    while (startIndex < lines.length) {
      let endIndex = startIndex;
      let charCount = 0;

      while (endIndex < lines.length && endIndex - startIndex < WINDOW_MAX_LINES) {
        const line = lines[endIndex];
        const nextCharCount = charCount + line.length + (endIndex > startIndex ? 1 : 0);

        if (endIndex > startIndex && nextCharCount > WINDOW_MAX_CHARS) {
          break;
        }

        charCount = nextCharCount;
        endIndex += 1;
      }

      if (endIndex === startIndex) {
        endIndex = Math.min(startIndex + 1, lines.length);
      }

      const windowLines = lines.slice(startIndex, endIndex);
      const content = windowLines.join('\n').trim();
      if (content) {
        const startLine =
          typeof section.startLine === 'number' ? section.startLine + startIndex : undefined;
        const endLine =
          typeof startLine === 'number' ? startLine + windowLines.length - 1 : section.endLine;

        windows.push({
          path: candidate.path,
          content,
          origin: candidate.origin,
          isOpen: candidate.isOpen ?? false,
          lastViewedAt: candidate.lastViewedAt,
          startLine,
          endLine,
          tokenSet: tokenize(content),
        });
      }

      if (endIndex >= lines.length) {
        break;
      }

      startIndex = Math.max(startIndex + 1, endIndex - WINDOW_OVERLAP_LINES);
    }
  }

  return windows;
}

function collectWindowsWithinBudget(
  windows: ScoredContextWindow[],
  maxChars: number
): AdditionalFileContext[] {
  const selectedByPath = new Map<string, SelectedWindow[]>();
  let usedChars = 0;

  for (const window of windows) {
    const selectedForPath = selectedByPath.get(window.path) ?? [];
    if (selectedForPath.length >= MAX_WINDOWS_PER_FILE) {
      continue;
    }

    if (selectedForPath.some((selected) => overlapsSameRegion(selected.window, window))) {
      continue;
    }

    const formattedContent = formatWindowContent(window);
    if (!formattedContent) {
      continue;
    }

    const additionalCost =
      formattedContent.length +
      (selectedForPath.length === 0 ? window.path.length + CONTEXT_FILE_OVERHEAD : 2);

    if (usedChars + additionalCost > maxChars) {
      if (selectedByPath.size > 0 || selectedForPath.length > 0) {
        continue;
      }

      const remainingChars = Math.max(maxChars - window.path.length - CONTEXT_FILE_OVERHEAD, 0);
      const truncatedContent = truncateText(formattedContent, remainingChars);
      if (!truncatedContent) {
        continue;
      }

      selectedByPath.set(window.path, [{ window, formattedContent: truncatedContent }]);
      break;
    }

    selectedByPath.set(window.path, [...selectedForPath, { window, formattedContent }]);
    usedChars += additionalCost;
  }

  return [...selectedByPath.entries()].map(([path, selectedWindows]) => ({
    path,
    content: selectedWindows.map((selected) => selected.formattedContent).join('\n\n'),
  }));
}

function formatWindowContent(window: Pick<ContextWindow, 'content' | 'startLine' | 'endLine'>): string {
  const normalizedContent = window.content.trim();
  if (!normalizedContent) {
    return '';
  }

  if (typeof window.startLine === 'number') {
    const endLine = typeof window.endLine === 'number' ? window.endLine : window.startLine;
    const lineLabel = window.startLine === endLine
      ? `${window.startLine}`
      : `${window.startLine}-${endLine}`;
    return `lines ${lineLabel}\n${normalizedContent}`;
  }

  return normalizedContent;
}

function scoreWindow(
  window: ContextWindow,
  prefixTokens: Set<string>,
  currentFilePath: string,
  now: number,
  currentSymbol?: string,
  importPaths?: string[]
): number {
  const overlapCount = countTokenOverlap(prefixTokens, window.tokenSet);
  const unionSize = prefixTokens.size + window.tokenSet.size - overlapCount;
  const jaccardScore = unionSize > 0 ? overlapCount / unionSize : 0;
  const overlapBoost = Math.min(overlapCount, 8) * 0.02;
  const structuralBoost =
    getPathBoost(currentFilePath, window.path) +
    (window.origin === 'lsp' ? 0.12 : 0) +
    (window.isOpen ? 0.05 : 0) +
    getRecencyBoost(window.lastViewedAt, now);
  const importBoost = Math.min(
    extractImportSpecifiers(window.content).filter((candidateImport) =>
      matchImportPath(candidateImport, importPaths ?? [])
    ).length * 0.08,
    0.16
  );
  const normalizedCurrentSymbol = currentSymbol?.trim().toLowerCase();
  const symbolBoost = normalizedCurrentSymbol && window.tokenSet.has(normalizedCurrentSymbol)
    ? 0.1
    : 0;

  if (overlapCount === 0 && prefixTokens.size > 0) {
    return structuralBoost * 0.5 + importBoost + symbolBoost;
  }

  return jaccardScore + overlapBoost + structuralBoost + importBoost + symbolBoost;
}

function extractImportSpecifiers(content: string): string[] {
  const pattern = new RegExp(IMPORT_SPECIFIER_PATTERN);
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const specifier = (match[1] ?? match[2] ?? '').trim();
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function matchImportPath(candidateImport: string, currentImports: string[]): boolean {
  const candidateParts = splitPath(candidateImport);
  if (candidateParts.length === 0 || currentImports.length === 0) {
    return false;
  }

  const candidateBasename = getImportBasename(candidateParts);

  return currentImports.some((currentImport) => {
    const currentParts = splitPath(currentImport);
    if (currentParts.length === 0) {
      return false;
    }

    if (hasPathSuffix(candidateParts, currentParts) || hasPathSuffix(currentParts, candidateParts)) {
      return true;
    }

    return candidateBasename.length > 0 && candidateBasename === getImportBasename(currentParts);
  });
}

function getImportBasename(parts: string[]): string {
  const basename = parts[parts.length - 1] ?? '';
  return basename.replace(/\.(?:d\.)?(?:[cm]?[jt]sx?)$/, '');
}

function hasPathSuffix(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0 || left.length > right.length) {
    return false;
  }

  const offset = right.length - left.length;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[offset + index]) {
      return false;
    }
  }

  return true;
}

function countTokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;

  for (const token of smaller) {
    if (larger.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  const tokens = matches.filter((token) => token.length > 1 && !LOW_SIGNAL_TOKENS.has(token));
  return new Set(tokens.slice(-256));
}

function getPathBoost(currentFilePath: string, candidatePath: string): number {
  const currentParts = splitPath(currentFilePath);
  const candidateParts = splitPath(candidatePath);

  if (currentParts.length === 0 || candidateParts.length === 0) {
    return 0;
  }

  const currentDirectories = currentParts.slice(0, -1);
  const candidateDirectories = candidateParts.slice(0, -1);
  const sameDirectory = currentDirectories.join('/') === candidateDirectories.join('/');
  const commonPrefixLength = countCommonPrefix(currentDirectories, candidateDirectories);

  let boost = Math.min(commonPrefixLength, 4) * 0.03;
  if (sameDirectory) {
    boost += 0.12;
  }

  if (currentParts[currentParts.length - 1] === candidateParts[candidateParts.length - 1]) {
    boost += 0.04;
  }

  return boost;
}

function splitPath(path: string): string[] {
  return path
    .split(/[\\/]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function countCommonPrefix(left: string[], right: string[]): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function getRecencyBoost(lastViewedAt: number | undefined, now: number): number {
  if (typeof lastViewedAt !== 'number') {
    return 0;
  }

  const ageMs = Math.max(now - lastViewedAt, 0);
  const maxAgeMs = 10 * 60 * 1000;
  const freshness = Math.max(0, 1 - ageMs / maxAgeMs);
  return freshness * 0.04;
}

function overlapsSameRegion(left: ContextWindow, right: ContextWindow): boolean {
  if (
    typeof left.startLine !== 'number' ||
    typeof left.endLine !== 'number' ||
    typeof right.startLine !== 'number' ||
    typeof right.endLine !== 'number'
  ) {
    return false;
  }

  const overlap = Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine) + 1;
  if (overlap <= 0) {
    return false;
  }

  const leftLength = left.endLine - left.startLine + 1;
  const rightLength = right.endLine - right.startLine + 1;
  return overlap / Math.min(leftLength, rightLength) >= 0.5;
}

function truncateText(text: string, maxChars: number): string {
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
