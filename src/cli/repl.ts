import { createInterface } from 'node:readline/promises';
import type { ToolCallingAgent } from 'smolagents.js';
import { refreshInstructions } from '../agents/sql-agent';
import { runAgentTurn } from '../agents/turn';
import type { Runtime } from '../runtime';
import { describeError } from '../utils/errors';
import { handleCommand } from './commands';
import {
  USER_PROMPT,
  banner,
  line,
  note,
  renderError,
  renderToolCall,
} from './render';

/** Un turno del agente, pintado en la consola segun va ocurriendo. */
async function renderTurn(
  runtime: Runtime,
  agent: ToolCallingAgent,
  input: string,
  debug: boolean,
): Promise<void> {
  let answer = '';

  for await (const event of runAgentTurn({ ...runtime, agent }, input)) {
    switch (event.type) {
      case 'tool_call':
        renderToolCall(event.name, event.args);
        break;
      case 'tool_output':
        if (debug) note(`  ${event.text.split('\n')[0]?.slice(0, 160) ?? ''}`);
        break;
      case 'thinking':
        if (debug) process.stdout.write(event.text);
        break;
      case 'answer':
        answer = event.text;
        break;
    }
  }

  line(answer.trim() ? answer : 'El agente ha terminado sin respuesta.');
}

export async function runRepl(runtime: Runtime): Promise<void> {
  const { config, tools, store, schemaSummary } = runtime;
  const debug = config.logLevel === 'debug';
  const agent = runtime.newAgent();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: USER_PROMPT,
  });

  let interrupted = false;
  rl.on('SIGINT', () => {
    interrupted = true;
    rl.close();
  });

  // El catalogo solo esta si la base respondio al arrancar.
  line(banner(config, tools.length, schemaSummary !== undefined));
  rl.prompt();

  // El iterador asincrono pausa la entrada mientras se procesa cada turno,
  // asi que funciona igual en un TTY que con la entrada canalizada.
  for await (const raw of rl) {
    const input = raw.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    const command = handleCommand(input, { config, agent, tools, store });
    if (command.exit) break;
    if (command.handled) {
      // Un comando puede haber borrado una memoria fija.
      if (command.memoriesChanged) {
        refreshInstructions(agent, { schemaSummary, pinned: store.listPinned() });
      }
      line();
      rl.prompt();
      continue;
    }

    try {
      await renderTurn(runtime, agent, input, debug);
    } catch (error) {
      line();
      renderError(describeError(error, config.model));
      if (debug && error instanceof Error && error.stack) note(error.stack);
    }

    line();
    rl.prompt();
  }

  rl.close();
  line(interrupted ? '' : 'Hasta luego.');
}
