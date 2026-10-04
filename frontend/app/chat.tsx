'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchInfo, resetConversation, streamChat, type AgentInfo } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import styles from './chat.module.css';

interface Step {
  name: string;
  args: string;
}

interface Turn {
  id: string;
  question: string;
  steps: Step[];
  answer: string;
  error?: { message: string; hint?: string };
  done: boolean;
}

const SUGGESTIONS = [
  '¿Qué hora es en Tokio?',
  '¿Qué tablas hay en la base de datos?',
  'Recuerda que prefiero los precios en EUR/MWh',
];

/** Un id por pestaña: cada una es una conversación distinta en el servidor. */
function useSessionId(): string {
  const [id, setId] = useState('');

  useEffect(() => {
    const existing = sessionStorage.getItem('agente-session');
    if (existing) {
      setId(existing);
      return;
    }
    const fresh = crypto.randomUUID();
    sessionStorage.setItem('agente-session', fresh);
    setId(fresh);
  }, []);

  return id;
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ')}`)
    .join(', ');
}

export default function Chat() {
  const sessionId = useSessionId();
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchInfo(controller.signal)
      .then(setInfo)
      .catch(() => setInfo(null));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const send = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy || !sessionId) return;

      const id = crypto.randomUUID();
      setDraft('');
      setBusy(true);
      setTurns(previous => [...previous, { id, question: text, steps: [], answer: '', done: false }]);

      const update = (patch: (turn: Turn) => Turn) =>
        setTurns(previous => previous.map(turn => (turn.id === id ? patch(turn) : turn)));

      try {
        for await (const event of streamChat(sessionId, text)) {
          switch (event.type) {
            case 'tool_call':
              update(turn => ({
                ...turn,
                steps: [...turn.steps, { name: event.name, args: formatArgs(event.args) }],
              }));
              break;
            case 'answer':
              update(turn => ({ ...turn, answer: event.text }));
              break;
            case 'error':
              update(turn => ({
                ...turn,
                error: { message: event.message, ...(event.hint ? { hint: event.hint } : {}) },
              }));
              break;
            case 'done':
              update(turn => ({ ...turn, done: true }));
              break;
            default:
              break;
          }
        }
      } catch (error) {
        update(turn => ({
          ...turn,
          error: {
            message: 'No se ha podido contactar con el agente.',
            hint: error instanceof Error ? error.message : String(error),
          },
        }));
      } finally {
        update(turn => ({ ...turn, done: true }));
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, sessionId],
  );

  const startOver = useCallback(async () => {
    if (busy || !sessionId) return;
    await resetConversation(sessionId);
    setTurns([]);
    inputRef.current?.focus();
  }, [busy, sessionId]);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.title}>Agente</span>
        <div className={styles.meta}>
          {info ? (
            <>
              <span className={styles.badge}>{info.model}</span>
              <span className={styles.badge}>
                {info.tools.length} herramienta{info.tools.length === 1 ? '' : 's'}
              </span>
              {info.database && (
                <span
                  className={`${styles.badge} ${info.database.connected ? '' : styles.badgeOff}`}
                  title={info.database.target}
                >
                  {info.database.connected ? 'base de datos' : 'base de datos no disponible'}
                </span>
              )}
            </>
          ) : (
            <span className={`${styles.badge} ${styles.badgeOff}`}>API no disponible</span>
          )}
          <button className={styles.reset} onClick={startOver} disabled={busy || turns.length === 0}>
            Nueva conversación
          </button>
        </div>
      </header>

      <main className={styles.messages}>
        {turns.length === 0 && (
          <div className={styles.empty}>
            <h2>¿En qué te ayudo?</h2>
            <p>
              Puedo consultar la base de datos, recordar cosas entre sesiones y buscar en internet.
            </p>
            <div className={styles.suggestions}>
              {SUGGESTIONS.map(suggestion => (
                <button key={suggestion} className={styles.suggestion} onClick={() => send(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map(turn => (
          <div key={turn.id} className={styles.turn}>
            <div className={styles.user}>{turn.question}</div>

            {turn.steps.length > 0 && (
              <div className={styles.steps}>
                {turn.steps.map((step, index) => (
                  <div key={`${step.name}-${index}`} className={styles.step}>
                    <span className={styles.stepName}>{step.name}</span>
                    <span className={styles.stepArgs}>{step.args}</span>
                  </div>
                ))}
              </div>
            )}

            {!turn.done && !turn.error && (
              <span className={styles.working}>
                <span className={styles.dot} />
                Pensando…
              </span>
            )}

            {turn.error && (
              <div className={styles.error}>
                {turn.error.message}
                {turn.error.hint && <div className={styles.errorHint}>{turn.error.hint}</div>}
              </div>
            )}

            {turn.answer && <div className={styles.assistant}>{renderMarkdown(turn.answer)}</div>}
          </div>
        ))}

        <div ref={bottomRef} />
      </main>

      <form
        className={styles.composer}
        onSubmit={event => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className={styles.inputRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            value={draft}
            placeholder="Pregunta lo que quieras…"
            disabled={!sessionId}
            onChange={event => {
              setDraft(event.target.value);
              // Crece con el contenido, hasta el máximo que fija el CSS.
              event.target.style.height = 'auto';
              event.target.style.height = `${event.target.scrollHeight}px`;
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button className={styles.send} type="submit" disabled={busy || !draft.trim()}>
            Enviar
          </button>
        </div>
        <div className={styles.hint}>Enter envía · Shift+Enter salta de línea</div>
      </form>
    </div>
  );
}
