import { Database } from 'bun:sqlite';

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  /** true si debe ir siempre en el prompt, sin depender de la busqueda. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Memoria con su vector, para la busqueda semantica. */
export interface MemoryWithVector extends Memory {
  embedding: Float32Array | null;
  embeddingModel: string | null;
}

interface Row {
  id: number;
  content: string;
  tags: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

interface VectorRow extends Row {
  embedding: Uint8Array | null;
  embedding_model: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  content         TEXT    NOT NULL,
  tags            TEXT    NOT NULL DEFAULT '',
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  embedding       BLOB,
  embedding_model TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
  USING fts5(content, tags, content='memory', content_rowid='id');

-- Con tablas FTS5 de contenido externo el indice no se actualiza solo: sin
-- estos tres triggers, la busqueda por texto devuelve resultados obsoletos.
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
`;

function parseTags(raw: string): string[] {
  return raw.split(',').map(tag => tag.trim()).filter(Boolean);
}

function toMemory(row: Row): Memory {
  return {
    id: row.id,
    content: row.content,
    tags: parseTags(row.tags),
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** El BLOB de SQLite son bytes crudos; los reinterpretamos como Float32Array. */
function toVector(blob: Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  // Copiamos: el buffer puede no estar alineado a 4 bytes ni ser exclusivo.
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function toVectorMemory(row: VectorRow): MemoryWithVector {
  return {
    ...toMemory(row),
    embedding: toVector(row.embedding),
    embeddingModel: row.embedding_model,
  };
}

export interface SaveInput {
  content: string;
  tags?: string[] | undefined;
  pinned?: boolean | undefined;
}

export interface UpdateInput {
  content?: string | undefined;
  tags?: string[] | undefined;
  pinned?: boolean | undefined;
}

/**
 * Persistencia de las memorias en SQLite.
 *
 * Solo datos: no sabe nada de embeddings ni de relevancia, solo los guarda y
 * los devuelve. La logica de busqueda vive en `retrieval.ts`.
 */
export class MemoryStore {
  private readonly db: Database;

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(SCHEMA);
    this.clock = clock;
  }

  private readonly clock: () => Date;

  save({ content, tags = [], pinned = false }: SaveInput): Memory {
    const stamp = this.clock().toISOString();
    const row = this.db
      .query<Row, [string, string, number, string, string]>(
        `INSERT INTO memory (content, tags, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id, content, tags, pinned, created_at, updated_at`,
      )
      .get(content.trim(), tags.join(','), pinned ? 1 : 0, stamp, stamp);

    return toMemory(row!);
  }

  get(id: number): Memory | null {
    const row = this.db
      .query<Row, [number]>(
        'SELECT id, content, tags, pinned, created_at, updated_at FROM memory WHERE id = ?',
      )
      .get(id);
    return row ? toMemory(row) : null;
  }

  /**
   * Actualiza solo los campos indicados. Devuelve null si el id no existe, en
   * lugar de lanzar: quien llama es una tool y prefiere un mensaje legible.
   */
  update(id: number, changes: UpdateInput): Memory | null {
    const current = this.get(id);
    if (!current) return null;

    const content = changes.content?.trim() ?? current.content;
    const tags = changes.tags ?? current.tags;
    const pinned = changes.pinned ?? current.pinned;

    this.db.run(
      'UPDATE memory SET content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?',
      [content, tags.join(','), pinned ? 1 : 0, this.clock().toISOString(), id],
    );

    // Si el texto cambia, el vector guardado ya no lo representa.
    if (changes.content !== undefined && content !== current.content) {
      this.db.run('UPDATE memory SET embedding = NULL, embedding_model = NULL WHERE id = ?', [id]);
    }

    return this.get(id);
  }

  /** Devuelve la memoria borrada, para poder decir en voz alta que se fue. */
  remove(id: number): Memory | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db.run('DELETE FROM memory WHERE id = ?', [id]);
    return existing;
  }

  listPinned(): Memory[] {
    return this.db
      .query<Row, []>(
        `SELECT id, content, tags, pinned, created_at, updated_at
           FROM memory WHERE pinned = 1 ORDER BY created_at`,
      )
      .all()
      .map(toMemory);
  }

  listRecent(limit = 20, tag?: string): Memory[] {
    const rows = tag
      ? this.db
          .query<Row, [string, number]>(
            `SELECT id, content, tags, pinned, created_at, updated_at
               FROM memory
              WHERE ',' || tags || ',' LIKE '%,' || ? || ',%'
              ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(tag, limit)
      : this.db
          .query<Row, [number]>(
            `SELECT id, content, tags, pinned, created_at, updated_at
               FROM memory ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(limit);

    return rows.map(toMemory);
  }

  count(): number {
    return this.db.query<{ n: number }, []>('SELECT count(*) AS n FROM memory').get()!.n;
  }

  /**
   * Busqueda por palabras. Los terminos se unen con OR y se escapan como
   * cadenas entre comillas: asi la sintaxis de FTS5 que pueda colarse en la
   * pregunta del usuario no rompe la consulta.
   */
  searchText(query: string, limit: number): Memory[] {
    const terms = query
      .toLowerCase()
      .replace(/["']/g, ' ')
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(term => term.length > 2)
      .map(term => `"${term}"`);

    if (terms.length === 0) return [];

    try {
      return this.db
        .query<Row, [string, number]>(
          `SELECT m.id, m.content, m.tags, m.pinned, m.created_at, m.updated_at
             FROM memory_fts f JOIN memory m ON m.id = f.rowid
            WHERE memory_fts MATCH ?
            ORDER BY rank LIMIT ?`,
        )
        .all(terms.join(' OR '), limit)
        .map(toMemory);
    } catch {
      // Consulta que FTS5 no sabe interpretar: preferimos no recuperar nada
      // antes que tumbar el turno.
      return [];
    }
  }

  /** Todas las memorias con vector, para calcular similitud en memoria. */
  allWithVectors(): MemoryWithVector[] {
    return this.db
      .query<VectorRow, []>(
        `SELECT id, content, tags, pinned, created_at, updated_at, embedding, embedding_model
           FROM memory`,
      )
      .all()
      .map(toVectorMemory);
  }

  /** Memorias sin vector, o con uno de otro modelo: hay que (re)embeberlas. */
  pendingEmbeddings(model: string): Memory[] {
    return this.db
      .query<Row, [string]>(
        `SELECT id, content, tags, pinned, created_at, updated_at
           FROM memory
          WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model <> ?`,
      )
      .all(model)
      .map(toMemory);
  }

  setEmbedding(id: number, vector: Float32Array, model: string): void {
    this.db.run('UPDATE memory SET embedding = ?, embedding_model = ? WHERE id = ?', [
      new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
      model,
      id,
    ]);
  }

  close(): void {
    this.db.close();
  }
}
