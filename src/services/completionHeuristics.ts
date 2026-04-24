import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';

export enum HeuristicType {
  DUPLICATING_LINE_AFTER_SUGGESTION = 'duplicating_line_after_suggestion',
  REVERTING_USER_CHANGE = 'reverting_user_change',
  OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED = 'output_extends_beyond_range_and_is_repeated',
}

export interface ValidationResult {
  valid: boolean;
  isInvalidBecauseNoOp?: boolean;
  modelOutputText: string;
  invalidReason?: string;
}

export interface HeuristicsConfig {
  maxFileSize: number;
  showWhitespaceOnlyChanges: boolean;
  enabledHeuristics: HeuristicType[];
}

const DEFAULT_CONFIG: HeuristicsConfig = {
  maxFileSize: 1_000_000,
  showWhitespaceOnlyChanges: false,
  enabledHeuristics: [
    HeuristicType.DUPLICATING_LINE_AFTER_SUGGESTION,
    HeuristicType.OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED,
  ],
};

export class CompletionHeuristicsService implements vscode.Disposable {
  private config: HeuristicsConfig;

  constructor(
    private readonly logger: ILogger,
    config?: Partial<HeuristicsConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  dispose(): void {}

  updateConfig(config: Partial<HeuristicsConfig>): void {
    this.config = { ...this.config, ...config };
  }

  isValidCompletion(
    document: vscode.TextDocument,
    startLineNumber: number,
    endLineNumberInclusive: number,
    modelOutputText: string
  ): ValidationResult {
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const documentText = document.getText();

    if (documentText.length >= this.config.maxFileSize) {
      return { valid: true, modelOutputText };
    }

    const originalRange = new vscode.Range(
      new vscode.Position(startLineNumber - 1, 0),
      new vscode.Position(endLineNumberInclusive - 1, document.lineAt(endLineNumberInclusive - 1).text.length)
    );
    const originalText = document.getText(originalRange);

    const isNoOp = originalText.trim() === modelOutputText.trim();
    if (isNoOp) {
      this.logger.info('[Heuristics] Invalid: noOp (output equals input)');
      return { valid: false, isInvalidBecauseNoOp: true, modelOutputText, invalidReason: 'noOp' };
    }

    if (!this.config.showWhitespaceOnlyChanges) {
      const originalNonWs = originalText.replace(/\s/g, '');
      const outputNonWs = modelOutputText.replace(/\s/g, '');
      if (originalNonWs === outputNonWs && originalText !== modelOutputText) {
        this.logger.info('[Heuristics] Invalid: whitespace-only changes');
        return { valid: false, isInvalidBecauseNoOp: false, modelOutputText, invalidReason: 'whitespaceOnly' };
      }
    }

    const outputLines = modelOutputText.split(eol);
    const documentLines = documentText.split(eol);

    if (
      this.config.enabledHeuristics.includes(HeuristicType.DUPLICATING_LINE_AFTER_SUGGESTION) &&
      outputLines.length >= 2
    ) {
      const lastOutputLine = outputLines[outputLines.length - 1];
      const lineAfterSuggestion = documentLines[endLineNumberInclusive];

      if (
        lineAfterSuggestion !== undefined &&
        lastOutputLine !== undefined &&
        lastOutputLine.trim() !== '' &&
        lineAfterSuggestion.trim() !== '' &&
        lastOutputLine === lineAfterSuggestion &&
        lastOutputLine.trim() !== '}' &&
        lineAfterSuggestion.trim() !== ']'
      ) {
        this.logger.info('[Heuristics] Invalid: duplicating line after suggestion range');
        return { valid: false, isInvalidBecauseNoOp: false, modelOutputText, invalidReason: 'duplicatingLine' };
      }
    }

    if (
      this.config.enabledHeuristics.includes(HeuristicType.OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED) &&
      outputLines.length > 1
    ) {
      const comparisonLines = documentLines.slice(startLineNumber - 1);
      let allSame = true;

      for (let i = 0; i < outputLines.length; i++) {
        if (i === outputLines.length - 1 && outputLines[i] === '') { continue; }

        if (outputLines[i] === undefined || comparisonLines[i] === undefined) {
          allSame = false;
          break;
        }
        if (outputLines[i].trim() !== comparisonLines[i].trim()) {
          allSame = false;
          break;
        }
      }

      if (allSame) {
        this.logger.info('[Heuristics] Invalid: output extends beyond range but is all same content');
        return { valid: false, isInvalidBecauseNoOp: false, modelOutputText, invalidReason: 'repeatedContent' };
      }
    }

    return { valid: true, modelOutputText };
  }
}
