import type { AppConfig } from '../config/types';

export interface Source {
  title: string;
  url: string;
}

export interface SearchResult {
  /** Resumen redactado por el modelo de busqueda. */
  answer: string;
  /** Paginas en las que se ha apoyado, sin repetir URL. */
  sources: Source[];
}

export interface WebSearcher {
  readonly model: string;
  /** Devuelve null si el proveedor no puede buscar (y explica por que una vez). */
  search(query: string): Promise<SearchResult | null>;
  readonly available: boolean;
}

/** Tope de caracteres del resumen, para no desbordar el contexto del agente. */
const MAX_ANSWER_CHARS = 4000;

/** Anotacion de cita tal y como la devuelve la API. */
interface UrlCitation {
  type?: string;
  url_citation?: { url?: string; title?: string };
}

function extractSources(annotations: UrlCitation[] | undefined): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const annotation of annotations ?? []) {
    const citation = annotation.url_citation;
    const url = citation?.url?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: citation?.title?.trim() || url });
  }

  return sources;
}

/**
 * Busqueda web apoyada en un modelo con busqueda integrada.
 *
 * No hace falta dar de alta ningun servicio aparte: se reutiliza la API key del
 * chat. A cambio, quien busca y resume es otro modelo, asi que el resultado
 * llega ya redactado; por eso se devuelven tambien las URLs, para que el agente
 * pueda atribuir en vez de afirmar a ciegas.
 *
 * La comprobacion es perezosa: si el proveedor no tiene el modelo (Groq, por
 * ejemplo), se avisa una vez y la tool deja de intentarlo durante la sesion.
 */
class ModelSearcher implements WebSearcher {
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
    this.url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
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

  async search(query: string): Promise<SearchResult | null> {
    if (this.disabled) return null;

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'Busca en internet y responde de forma breve y factual, citando siempre las ' +
                'fuentes. Si la informacion depende de la fecha, di a que fecha corresponde. ' +
                'Si no encuentras nada fiable, dilo en lugar de suponerlo.',
            },
            { role: 'user', content: query },
          ],
          // Los modelos de busqueda solo aceptan max_completion_tokens, y no
          // admiten temperature.
          max_completion_tokens: 1200,
        }),
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
          ? `el proveedor no ofrece el modelo "${this.model}" (Groq, por ejemplo, no tiene modelos con busqueda web)`
          : detail.slice(0, 160);
      return this.disable(`${response.status} al buscar: ${hint}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; annotations?: UrlCitation[] } }>;
    };
    const message = payload.choices?.[0]?.message;
    const answer = message?.content?.trim();

    if (!answer) {
      // Sin contenido no desactivamos: puede ser una consulta concreta que no
      // ha dado resultado, no un problema del proveedor.
      return { answer: '', sources: extractSources(message?.annotations) };
    }

    return {
      answer: answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer,
      sources: extractSources(message?.annotations),
    };
  }
}

/**
 * Construye el buscador, o undefined si `WEB_SEARCH_MODEL` esta vacio (sin tool
 * de busqueda, pedido explicitamente).
 */
export function createSearcher(
  config: AppConfig,
  onDisabled: (reason: string) => void,
): WebSearcher | undefined {
  const model = config.web.searchModel.trim();
  if (!model) return undefined;

  return new ModelSearcher(model, config.web.baseUrl, config.apiKey, onDisabled);
}
