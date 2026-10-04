import { describe, expect, it } from 'bun:test';
import type { Embedder } from '../memory/embeddings';
import { MemoryStore } from '../memory/store';
import {
  makeForgetTool,
  makeRecallTool,
  makeRememberTool,
  makeUpdateMemoryTool,
} from './memory';

const newStore = () => new MemoryStore(':memory:');

const embedder: Embedder = {
  model: 'falso',
  available: true,
  embed: async texts => texts.map(() => Float32Array.from([1, 0])),
};

describe('remember', () => {
  it('guarda y confirma con el id, para que el agente pueda referirse a el', async () => {
    const store = newStore();
    const output = await makeRememberTool(store).call({ content: 'Prefiero EUR/MWh' });

    expect(output).toContain('Guardado');
    expect(output).toContain('#1');
    expect(output).toContain('Prefiero EUR/MWh');
    expect(store.count()).toBe(1);
    store.close();
  });

  it('acepta etiquetas y la marca de fija', async () => {
    const store = newStore();
    const output = await makeRememberTool(store).call({
      content: 'Respuestas breves',
      tags: ' preferencias , estilo ',
      pinned: true,
    });

    expect(output).toContain('fija');
    expect(output).toContain('preferencias, estilo');
    expect(store.listPinned()).toHaveLength(1);
    store.close();
  });

  it('no guarda contenido vacio', async () => {
    const store = newStore();
    const output = await makeRememberTool(store).call({ content: '   ' });

    expect(output).toContain('No se ha guardado nada');
    expect(store.count()).toBe(0);
    store.close();
  });

  it('vectoriza al guardar cuando hay embedder', async () => {
    const store = newStore();
    await makeRememberTool(store, embedder).call({ content: 'con vector' });

    expect(store.allWithVectors()[0]?.embedding).not.toBeNull();
    store.close();
  });

  it('guarda igual si no hay embedder: queda buscable por texto', async () => {
    const store = newStore();
    await makeRememberTool(store).call({ content: 'sin vector pero guardada' });

    expect(store.count()).toBe(1);
    expect(store.allWithVectors()[0]?.embedding).toBeNull();
    store.close();
  });
});

describe('recall', () => {
  it('sin query lista las mas recientes', async () => {
    const store = newStore();
    store.save({ content: 'primera' });
    store.save({ content: 'segunda' });

    const output = await makeRecallTool(store).call({});
    expect(output).toContain('2 memoria(s)');
    expect(output).toContain('primera');
    expect(output).toContain('segunda');
    store.close();
  });

  it('con query busca y lo dice en la cabecera', async () => {
    const store = newStore();
    store.save({ content: 'Los precios van en EUR/MWh' });
    store.save({ content: 'El contacto tecnico es Marta' });

    const output = await makeRecallTool(store).call({ query: 'precios' });
    expect(output).toContain('relacionadas con "precios"');
    expect(output).toContain('EUR/MWh');
    expect(output).not.toContain('Marta');
    store.close();
  });

  it('distingue memoria vacia de busqueda sin resultados', async () => {
    const store = newStore();
    expect(await makeRecallTool(store).call({})).toContain('vacia');

    store.save({ content: 'algo' });
    expect(await makeRecallTool(store).call({ query: 'inexistente' })).toContain(
      'No hay ninguna memoria relacionada',
    );
    store.close();
  });

  it('filtra por etiqueta al listar', async () => {
    const store = newStore();
    store.save({ content: 'con etiqueta', tags: ['informes'] });
    store.save({ content: 'sin etiqueta' });

    const output = await makeRecallTool(store).call({ tag: 'informes' });
    expect(output).toContain('con etiqueta');
    expect(output).not.toContain('sin etiqueta');
    store.close();
  });

  it('acota el limite para no desbordar el contexto', async () => {
    const store = newStore();
    for (let i = 0; i < 40; i++) store.save({ content: `memoria ${i}` });

    const output = await makeRecallTool(store).call({ limit: 999 });
    expect(output).toContain('25 memoria(s)'); // tope interno
    store.close();
  });
});

describe('update_memory', () => {
  it('corrige el contenido y lo confirma', async () => {
    const store = newStore();
    const saved = store.save({ content: 'dato viejo' });

    const output = await makeUpdateMemoryTool(store).call({ id: saved.id, content: 'dato nuevo' });
    expect(output).toContain('Actualizada');
    expect(output).toContain('dato nuevo');
    expect(store.get(saved.id)?.content).toBe('dato nuevo');
    store.close();
  });

  it('permite desmarcar una fija', async () => {
    const store = newStore();
    const saved = store.save({ content: 'era fija', pinned: true });

    await makeUpdateMemoryTool(store).call({ id: saved.id, pinned: false });
    expect(store.listPinned()).toHaveLength(0);
    store.close();
  });

  it('re-vectoriza tras cambiar el texto', async () => {
    const store = newStore();
    const saved = store.save({ content: 'texto original' });
    store.setEmbedding(saved.id, Float32Array.from([0, 1]), 'falso');

    await makeUpdateMemoryTool(store, embedder).call({ id: saved.id, content: 'texto nuevo' });
    expect(store.pendingEmbeddings('falso')).toHaveLength(0);
    store.close();
  });

  it('con un id inexistente responde en vez de lanzar', async () => {
    const store = newStore();
    const output = await makeUpdateMemoryTool(store).call({ id: 404, content: 'x' });

    expect(output).toContain('No existe');
    expect(output).toContain('recall');
    store.close();
  });
});

describe('forget', () => {
  it('borra y dice que ha borrado', async () => {
    const store = newStore();
    const saved = store.save({ content: 'a olvidar' });

    const output = await makeForgetTool(store).call({ id: saved.id });
    expect(output).toContain('Borrada');
    expect(output).toContain('a olvidar');
    expect(store.count()).toBe(0);
    store.close();
  });

  it('con un id inexistente responde en vez de lanzar', async () => {
    const store = newStore();
    const output = await makeForgetTool(store).call({ id: 404 });

    expect(output).toContain('No existe');
    store.close();
  });
});

describe('esquema de argumentos', () => {
  /**
   * Trampa de smolagents: 'integer' esta en AUTHORIZED_TYPES, pero
   * `validateToolArguments` compara contra `typeof`, que para un numero de JS
   * devuelve 'number'. Una tool declarada como 'integer' se rechaza SIEMPRE y
   * no llega a ejecutarse; el modelo la reintenta sin entender por que.
   */
  it('los numeros se declaran como "number", nunca como "integer"', () => {
    const store = newStore();
    const numericInputs: Array<[string, unknown]> = [
      ['forget.id', makeForgetTool(store).inputs['id']],
      ['update_memory.id', makeUpdateMemoryTool(store).inputs['id']],
      ['recall.limit', makeRecallTool(store).inputs['limit']],
    ];

    for (const [name, schema] of numericInputs) {
      expect(`${name}: ${(schema as { type: string }).type}`).toBe(`${name}: number`);
    }
    store.close();
  });

  it('los argumentos opcionales van marcados como nullable', () => {
    const store = newStore();
    const recall = makeRecallTool(store);

    for (const key of ['query', 'tag', 'limit']) {
      expect(recall.inputs[key]?.['nullable']).toBe(true);
    }
    // El id de forget es obligatorio: no debe ser nullable.
    expect(makeForgetTool(store).inputs['id']?.['nullable']).toBeUndefined();
    store.close();
  });
});

describe('resistencia a fallos', () => {
  it('un error del almacen se devuelve como observacion, no tumba el turno', async () => {
    const store = newStore();
    store.close(); // la base ya no responde

    for (const output of [
      await makeRememberTool(store).call({ content: 'x' }),
      await makeRecallTool(store).call({}),
      await makeForgetTool(store).call({ id: 1 }),
    ]) {
      expect(output).toContain('Error de la memoria');
    }
  });
});
