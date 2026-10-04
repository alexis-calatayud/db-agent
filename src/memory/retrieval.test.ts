import { describe, expect, it } from 'bun:test';
import type { Embedder } from './embeddings';
import { backfillEmbeddings, cosineSimilarity, fuseRankings, searchMemories } from './retrieval';
import { MemoryStore, type Memory } from './store';

const newStore = () => new MemoryStore(':memory:');

/**
 * Embedder falso y determinista.
 *
 * Los vectores se declaran a mano por texto exacto, en vez de derivarlos de
 * las palabras: precisamente lo que se quiere comprobar es que dos frases sin
 * palabras en comun puedan quedar cerca en el espacio vectorial.
 */
function fakeEmbedder(
  vectors: Record<string, number[]>,
  overrides: Partial<Embedder> = {},
): Embedder {
  const dimensions = Object.values(vectors)[0]?.length ?? 1;
  return {
    model: 'falso',
    available: true,
    async embed(texts) {
      return texts.map(text =>
        Float32Array.from(vectors[text.trim()] ?? new Array(dimensions).fill(0)),
      );
    },
    ...overrides,
  } as Embedder;
}

const memory = (id: number, content: string): Memory => ({
  id,
  content,
  tags: [],
  pinned: false,
  createdAt: '',
  updatedAt: '',
});

describe('cosineSimilarity', () => {
  it('vale 1 para vectores identicos y 0 para ortogonales', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1);
  });

  it('ignora la magnitud: solo mide direccion', () => {
    expect(cosineSimilarity(Float32Array.from([1, 1]), Float32Array.from([5, 5]))).toBeCloseTo(1);
  });

  it('devuelve 0 ante casos degenerados en vez de NaN', () => {
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1]), Float32Array.from([1, 2]))).toBe(0);
    expect(cosineSimilarity(new Float32Array(), new Float32Array())).toBe(0);
  });
});

describe('fuseRankings', () => {
  it('premia lo que aparece bien colocado en varias listas', () => {
    const a = memory(1, 'a');
    const b = memory(2, 'b');
    const c = memory(3, 'c');

    // b es 2º y 1º; a es 1º y 3º. b deberia ganar.
    const fused = fuseRankings([[a, b, c], [b, c, a]], 3);
    expect(fused.map(m => m.id)).toEqual([2, 1, 3]);
  });

  it('no duplica una memoria presente en las dos listas', () => {
    const a = memory(1, 'a');
    expect(fuseRankings([[a], [a]], 5)).toHaveLength(1);
  });

  it('respeta el limite y aguanta listas vacias', () => {
    const items = [memory(1, 'a'), memory(2, 'b'), memory(3, 'c')];
    expect(fuseRankings([items], 2)).toHaveLength(2);
    expect(fuseRankings([[], []], 5)).toEqual([]);
    expect(fuseRankings([], 5)).toEqual([]);
  });
});

describe('searchMemories', () => {
  /**
   * El caso que motivo usar embeddings: la pregunta no comparte ni una palabra
   * con la memoria correcta, asi que FTS5 no la ve.
   */
  it('encuentra por significado lo que la busqueda por palabras no ve', async () => {
    const store = newStore();
    const CONTENIDO = 'El informe mensual se entrega el dia 5 de cada mes';
    const OTRA = 'Los market makers relevantes son los 5 mas activos';
    const PREGUNTA = 'cuando toca mandarlo';

    const informe = store.save({ content: CONTENIDO });
    const otra = store.save({ content: OTRA });

    // La pregunta apunta casi en la misma direccion que el informe.
    const embedder = fakeEmbedder({
      [CONTENIDO]: [1, 0],
      [OTRA]: [0, 1],
      [PREGUNTA]: [0.9, 0.1],
    });
    const vectors = await embedder.embed([CONTENIDO, OTRA]);
    store.setEmbedding(informe.id, vectors![0]!, 'falso');
    store.setEmbedding(otra.id, vectors![1]!, 'falso');

    // Sin palabras en comun, FTS5 no encuentra nada.
    expect(store.searchText(PREGUNTA, 5)).toHaveLength(0);

    const found = await searchMemories(store, embedder, PREGUNTA, 3);
    expect(found[0]?.id).toBe(informe.id);
    store.close();
  });

  it('sin embedder cae a la busqueda por palabras', async () => {
    const store = newStore();
    store.save({ content: 'Los precios van en EUR/MWh' });

    const found = await searchMemories(store, undefined, 'precios', 3);
    expect(found).toHaveLength(1);
    store.close();
  });

  it('si el embedder se ha desactivado, tampoco lo usa', async () => {
    const store = newStore();
    store.save({ content: 'Los precios van en EUR/MWh' });
    const caido = fakeEmbedder({ precios: [1] }, { available: false });

    const found = await searchMemories(store, caido, 'precios', 3);
    expect(found).toHaveLength(1); // via FTS5
    store.close();
  });

  it('devuelve vacio con consulta vacia o limite cero', async () => {
    const store = newStore();
    store.save({ content: 'algo' });

    expect(await searchMemories(store, undefined, '   ', 3)).toEqual([]);
    expect(await searchMemories(store, undefined, 'algo', 0)).toEqual([]);
    store.close();
  });

  it('respeta el limite pedido', async () => {
    const store = newStore();
    for (let i = 0; i < 8; i++) store.save({ content: `memoria numero ${i} sobre precios` });

    expect(await searchMemories(store, undefined, 'precios', 3)).toHaveLength(3);
    store.close();
  });
});

describe('backfillEmbeddings', () => {
  it('vectoriza lo que falta y no repite lo ya hecho', async () => {
    const store = newStore();
    store.save({ content: 'una' });
    store.save({ content: 'otra' });
    const embedder = fakeEmbedder({ una: [1, 0], otra: [0, 1] });

    expect(await backfillEmbeddings(store, embedder)).toBe(2);
    expect(await backfillEmbeddings(store, embedder)).toBe(0);
    expect(store.allWithVectors().every(m => m.embedding !== null)).toBe(true);
    store.close();
  });

  it('no hace nada sin embedder, ni si esta desactivado', async () => {
    const store = newStore();
    store.save({ content: 'una' });

    expect(await backfillEmbeddings(store, undefined)).toBe(0);
    expect(await backfillEmbeddings(store, fakeEmbedder({ una: [1] }, { available: false }))).toBe(0);
    store.close();
  });

  it('se detiene sin romper si el proveedor cae a mitad', async () => {
    const store = newStore();
    for (let i = 0; i < 5; i++) store.save({ content: `memoria ${i}` });

    const caido: Embedder = { model: 'falso', available: true, embed: async () => null };
    expect(await backfillEmbeddings(store, caido)).toBe(0);
    expect(store.pendingEmbeddings('falso')).toHaveLength(5); // siguen guardadas
    store.close();
  });

  it('trocea en lotes en vez de mandarlo todo de golpe', async () => {
    const store = newStore();
    for (let i = 0; i < 7; i++) store.save({ content: `memoria ${i}` });

    const tamanos: number[] = [];
    const espia: Embedder = {
      model: 'falso',
      available: true,
      async embed(texts) {
        tamanos.push(texts.length);
        return texts.map(() => Float32Array.from([1]));
      },
    };

    expect(await backfillEmbeddings(store, espia, 3)).toBe(7);
    expect(tamanos).toEqual([3, 3, 1]);
    store.close();
  });
});
