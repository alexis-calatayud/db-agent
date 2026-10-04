import { Tool, tool } from 'smolagents.js';
import type { Embedder } from '../memory/embeddings';
import { backfillEmbeddings, searchMemories } from '../memory/retrieval';
import type { Memory, MemoryStore } from '../memory/store';

/** Tope de memorias que devuelve `recall` de una vez. */
const MAX_RESULTS = 25;

function parseTags(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
}

export function formatMemory(memory: Memory): string {
  const marks = [
    memory.pinned ? 'fija' : null,
    memory.tags.length > 0 ? memory.tags.join(', ') : null,
  ].filter(Boolean);
  const suffix = marks.length > 0 ? `  [${marks.join(' | ')}]` : '';
  return `#${memory.id} ${memory.content}${suffix}`;
}

function toObservation(error: unknown): string {
  return `Error de la memoria: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Aviso comun a todas las tools: quien decide que se guarda es el usuario.
 * Repetirlo en la descripcion, y no solo en el prompt de sistema, importa
 * porque es lo unico que el modelo ve pegado a la herramienta.
 */
const ONLY_ON_REQUEST =
  'Usala SOLO cuando el usuario pida explicitamente recordar algo ("recuerda que...", ' +
  '"apunta que..."). Nunca guardes por iniciativa propia.';

export function makeRememberTool(store: MemoryStore, embedder?: Embedder): Tool {
  return tool(
    {
      name: 'remember',
      description:
        `Guarda un dato en la memoria permanente, que sobrevive al cierre del programa. ${ONLY_ON_REQUEST} ` +
        'Redacta el contenido para que se entienda solo dentro de meses, sin depender de esta conversacion.',
      inputs: {
        content: {
          type: 'string',
          description:
            'El dato a recordar, en una frase autocontenida. Ejemplo: "Alexis prefiere los precios en EUR/MWh".',
        },
        tags: {
          type: 'string',
          description: 'Etiquetas opcionales separadas por comas, para agrupar. Ejemplo: "preferencias,informes".',
          nullable: true,
        },
        pinned: {
          type: 'boolean',
          description:
            'true si es una preferencia o norma que debe aplicarse SIEMPRE, aunque la pregunta no la mencione. ' +
            'Usalo con moderacion: lo fijo se envia en cada pregunta.',
          nullable: true,
        },
      },
      outputType: 'string',
    },
    async ({
      content,
      tags,
      pinned,
    }: {
      content: string;
      tags?: string | null;
      pinned?: boolean | null;
    }): Promise<string> => {
      try {
        const text = content?.trim();
        if (!text) return 'No se ha guardado nada: el contenido estaba vacio.';

        const saved = store.save({
          content: text,
          tags: parseTags(tags),
          pinned: pinned === true,
        });
        // Vectoriza la recien creada. Si no hay proveedor, no pasa nada: queda
        // buscable por texto.
        await backfillEmbeddings(store, embedder);

        return `Guardado como ${formatMemory(saved)}`;
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

export function makeRecallTool(store: MemoryStore, embedder?: Embedder): Tool {
  return tool(
    {
      name: 'recall',
      description:
        'Busca en la memoria permanente. Con "query" busca por significado y por palabras; ' +
        'sin "query" devuelve las mas recientes. Las memorias relevantes ya se te pasan ' +
        'automaticamente con cada pregunta, asi que solo hace falta llamarla para buscar ' +
        'algo concreto o para listar lo que hay.',
      inputs: {
        query: {
          type: 'string',
          description: 'Que buscar. Omitelo para listar las memorias mas recientes.',
          nullable: true,
        },
        tag: {
          type: 'string',
          description: 'Filtra por una etiqueta concreta. Solo se aplica al listar (sin query).',
          nullable: true,
        },
        limit: {
          // 'number', no 'integer': smolagents valida con typeof, que para un
          // numero de JS devuelve 'number'. Con 'integer' la llamada se
          // rechaza siempre y la tool no llega a ejecutarse nunca.
          type: 'number',
          description: `Cuantas devolver como maximo, entero. Por defecto 10, tope ${MAX_RESULTS}.`,
          nullable: true,
        },
      },
      outputType: 'string',
    },
    async ({
      query,
      tag,
      limit,
    }: {
      query?: string | null;
      tag?: string | null;
      limit?: number | null;
    }): Promise<string> => {
      try {
        const max = Math.min(Math.max(1, limit ?? 10), MAX_RESULTS);
        const text = query?.trim();

        const results = text
          ? await searchMemories(store, embedder, text, max)
          : store.listRecent(max, tag?.trim() || undefined);

        if (results.length === 0) {
          return text
            ? `No hay ninguna memoria relacionada con "${text}".`
            : 'La memoria esta vacia.';
        }

        const header = text
          ? `${results.length} memoria(s) relacionadas con "${text}":`
          : `${results.length} memoria(s), de la mas reciente a la mas antigua:`;
        return `${header}\n${results.map(formatMemory).join('\n')}`;
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

export function makeUpdateMemoryTool(store: MemoryStore, embedder?: Embedder): Tool {
  return tool(
    {
      name: 'update_memory',
      description:
        'Corrige una memoria existente por su id. Solo cambia lo que le pases. ' +
        'Usala cuando un dato guardado deje de ser cierto, en vez de guardar otro que lo contradiga.',
      inputs: {
        // 'number' y no 'integer': ver la nota en recall.
        id: { type: 'number', description: 'Id de la memoria, tal y como lo devuelve recall.' },
        content: { type: 'string', description: 'Nuevo texto.', nullable: true },
        tags: { type: 'string', description: 'Nuevas etiquetas separadas por comas.', nullable: true },
        pinned: { type: 'boolean', description: 'Marcar o desmarcar como fija.', nullable: true },
      },
      outputType: 'string',
    },
    async ({
      id,
      content,
      tags,
      pinned,
    }: {
      id: number;
      content?: string | null;
      tags?: string | null;
      pinned?: boolean | null;
    }): Promise<string> => {
      try {
        const updated = store.update(id, {
          ...(content?.trim() ? { content: content.trim() } : {}),
          ...(tags !== undefined && tags !== null ? { tags: parseTags(tags) } : {}),
          ...(pinned !== undefined && pinned !== null ? { pinned } : {}),
        });

        if (!updated) return `No existe ninguna memoria con id ${id}. Usa recall para ver las que hay.`;

        await backfillEmbeddings(store, embedder);
        return `Actualizada: ${formatMemory(updated)}`;
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

export function makeForgetTool(store: MemoryStore): Tool {
  return tool(
    {
      name: 'forget',
      description:
        'Borra definitivamente una memoria por su id. Usala cuando el usuario lo pida o cuando ' +
        'un dato guardado resulte ser falso: una memoria equivocada contamina las respuestas futuras.',
      inputs: {
        // 'number' y no 'integer': ver la nota en recall.
        id: { type: 'number', description: 'Id de la memoria, tal y como lo devuelve recall.' },
      },
      outputType: 'string',
    },
    async ({ id }: { id: number }): Promise<string> => {
      try {
        const removed = store.remove(id);
        return removed
          ? `Borrada: ${formatMemory(removed)}`
          : `No existe ninguna memoria con id ${id}. Usa recall para ver las que hay.`;
      } catch (error) {
        return toObservation(error);
      }
    },
  );
}

/** Las cuatro tools de memoria, listas para el agente. */
export function makeMemoryTools(store: MemoryStore, embedder?: Embedder): Tool[] {
  return [
    makeRememberTool(store, embedder),
    makeRecallTool(store, embedder),
    makeUpdateMemoryTool(store, embedder),
    makeForgetTool(store),
  ];
}
