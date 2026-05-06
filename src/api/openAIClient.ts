import {
  ApiType,
  CompletionRequest,
  ConnectionTestResult,
  FlushResult,
  ProviderConfig,
  SSEEvent,
} from '../context/types';
import { ILLMClient } from '../context/contracts';
import { parseSSEStream } from './sseParser';

type ChatMessage = {
  role: 'system' | 'user';
  content: string;
};

type StreamState = {
  buffer: string;
  done: boolean;
  error?: string;
  abortController: AbortController;
};

const DEFAULT_SYSTEM_PROMPT =
  'You are an expert code completion assistant. Continue the code at the cursor position. Output ONLY the code to insert, no explanations or markdown.';

const DEFAULT_CHAT_STOP_TOKENS: string[] = [];

export class OpenAIClient implements ILLMClient {
  private provider: ProviderConfig;
  private readonly streams = new Map<string, StreamState>();

  constructor(provider: ProviderConfig) {
    this.provider = provider;
  }

  async streamCompletion(request: CompletionRequest, requestId: string, externalSignal?: AbortSignal): Promise<void> {
    this.cancelCompletion(requestId);

    const provider = { ...this.provider };
    const abortController = new AbortController();
    const streamState: StreamState = {
      buffer: '',
      done: false,
      abortController,
    };

    // Forward external abort to our internal controller
    if (externalSignal) {
      if (externalSignal.aborted) {
        streamState.done = true;
        this.streams.set(requestId, streamState);
        return;
      }
      externalSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    this.streams.set(requestId, streamState);

    try {
      const response = await fetch(this.getRequestUrl(provider.apiType, provider.baseUrl), {
        method: 'POST',
        headers: this.buildHeaders(provider),
        body: JSON.stringify(this.buildStreamBody(provider, request)),
        signal: abortController.signal,
      });

      if (!response.ok) {
        streamState.error = await this.readErrorResponse(response);
        streamState.done = true;
        return;
      }

      if (!response.body) {
        streamState.error = 'API response did not include a readable stream.';
        streamState.done = true;
        return;
      }

      void this.consumeStream(response, requestId, provider.apiType);
    } catch (error) {
      if (abortController.signal.aborted) {
        streamState.done = true;
        return;
      }

      streamState.error = this.getErrorMessage(error);
      streamState.done = true;
    }
  }

  async flushCompletion(requestId: string): Promise<FlushResult> {
    const state = this.streams.get(requestId);
    if (!state) {
      return { type: 'failure', reason: 'Stream not found.' };
    }

    if (state.error) {
      this.streams.delete(requestId);
      return { type: 'failure', reason: state.error };
    }

    const text = state.buffer;
    state.buffer = '';

    if (state.done) {
      this.streams.delete(requestId);
    }

    return {
      type: 'success',
      text,
      done: state.done,
    };
  }

  cancelCompletion(requestId: string): void {
    const state = this.streams.get(requestId);
    if (!state) {
      return;
    }

    state.done = true;
    state.abortController.abort();
    this.streams.delete(requestId);
  }

  updateProvider(provider: ProviderConfig): void {
    this.provider = provider;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const provider = { ...this.provider };
    const startedAt = performance.now();

    try {
      const response = await fetch(this.getRequestUrl(provider.apiType, provider.baseUrl), {
        method: 'POST',
        headers: this.buildHeaders(provider),
        body: JSON.stringify(this.buildConnectionTestBody(provider)),
      });

      const latencyMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        return {
          success: false,
          message: await this.readErrorResponse(response),
          latencyMs,
        };
      }

      const responseJson = await this.readJsonBody(response);
      const modelInfo = this.extractModelInfo(responseJson) ?? provider.model;

      return {
        success: true,
        message: 'Connection successful.',
        latencyMs,
        modelInfo,
      };
    } catch (error) {
      return {
        success: false,
        message: this.getErrorMessage(error),
      };
    }
  }

  dispose(): void {
    for (const state of this.streams.values()) {
      state.abortController.abort();
    }

    this.streams.clear();
  }

  private async consumeStream(
    response: Response,
    requestId: string,
    apiType: ApiType,
  ): Promise<void> {
    const state = this.streams.get(requestId);
    if (!state) {
      return;
    }

    try {
      for await (const event of parseSSEStream(response, apiType)) {
        const streamState = this.streams.get(requestId);
        if (!streamState) {
          return;
        }

        const sseEvent: SSEEvent = event;
        if (sseEvent.type === 'text') {
          streamState.buffer += sseEvent.content;
          continue;
        }

        if (sseEvent.type === 'error') {
          streamState.error = sseEvent.message;
          streamState.done = true;
          return;
        }

        if (sseEvent.type === 'done') {
          streamState.done = true;
          return;
        }
      }
    } catch (error) {
      const streamState = this.streams.get(requestId);
      if (!streamState) {
        return;
      }

      if (streamState.abortController.signal.aborted) {
        streamState.done = true;
        return;
      }

      streamState.error = this.getErrorMessage(error);
      streamState.done = true;
    }
  }

  private buildStreamBody(provider: ProviderConfig, request: CompletionRequest): object {
    if (provider.apiType === 'completions') {
      return {
        model: provider.model,
        prompt: request.prefix,
        suffix: request.suffix,
        max_tokens: provider.maxTokens,
        temperature: provider.temperature,
        ...(provider.stopTokens.length > 0 ? { stop: provider.stopTokens } : {}),
        stream: true,
        ...provider.extraBody,
      };
    }

    return {
      model: provider.model,
      messages: this.buildFIMMessages(request, provider),
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      ...(provider.stopTokens.length > 0
        ? { stop: this.mergeStopTokens(provider.stopTokens, this.getFIMStopTokens(provider)) }
        : {}),
      stream: true,
      ...provider.extraBody,
    };
  }

  private buildConnectionTestBody(provider: ProviderConfig): object {
    if (provider.apiType === 'completions') {
      return {
        model: provider.model,
        prompt: 'x',
        suffix: '',
        max_tokens: 1,
        temperature: provider.temperature,
        stop: provider.stopTokens,
        stream: false,
      };
    }

    return {
      model: provider.model,
      messages: this.buildConnectionTestMessages(provider),
      max_tokens: 1,
      temperature: provider.temperature,
      stop: this.mergeStopTokens(provider.stopTokens, this.getFIMStopTokens(provider)),
      stream: false,
    };
  }

  private buildConnectionTestMessages(provider: ProviderConfig): ChatMessage[] {
    const content = provider.fimTemplate
      ? this.applyFIMTemplate(provider.fimTemplate, {
          prefix: 'x',
          suffix: '',
          language: 'plaintext',
          filename: 'connection-test.txt',
        })
      : this.buildDefaultFIMPrompt({
          prefix: 'x',
          suffix: '',
          language: 'plaintext',
          filename: 'connection-test.txt',
          additionalFiles: [],
          diagnostics: '',
        });

    return [
      {
        role: 'system',
        content: provider.customPrompt || DEFAULT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content,
      },
    ];
  }

  private buildFIMMessages(request: CompletionRequest, provider: ProviderConfig): ChatMessage[] {
    const content = provider.fimTemplate
      ? this.applyFIMTemplate(provider.fimTemplate, {
          prefix: request.prefix,
          suffix: request.suffix,
          language: request.language,
          filename: request.filename,
        })
      : this.buildDefaultFIMPrompt(request);

    return [
      {
        role: 'system',
        content: provider.customPrompt || DEFAULT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content,
      },
    ];
  }

  private buildDefaultFIMPrompt(request: {
    prefix: string;
    suffix: string;
    language: string;
    filename: string;
    additionalFiles: Array<{ path: string; content: string }>;
    diagnostics: string;
  }): string {
    const sections: string[] = [
      'You are a code completion assistant. Fill in the missing code at the cursor position marked by <cursor/>.',
      `<language>${request.language || 'unknown'}</language>`,
      `<filename>${request.filename || 'unknown'}</filename>`,
    ];

    if (request.additionalFiles.length > 0) {
      const files = request.additionalFiles
        .map(
          (file) =>
            `<context_file path="${file.path}">\n${file.content}\n</context_file>`
        )
        .join('\n\n');
      sections.push(`<context>\n${files}\n</context>`);
    }

    if (request.diagnostics.trim().length > 0) {
      sections.push(`<diagnostics>\n${request.diagnostics}\n</diagnostics>`);
    }

    sections.push(
      '<code_context>',
      '<prefix>',
      request.prefix,
      '<cursor/>',
      '</prefix>',
      '<suffix>',
      request.suffix,
      '</suffix>',
      '</code_context>',
      'Return ONLY the code that should be inserted at the <cursor/> position. Do not repeat any code from the prefix or suffix. Do not add explanations or markdown formatting.',
    );

    return sections.join('\n\n');
  }

  private getFIMStopTokens(provider: ProviderConfig): string[] {
    if (!provider.fimTemplate) {
      return DEFAULT_CHAT_STOP_TOKENS;
    }

    const controlTokens = provider.fimTemplate.match(/<[^>\s]+>|\[[^\]\s]+\]/g) ?? [];
    const uniqueControlTokens = Array.from(new Set(controlTokens.filter((token) => token.trim().length > 0)));
    return uniqueControlTokens.length > 0 ? uniqueControlTokens : DEFAULT_CHAT_STOP_TOKENS;
  }

  private applyFIMTemplate(
    template: string,
    values: { prefix: string; suffix: string; language: string; filename: string },
  ): string {
    let result = template;

    for (const [placeholder, value] of Object.entries({
      '{prefix}': values.prefix,
      '{suffix}': values.suffix,
      '{language}': values.language,
      '{filename}': values.filename,
    })) {
      result = result.split(placeholder).join(value);
    }

    return result;
  }

  private mergeStopTokens(primary: string[], secondary: string[]): string[] {
    return Array.from(new Set([...primary, ...secondary]));
  }

  private getRequestUrl(apiType: ApiType, baseUrl: string): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    return apiType === 'completions'
      ? `${normalizedBaseUrl}/completions`
      : `${normalizedBaseUrl}/chat/completions`;
  }

  private buildHeaders(provider: ProviderConfig): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    };
  }

  private async readErrorResponse(response: Response): Promise<string> {
    const responseText = await response.text();
    if (!responseText.trim()) {
      return `Request failed with status ${response.status} ${response.statusText}.`;
    }

    try {
      const parsed = JSON.parse(responseText) as {
        error?: { message?: string };
        message?: string;
      };
      return parsed.error?.message || parsed.message || responseText;
    } catch {
      return responseText;
    }
  }

  private async readJsonBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private extractModelInfo(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const record = value as { model?: unknown };
    return typeof record.model === 'string' ? record.model : undefined;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
