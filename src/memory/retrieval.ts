import type { Embedder } from './embeddings';
import type { Memory, MemoryStore } from './store';

/**
 * Constante de la fusion por rango reciproco. 60 es el valor del articulo
 * original y el que usa casi todo el mundo: amortigua las diferencias entre
 * las primeras posiciones sin aplanar el ranking.
 */
const RRF_K = 60;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Fusion por rango reciproco: combina varias listas ordenadas sumando
 * `1 / (k + posicion)`. Usa las posiciones, no las puntuaciones, asi que no
 * hay que normalizar la similitud coseno contra el `rank` de FTS5, que estan
 * en escalas distintas y ni siquiera tienen el mismo signo.
 */
export function fuseRankings(rankings: Memory[][], limit: number): Memory[] {
  const scores = new Map<number, number>();
  const byId = new Map<number, Memory>();

  for (const ranking of rankings) {
    for (const [position, memory] of ranking.entries()) {
      byId.set(memory.id, memory);
      scores.set(memory.id, (scores.get(memory.id) ?? 0) + 1 / (RRF_K + position + 1));
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id]) => byId.get(id)!);
}

/** Busqueda semantica por fuerza bruta sobre los vectores guardados. */
async function searchSemantic(
  store: MemoryStore,
  embedder: Embedder,
  query: string,
  limit: number,
): Promise<Memory[]> {
  const withVectors = store.allWithVectors().filter(memory => memory.embedding !== null);
  if (withVectors.length === 0) return [];

  const embedded = await embedder.embed([query]);
  const queryVector = embedded?.[0];
  if (!queryVector) return [];

  return withVectors
    .map(memory => ({ memory, score: cosineSimilarity(queryVector, memory.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);
}

/**
 * Busca memorias relevantes combinando significado y palabras.
 *
 * Sin embedder —o si el proveedor se ha caido— se queda solo con FTS5, que
 * acierta menos pero nunca falla por red.
 */
export async function searchMemories(
  store: MemoryStore,
  embedder: Embedder | undefined,
  query: string,
  limit: number,
): Promise<Memory[]> {
  const trimmed = query.trim();
  if (!trimmed || limit <= 0) return [];

  // Se pide de mas a cada rama para que la fusion tenga con que trabajar.
  const perBranch = Math.max(limit * 2, 10);
  const keyword = store.searchText(trimmed, perBranch);

  if (!embedder?.available) return keyword.slice(0, limit);

  const semantic = await searchSemantic(store, embedder, trimmed, perBranch);
  if (semantic.length === 0) return keyword.slice(0, limit);

  return fuseRankings([semantic, keyword], limit);
}

/**
 * Rellena los vectores que falten. Se llama al arrancar y despues de guardar.
 *
 * Es silencioso a proposito: si el proveedor no da embeddings, las memorias ya
 * estan guardadas y la busqueda por texto sigue funcionando.
 */
export async function backfillEmbeddings(
  store: MemoryStore,
  embedder: Embedder | undefined,
  batchSize = 32,
): Promise<number> {
  if (!embedder?.available) return 0;

  const pending = store.pendingEmbeddings(embedder.model);
  let done = 0;

  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    const vectors = await embedder.embed(batch.map(memory => memory.content));
    if (!vectors) break; // El embedder se ha desactivado: no insistimos.

    batch.forEach((memory, index) => {
      const vector = vectors[index];
      if (vector) {
        store.setEmbedding(memory.id, vector, embedder.model);
        done++;
      }
    });
  }

  return done;
}
