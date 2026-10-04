import type { Tool, ToolCallingAgent } from 'smolagents.js';
import type { AppConfig } from '../config/types';
import type { MemoryStore } from '../memory/store';
import { formatMemory } from '../tools/memory';
import { color, info, line, note, renderConfig } from './render';

export interface CommandContext {
  config: AppConfig;
  agent: ToolCallingAgent;
  tools: Tool[];
  store: MemoryStore;
}

export interface CommandResult {
  /** true si la entrada era un comando y ya se ha procesado. */
  handled: boolean;
  /** true si hay que cerrar la REPL. */
  exit: boolean;
  /** true si el comando ha tocado las memorias fijas. */
  memoriesChanged?: boolean;
}

const COMMANDS: Array<[string, string]> = [
  ['/help', 'Muestra esta ayuda'],
  ['/clear', 'Olvida la conversacion actual (no toca la memoria permanente)'],
  ['/model', 'Muestra el modelo y los parametros activos'],
  ['/tools', 'Lista las herramientas disponibles'],
  ['/memories', 'Lista lo recordado. "/memories borrar <id>" elimina una'],
  ['/exit', 'Termina la sesion'],
];

function renderHelp(): void {
  const width = Math.max(...COMMANDS.map(([name]) => name.length));
  for (const [name, description] of COMMANDS) {
    line(`${color.cyan(name.padEnd(width))}  ${description}`);
  }
}

function renderTools(ctx: CommandContext): void {
  for (const tool of ctx.tools) {
    const args = Object.keys(tool.inputs);
    line(`${color.cyan(tool.name)}(${args.join(', ')})`);
    line(color.dim(`  ${tool.description}`));
  }
  if (!ctx.config.db) {
    line();
    note('Define DATABASE_URL en el .env para activar tambien las herramientas de Postgres.');
  }
}

/**
 * `/memories` y `/memories borrar <id>`.
 *
 * Existe para poder revisar y limpiar lo recordado sin pasar por el modelo: una
 * memoria equivocada contamina todas las respuestas siguientes, y no conviene
 * depender del agente para quitarla.
 */
function renderMemories(ctx: CommandContext, args: string[]): CommandResult {
  const [action, rawId] = args;

  if (action === 'borrar' || action === 'delete') {
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      note('Uso: /memories borrar <id>. El id sale al listar con /memories.');
      return { handled: true, exit: false };
    }
    const removed = ctx.store.remove(id);
    if (!removed) {
      note(`No hay ninguna memoria con id ${id}.`);
      return { handled: true, exit: false };
    }
    info(`Borrada: ${formatMemory(removed)}`);
    return { handled: true, exit: false, memoriesChanged: removed.pinned };
  }

  if (action) {
    note(`Subcomando desconocido: ${action}. Usa /memories o /memories borrar <id>.`);
    return { handled: true, exit: false };
  }

  const total = ctx.store.count();
  if (total === 0) {
    note('No hay nada recordado todavia. Dile "recuerda que..." al agente.');
    return { handled: true, exit: false };
  }

  const memories = ctx.store.listRecent(total);
  const pinned = memories.filter(memory => memory.pinned);
  const rest = memories.filter(memory => !memory.pinned);

  if (pinned.length > 0) {
    line(color.dim('fijas (se aplican siempre)'));
    for (const memory of pinned) line(`  ${formatMemory(memory)}`);
  }
  if (rest.length > 0) {
    if (pinned.length > 0) line();
    line(color.dim('recordadas (se recuperan cuando vienen al caso)'));
    for (const memory of rest) line(`  ${formatMemory(memory)}`);
  }

  return { handled: true, exit: false };
}

/**
 * Interpreta la entrada del usuario como comando.
 *
 * Si no empieza por `/`, devuelve `handled: false` y la REPL la trata como
 * mensaje para el modelo.
 */
export function handleCommand(input: string, ctx: CommandContext): CommandResult {
  if (!input.startsWith('/')) return { handled: false, exit: false };

  const [rawCommand, ...args] = input.trim().split(/\s+/);
  const command = rawCommand?.toLowerCase() ?? '';

  switch (command) {
    case '/help':
      renderHelp();
      return { handled: true, exit: false };

    case '/clear':
      // Solo la conversacion: lo guardado con remember sigue ahi.
      ctx.agent.memory.reset();
      info('Conversacion olvidada. La memoria permanente sigue intacta.');
      return { handled: true, exit: false };

    case '/model':
      renderConfig(ctx.config);
      return { handled: true, exit: false };

    case '/tools':
      renderTools(ctx);
      return { handled: true, exit: false };

    case '/memories':
      return renderMemories(ctx, args);

    case '/exit':
      return { handled: true, exit: true };

    default:
      note(`Comando desconocido: ${command}. Prueba /help.`);
      return { handled: true, exit: false };
  }
}
