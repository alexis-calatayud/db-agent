import { describe, expect, it } from 'bun:test';
import { MemoryStore } from './store';

/** Reloj fijo para que created_at/updated_at sean deterministas. */
const newStore = (clock?: () => Date) =>
  new MemoryStore(':memory:', clock ?? (() => new Date('2026-07-28T10:00:00.000Z')));

describe('MemoryStore: CRUD', () => {
  it('guarda y devuelve una memoria con sus campos', () => {
    const store = newStore();
    const saved = store.save({ content: '  Prefiero EUR/MWh  ', tags: ['preferencias'], pinned: true });

    expect(saved.id).toBeGreaterThan(0);
    expect(saved.content).toBe('Prefiero EUR/MWh'); // recortado
    expect(saved.tags).toEqual(['preferencias']);
    expect(saved.pinned).toBe(true);
    expect(saved.createdAt).toBe('2026-07-28T10:00:00.000Z');
    store.close();
  });

  it('aplica valores por defecto sensatos', () => {
    const store = newStore();
    const saved = store.save({ content: 'sin nada mas' });
    expect(saved.tags).toEqual([]);
    expect(saved.pinned).toBe(false);
    store.close();
  });

  it('actualiza solo los campos indicados', () => {
    const store = newStore();
    const saved = store.save({ content: 'original', tags: ['a'], pinned: true });
    const updated = store.update(saved.id, { content: 'corregido' });

    expect(updated?.content).toBe('corregido');
    expect(updated?.tags).toEqual(['a']); // intactas
    expect(updated?.pinned).toBe(true); // intacto
    store.close();
  });

  it('devuelve null en vez de lanzar cuando el id no existe', () => {
    const store = newStore();
    expect(store.update(999, { content: 'x' })).toBeNull();
    expect(store.remove(999)).toBeNull();
    expect(store.get(999)).toBeNull();
    store.close();
  });

  it('remove() devuelve lo borrado, para poder decir que se fue', () => {
    const store = newStore();
    const saved = store.save({ content: 'efimera' });
    expect(store.remove(saved.id)?.content).toBe('efimera');
    expect(store.count()).toBe(0);
    store.close();
  });

  it('listPinned solo devuelve las fijas, y listRecent ordena por reciente', () => {
    let tick = 0;
    const store = newStore(() => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)));
    store.save({ content: 'primera' });
    store.save({ content: 'fija', pinned: true });
    store.save({ content: 'ultima' });

    expect(store.listPinned().map(m => m.content)).toEqual(['fija']);
    expect(store.listRecent(3)[0]?.content).toBe('ultima');
    store.close();
  });

  it('filtra por etiqueta exacta, sin coincidencias parciales', () => {
    const store = newStore();
    store.save({ content: 'con informes', tags: ['informes'] });
    store.save({ content: 'con informes-viejos', tags: ['informes-viejos'] });

    const found = store.listRecent(10, 'informes');
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe('con informes');
    store.close();
  });
});

describe('MemoryStore: indice FTS5', () => {
  it('encuentra por palabra tras insertar', () => {
    const store = newStore();
    store.save({ content: 'El informe mensual se entrega el dia 5' });
    expect(store.searchText('informe', 5)).toHaveLength(1);
    store.close();
  });

  // Estos dos son la razon de ser de los triggers: con tablas FTS5 de
  // contenido externo el indice no se actualiza solo.
  it('el indice queda al dia despues de actualizar', () => {
    const store = newStore();
    const saved = store.save({ content: 'hablaba de zanahorias' });
    store.update(saved.id, { content: 'ahora habla de pepinos' });

    expect(store.searchText('zanahorias', 5)).toHaveLength(0);
    expect(store.searchText('pepinos', 5)).toHaveLength(1);
    store.close();
  });

  it('el indice queda al dia despues de borrar', () => {
    const store = newStore();
    const saved = store.save({ content: 'contenido borrable' });
    store.remove(saved.id);
    expect(store.searchText('borrable', 5)).toHaveLength(0);
    store.close();
  });

  it('no se rompe con sintaxis de FTS5 escrita por el usuario', () => {
    const store = newStore();
    store.save({ content: 'una memoria cualquiera' });
    for (const query of ['memoria AND (', '"sin cerrar', 'NEAR/', '* OR *', '???']) {
      expect(() => store.searchText(query, 5)).not.toThrow();
    }
    store.close();
  });

  it('ignora los terminos demasiado cortos para aportar algo', () => {
    const store = newStore();
    store.save({ content: 'algo' });
    expect(store.searchText('de la el', 5)).toEqual([]);
    store.close();
  });
});

describe('MemoryStore: vectores', () => {
  it('el BLOB va y vuelve sin perder precision', () => {
    const store = newStore();
    const saved = store.save({ content: 'con vector' });
    const vector = Float32Array.from([0.5, -0.25, 0.125, 1]);
    store.setEmbedding(saved.id, vector, 'modelo-x');

    const [stored] = store.allWithVectors();
    expect(Array.from(stored!.embedding!)).toEqual([0.5, -0.25, 0.125, 1]);
    expect(stored!.embeddingModel).toBe('modelo-x');
    store.close();
  });

  it('pendingEmbeddings devuelve las que no tienen vector', () => {
    const store = newStore();
    store.save({ content: 'sin vector' });
    const conVector = store.save({ content: 'con vector' });
    store.setEmbedding(conVector.id, Float32Array.from([1, 0]), 'modelo-x');

    expect(store.pendingEmbeddings('modelo-x').map(m => m.content)).toEqual(['sin vector']);
    store.close();
  });

  it('cambiar de modelo invalida los vectores guardados', () => {
    const store = newStore();
    const saved = store.save({ content: 'con vector viejo' });
    store.setEmbedding(saved.id, Float32Array.from([1, 0]), 'modelo-viejo');

    expect(store.pendingEmbeddings('modelo-viejo')).toHaveLength(0);
    expect(store.pendingEmbeddings('modelo-nuevo')).toHaveLength(1);
    store.close();
  });

  it('editar el texto descarta el vector, que ya no lo representa', () => {
    const store = newStore();
    const saved = store.save({ content: 'texto original' });
    store.setEmbedding(saved.id, Float32Array.from([1, 0]), 'modelo-x');
    store.update(saved.id, { content: 'texto completamente distinto' });

    expect(store.allWithVectors()[0]?.embedding).toBeNull();
    expect(store.pendingEmbeddings('modelo-x')).toHaveLength(1);
    store.close();
  });

  it('cambiar solo las etiquetas conserva el vector', () => {
    const store = newStore();
    const saved = store.save({ content: 'texto estable' });
    store.setEmbedding(saved.id, Float32Array.from([1, 0]), 'modelo-x');
    store.update(saved.id, { tags: ['nueva'] });

    expect(store.allWithVectors()[0]?.embedding).not.toBeNull();
    store.close();
  });
});

describe('MemoryStore: persistencia', () => {
  it('lo guardado sobrevive a cerrar y volver a abrir el fichero', () => {
    const path = `/private/tmp/claude-501/memoria-test-${process.pid}.db`;

    const first = new MemoryStore(path);
    first.save({ content: 'debe sobrevivir', pinned: true });
    first.close();

    const second = new MemoryStore(path);
    expect(second.listPinned().map(m => m.content)).toEqual(['debe sobrevivir']);
    expect(second.searchText('sobrevivir', 5)).toHaveLength(1);
    second.close();

    for (const suffix of ['', '-shm', '-wal']) {
      Bun.spawnSync(['rm', '-f', `${path}${suffix}`]);
    }
  });
});
