/**
 * Cliente de la API del agente.
 *
 * El agente vive en un proceso Bun aparte (`bun run serve`), no dentro de Next:
 * usa `bun:sqlite` y `Bun.SQL`, que no existen en el runtime de Node.
 */
export const API_URL = process.env.NEXT_PUBLIC_AGENT_API ?? 'http://localhost:3001';

export interface ToolInfo {
  name: string;
  description: string;
}

export interface AgentInfo {
  model: string;
  provider: string;
  tools: ToolInfo[];
  database: { target: string; connected: boolean } | null;
  memories: number;
}

/** Eventos que emite el agente durante un turno. */
export type TurnEvent =
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_output'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'error'; message: string; hint?: string; retriable: boolean }
  | { type: 'done' };

export async function fetchInfo(signal?: AbortSignal): Promise<AgentInfo> {
  const response = await fetch(`${API_URL}/api/info`, { signal });
  if (!response.ok) throw new Error(`La API respondio ${response.status}`);
  return (await response.json()) as AgentInfo;
}

export async function resetConversation(sessionId: string): Promise<void> {
  await fetch(`${API_URL}/api/chat?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

/**
 * Lanza un turno y va entregando los eventos segun llegan.
 *
 * Se lee el SSE a mano en lugar de usar `EventSource` porque este necesita un
 * POST con cuerpo, y `EventSource` solo hace GET.
 */
export async function* streamChat(
  sessionId: string,
  message: string,
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
  const response = await fetch(`${API_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    let message = `La API respondio ${response.status}`;
    try {
      const parsed = JSON.parse(detail) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* el cuerpo no era JSON */
    }
    yield { type: 'error', message, retriable: response.status >= 500 };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Los eventos SSE se separan por linea en blanco; el ultimo trozo puede
    // llegar partido, asi que se queda en el buffer hasta completarse.
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const line = chunk.split('\n').find(part => part.startsWith('data: '));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(6)) as TurnEvent;
      } catch {
        /* trozo incompleto o comentario: se ignora */
      }
    }
  }
}
