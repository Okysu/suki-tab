import { ApiType, SSEEvent } from '../context/types';

export async function* parseSSEStream(
  response: Response,
  apiType: ApiType,
): AsyncGenerator<SSEEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      yield { type: 'done' };
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) {continue;}

      const data = trimmed.slice(6).trim();
      if (data === '[DONE]') {
        yield { type: 'done' };
        return;
      }

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      if (apiType === 'completions') {
        const text = json.choices?.[0]?.text;
        if (text) {
          yield { type: 'text', content: text };
        }
        if (json.choices?.[0]?.finish_reason === 'stop') {
          yield { type: 'done' };
          return;
        }
      } else {
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          yield { type: 'text', content: delta.content };
        }
        if (json.choices?.[0]?.finish_reason === 'stop') {
          yield { type: 'done' };
          return;
        }
        if (json.choices?.length === 0 && json.usage) {
          yield { type: 'done' };
          return;
        }
      }
    }
  }
}
