import type { AppConfig } from '../config/types';

export interface Embedder {
  /** Modelo con el que se generan los vectores, para poder invalidarlos. */
  readonly model: string;
  /**
   * Vectoriza los textos. Devuelve null si el proveedor no puede: a partir de
   * ese momento la sesion trabaja solo con FTS5.
   */
  embed(texts: string[]): Promise<Float32Array[] | null>;
  /** false cuando ya se ha comprobado que el proveedor no sirve. */
  readonly available: boolean;
}

/**
 * Cliente de embeddings sobre cualquier endpoint OpenAI-compatible.
 *
 * La comprobacion es perezosa a proposito: no se llama a la API al arrancar,
 * asi que si nunca usas la memoria no cuesta ni un token. Al primer fallo
 * —Groq no tiene endpoint de embeddings y devuelve 404, una key sin permisos
 * devuelve 401— se avisa una sola vez y se desactiva para el resto de la
 * sesion. Las memorias se siguen guardando sin vector.
 */
class HttpEmbedder implements Embedder {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly onDisabled: (reason: string) => void;
  private disabled = false;

  constructor(
    model: string,
    baseUrl: string,
    apiKey: string,
    onDisabled: (reason: string) => void,
  ) {
    this.model = model;
    this.url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.apiKey = apiKey;
    this.onDisabled = onDisabled;
  }

  get available(): boolean {
    return !this.disabled;
  }

  private disable(reason: string): null {
    if (!this.disabled) {
      this.disabled = true;
      this.onDisabled(reason);
    }
    return null;
  }

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (this.disabled || texts.length === 0) return this.disabled ? null : [];

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (error) {
      return this.disable(
        `no se ha podido contactar con ${this.url} (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const hint =
        response.status === 404
          ? 'el proveedor no expone /embeddings (Groq, por ejemplo, no los ofrece)'
          : detail.slice(0, 160);
      return this.disable(`${response.status} al pedir embeddings: ${hint}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      return this.disable('la respuesta de embeddings no tiene el formato esperado');
    }

    // El orden de `data` no esta garantizado: cada elemento trae su indice.
    const vectors = new Array<Float32Array>(texts.length);
    for (const [position, item] of data.entries()) {
      const index = item.index ?? position;
      if (!Array.isArray(item.embedding)) {
        return this.disable('la respuesta de embeddings venia sin vector');
      }
      vectors[index] = Float32Array.from(item.embedding);
    }
    return vectors;
  }
}

/**
 * Construye el embedder, o undefined si `EMBEDDINGS_MODEL` esta vacio (modo
 * solo FTS5 pedido explicitamente).
 */
export function createEmbedder(
  config: AppConfig,
  onDisabled: (reason: string) => void,
): Embedder | undefined {
  const model = config.memory.embeddingsModel.trim();
  if (!model) return undefined;

  return new HttpEmbedder(model, config.memory.embeddingsBaseUrl, config.apiKey, onDisabled);
}
