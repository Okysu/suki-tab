import * as vscode from 'vscode';
import { Logger } from './logger';

export enum DebugCategory {
  Stream = 'stream',
  EditCombine = 'editCombine',
  Http = 'http',
  Debounce = 'debounce',
  Telemetry = 'telemetry',
  Provider = 'provider',
  DocTracker = 'docTracker',
}

export interface DebugLoggerConfig {
  enabled: boolean;
  categories: Partial<Record<DebugCategory, boolean>>;
  verbosePayloads: boolean;
  maxPayloadLength: number;
}

const DEFAULT_CONFIG: DebugLoggerConfig = {
  enabled: true,
  categories: {
    [DebugCategory.Stream]: true,
    [DebugCategory.EditCombine]: true,
    [DebugCategory.Http]: true,
    [DebugCategory.Debounce]: true,
    [DebugCategory.Telemetry]: true,
    [DebugCategory.Provider]: false,
    [DebugCategory.DocTracker]: false,
  },
  verbosePayloads: false,
  maxPayloadLength: 500,
};

export class DebugLogger {
  private static instance: DebugLogger | undefined;
  private config: DebugLoggerConfig;

  private constructor(private readonly baseLogger: { info: (msg: string) => void; error: (msg: string) => void }) {
    this.config = { ...DEFAULT_CONFIG };
  }

  static getInstance(baseLogger?: { info: (msg: string) => void; error: (msg: string) => void }): DebugLogger {
    if (!DebugLogger.instance) {
      if (!baseLogger) {
        throw new Error('DebugLogger must be initialized with a base logger');
      }
      DebugLogger.instance = new DebugLogger(baseLogger);
    }
    return DebugLogger.instance;
  }

  getOutputChannel(): vscode.OutputChannel {
    return Logger.getSharedChannel();
  }

  configure(config: Partial<DebugLoggerConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.categories) {
      this.config.categories = { ...this.config.categories, ...config.categories };
    }
  }

  setCategory(category: DebugCategory, enabled: boolean): void {
    this.config.categories[category] = enabled;
  }

  isCategoryEnabled(category: DebugCategory): boolean {
    return this.config.enabled && (this.config.categories[category] ?? false);
  }

  log(category: DebugCategory, message: string, data?: any): void {
    if (!this.isCategoryEnabled(category)) {
      return;
    }

    const prefix = `[DEBUG:${category}]`;
    let fullMessage = `${prefix} ${message}`;

    if (data !== undefined) {
      const dataStr = this.formatData(data);
      fullMessage += ` ${dataStr}`;
    }

    this.baseLogger.info(fullMessage);

    if (this.config.verbosePayloads) {
      Logger.getSharedChannel().appendLine(fullMessage);
    }
  }

  error(category: DebugCategory, message: string, error?: any): void {
    if (!this.config.enabled) {
      return;
    }

    const prefix = `[DEBUG:${category}:ERROR]`;
    let fullMessage = `${prefix} ${message}`;

    if (error !== undefined) {
      fullMessage += ` :: ${error?.message ?? String(error)}`;
    }

    this.baseLogger.error(fullMessage);
  }

  private formatData(data: any): string {
    try {
      const jsonStr = JSON.stringify(data);
      if (this.config.verbosePayloads || jsonStr.length <= this.config.maxPayloadLength) {
        return jsonStr;
      }
      return jsonStr.slice(0, this.config.maxPayloadLength) + '...[truncated]';
    } catch {
      return String(data);
    }
  }

  logSseChunk(chunkIndex: number, text: string, requestId: string): void {
    if (!this.isCategoryEnabled(DebugCategory.Stream)) {
      return;
    }

    const textPreview = text.length > 50 ? text.slice(0, 50) + '...' : text;
    this.log(DebugCategory.Stream,
      `Chunk #${chunkIndex} [${requestId.slice(0, 8)}] len=${text.length}`,
      { text: textPreview.replace(/\n/g, '\\n') }
    );
  }

  logCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    surroundingLines: number = 3
  ): void {
    if (!this.isCategoryEnabled(DebugCategory.Provider)) {
      return;
    }

    const startLine = Math.max(0, position.line - surroundingLines);
    const endLine = Math.min(document.lineCount - 1, position.line + surroundingLines);

    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const line = document.lineAt(i);
      const prefix = i === position.line ? '>>>' : '   ';
      const cursor = i === position.line
        ? `${' '.repeat(position.character)}^`
        : '';
      lines.push(`${prefix} ${i + 1}: ${line.text}`);
      if (cursor) {
        lines.push(`    ${cursor}`);
      }
    }

    this.log(DebugCategory.Provider,
      `Completion context at ${document.fileName}:${position.line + 1}:${position.character + 1}:\n${lines.join('\n')}`
    );
  }
}

export function getDebugLogger(): DebugLogger {
  return DebugLogger.getInstance();
}
