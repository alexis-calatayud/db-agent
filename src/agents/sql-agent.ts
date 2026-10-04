import { AgentLogger, LogLevel, ToolCallingAgent, type Model, type Tool } from 'smolagents.js';
import type { AppConfig } from '../config/types';
import type { Memory } from '../memory/store';
import { promptTemplates } from './prompts';

/**
 * Logger mudo para el agente.
 *
 * `verbosityLevel` no sirve: `AgentLogger.log()` escribe siempre, sin mirar
 * `this.level`. Lo que si respeta es el segundo parametro del constructor, que
 * sustituye el destino de la salida. Le pasamos un objeto que no hace nada,
 * porque la consola la pinta `cli/render.ts` y las dos a la vez se pisan.
 */
function silentLogger(): AgentLogger {
  const sink = {
    log: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  // El tipo declarado es winston.Logger, pero solo se usan log() e info().
  return new AgentLogger(LogLevel.OFF, sink as never);
}

/**
 * Agente ReAct que responde preguntas llamando a tools.
 *
 * `streamOutputs: false` a proposito: con streaming, smolagents monta un
 * `LiveBox` que mueve el cursor con `readline.moveCursor(process.stdout)` para
 * redibujarse, y eso se come las lineas que escribimos nosotros. Se pierde el
 * texto intermedio token a token, pero el progreso se ve igual porque
 * mostramos cada llamada a tool segun ocurre.
 */
export interface AgentContext {
  /**
   * Catalogo de tablas ya resuelto al arrancar. Va dentro del prompt de
   * sistema: sin el, los modelos pequenos se inventan tablas de
   * `information_schema` y queman pasos hasta agotarlos.
   */
  schemaSummary?: string | undefined;
  /** Memorias marcadas como fijas: se aplican a todas las preguntas. */
  pinned: Memory[];
}

/**
 * Compone la parte estable del prompt: catalogo de tablas y memorias fijas.
 *
 * Va en `instructions` y no en el texto de cada pregunta porque cambia poco
 * —solo al guardar o borrar una memoria fija—, y asi el prefijo del prompt se
 * mantiene igual entre turnos y la cache del proveedor sigue sirviendo.
 */
export function buildInstructions({ schemaSummary, pinned }: AgentContext): string | undefined {
  const blocks: string[] = [];

  if (pinned.length > 0) {
    blocks.push(
      'Preferencias y normas que el usuario ha pedido recordar. Aplicalas siempre, ' +
        'aunque la pregunta no las mencione:\n' +
        pinned.map(memory => `- ${memory.content}`).join('\n'),
    );
  }
  if (schemaSummary) blocks.push(schemaSummary);

  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

/**
 * Actualiza las memorias fijas de un agente ya en marcha.
 *
 * `run()` regenera el prompt de sistema a partir de `instructions` en cada
 * llamada, asi que basta con reasignarlo para que el turno siguiente lo vea.
 */
export function refreshInstructions(agent: ToolCallingAgent, context: AgentContext): void {
  const instructions = buildInstructions(context);
  if (instructions === undefined) delete agent.instructions;
  else agent.instructions = instructions;
}

export function createAgent(
  config: AppConfig,
  model: Model,
  tools: Tool[],
  context: AgentContext,
): ToolCallingAgent {
  const instructions = buildInstructions(context);

  return new ToolCallingAgent({
    tools,
    model,
    // Las reglas se derivan de las tools que hay: no tiene sentido instruir
    // sobre una base de datos o una busqueda web que no estan disponibles.
    promptTemplates: promptTemplates({
      hasDatabase: tools.some(tool => tool.name === 'run_query'),
      hasMongo: tools.some(tool => tool.name === 'mongo_find'),
      hasWebSearch: tools.some(tool => tool.name === 'web_search'),
    }),
    maxSteps: config.maxSteps,
    streamOutputs: false,
    logger: silentLogger(),
    ...(instructions ? { instructions } : {}),
  });
}
