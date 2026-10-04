# Agente de datos con smolagents

Agente de IA en **TypeScript sobre Bun**, construido con
[`smolagents.js`](https://www.npmjs.com/package/smolagents.js) (port TypeScript de
[smolagents](https://github.com/huggingface/smolagents)).

Estado actual: **`ToolCallingAgent` con acceso de solo lectura a MongoDB y a
PostgreSQL, memoria permanente y búsqueda en internet**, usable **desde consola
o desde una interfaz web**. Preguntas en lenguaje natural, el agente consulta lo
que haga falta por su cuenta y recuerda entre sesiones lo que le pidas.
`CodeAgent` queda para más adelante. El diseño completo está en
[SPEC.md](SPEC.md).

Las herramientas de fecha, memoria y búsqueda web están siempre; las de cada
base de datos, solo si está configurada y responde. Mongo y Postgres son
independientes: se puede usar una, las dos o ninguna. Si una base no responde al
arrancar, el agente sigue funcionando sin sus herramientas y lo avisa.

## Requisitos

- [Bun](https://bun.sh) ≥ 1.2
- Una API key de un proveedor OpenAI-compatible

## Puesta en marcha

```bash
bun install
cp .env.example .env
```

Pega tu API key de OpenAI ([platform.openai.com/api-keys](https://platform.openai.com/api-keys))
en `LLM_API_KEY` dentro de `.env`. El resto de valores por defecto ya sirven.

Para las herramientas de base de datos, rellena `MONGODB_URL` (con la base al
final: `mongodb://servidor:27017/mi_base`), `DATABASE_URL` (`postgres://…`) o
ambas.

Se puede apuntar a cualquier proveedor OpenAI-compatible cambiando
`LLM_BASE_URL`, pero conviene saber qué se pierde: ver
[Proveedores alternativos](#proveedores-alternativos).

### Consola

```bash
bun start
```

### Web

Son dos procesos: la API con el agente y el frontend Next.js.

```bash
bun run serve              # API en http://localhost:3001
cd frontend && bun install && bun run dev   # web en http://localhost:3000
```

El agente vive en el proceso Bun, no dentro de Next: usa `bun:sqlite` y
`Bun.SQL`, que no existen en el runtime de Node. Next es solo el frontend.

**Las dos interfaces comparten la memoria permanente**: lo que guardes desde la
web lo ve la consola y al revés. Lo que no se comparte es la conversación —
cada pestaña web es una sesión con su propio hilo.

## Uso

```
> ¿cuántas filas tiene la tabla venue?
  · run_query(query=SELECT COUNT(*) FROM venue)
  · final_answer(answer=La tabla venue tiene 6 filas.)
La tabla venue tiene 6 filas.

> ¿cuántos market makers distintos aparecen en raw_trade?
  · describe_table(table=raw_trade)
  · run_query(query=SELECT COUNT(*) FROM ( SELECT DISTINCT "marketMakerBuy" ... ))
  · final_answer(answer=En la tabla raw_trade aparecen 10 market makers distintos...)
En la tabla raw_trade aparecen 10 market makers distintos (considerando tanto
las columnas marketMakerBuy como marketMakerSell).
```

Las líneas con `·` son las herramientas que va llamando el agente. Comandos:

```
/help      Muestra esta ayuda
/clear     Olvida la conversacion actual (no toca la memoria permanente)
/model     Muestra el modelo y los parametros activos
/tools     Lista las herramientas disponibles
/memories  Lista lo recordado. "/memories borrar <id>" elimina una
/exit      Termina la sesion
```

La conversación es multi-turno: el agente recuerda lo anterior dentro de la
sesión, pero no entre sesiones. Lo que deba sobrevivir a un reinicio va a la
[memoria permanente](#memoria-permanente). `/clear` reinicia la conversación.
`Ctrl+C`, `Ctrl+D` o `/exit` cierran.

## Herramientas

| Tool | Requiere | Qué hace |
|---|---|---|
| `now` | — | Fecha y hora actuales. Acepta una zona horaria IANA opcional |
| `remember` | — | Guarda un dato en la memoria permanente |
| `recall` | — | Busca en la memoria, o lista lo guardado |
| `update_memory` | — | Corrige una memoria existente |
| `forget` | — | Borra una memoria |
| `web_search` | — | Busca en internet y devuelve un resumen con las fuentes |
| `list_tables` | Postgres | Tablas y vistas con número de columnas, filas aproximadas y tamaño |
| `describe_table` | Postgres | Columnas, tipos, PK y claves ajenas de una tabla |
| `run_query` | Postgres | Ejecuta una consulta de solo lectura y devuelve las filas en JSON |
| `mongo_list_collections` | Mongo | Colecciones con su número aproximado de documentos |
| `mongo_describe_collection` | Mongo | Infiere campos, tipos y presencia muestreando documentos |
| `mongo_find` | Mongo | Consulta documentos con filtro, proyección y orden |
| `mongo_aggregate` | Mongo | Pipeline de agregación de solo lectura |

El catálogo de tablas y de colecciones se lee una vez al arrancar y viaja dentro
del prompt de sistema, así que el agente no necesita descubrirlo en cada
pregunta. Los campos de cada colección de Mongo no van ahí: como Mongo no tiene
esquema, `mongo_describe_collection` los infiere bajo demanda muestreando
documentos.

`now` existe porque el modelo no tiene reloj: sin ella, cualquier pregunta que
dependa de la fecha se responde con la que el modelo recuerde de su
entrenamiento. Se combina con las de base de datos:

```
> ¿cuántos días han pasado desde el último trade registrado en raw_trade?
  · describe_table(table=public.raw_trade)
  · now()
  · run_query(query=SELECT MAX("tradeTime") ...)
Han pasado 28 días desde el último trade registrado en raw_trade.
```

## Búsqueda en internet

`web_search` cubre lo que no está ni en la base de datos ni en la memoria:
noticias, precios públicos, normativa, documentación.

```
> ¿qué es el índice TTF del gas y para qué sirve?
  · web_search(query=qué es el índice TTF gas Title Transfer Facility mercado europeo)
El TTF es el principal hub virtual de compraventa de gas natural en Europa…
Según las fuentes encontradas —Gasunie Transport Services, Enel y Wikipedia—…
```

No requiere darse de alta en ningún servicio de búsqueda: se apoya en un modelo
de OpenAI con búsqueda integrada, usando la misma `LLM_API_KEY`.

**Quien busca y redacta es otro modelo**, así que el resultado llega ya
resumido y puede estar desactualizado o ser incorrecto. Por eso la tool
devuelve las URLs por separado y el prompt obliga al agente a citarlas en vez
de presentarlas como hecho propio.

### Coste

Medido contra la API real con la misma pregunta:

| Modelo | Tokens de prompt | Citas |
|---|---|---|
| `gpt-4o-mini-search-preview` (por defecto) | 12 | 2 |
| `gpt-4o-search-preview` | 12 | 3 |
| `gpt-5-search-api` | **31.020** | 7 |

Los `*-search-preview` facturan la búsqueda como una tarifa aparte, no como
tokens. `gpt-5-search-api` mete los resultados recuperados en el prompt, y por
eso dispara el consumo: úsalo solo si necesitas esa profundidad.

Con `WEB_SEARCH_MODEL=` vacío la tool desaparece. **Groq no tiene modelos con
búsqueda web**: si cambias de proveedor, la tool se desactiva sola en su primera
llamada y avisa una vez.

## Memoria permanente

El agente recuerda entre sesiones lo que le pidas. Se guarda en un SQLite local
(`.memory.db`, en `.gitignore`) y **solo cuando lo pides explícitamente** — no
memoriza por su cuenta.

```
$ bun start
> recuerda que prefiero ver los precios en EUR/MWh, nunca en céntimos
  · remember(content=El usuario prefiere ver los precios en EUR/MWh…, pinned=true)
Perfecto, queda guardado.
> /exit

$ bun start                       # proceso nuevo, otro día
> ¿en qué unidades quiero ver los datos?
Quieres los precios en EUR/MWh, nunca en céntimos.
```

### Cómo se le hacen llegar las memorias

Dos vías, deliberadamente distintas:

- **Fijas** (`pinned`): preferencias y normas que deben aplicarse siempre.
  Viajan en el prompt de sistema, se apliquen o no a la pregunta. Como cambian
  poco, el prefijo del prompt se mantiene estable y la caché del proveedor
  sigue sirviendo.
- **El resto**: en cada pregunta se buscan las 4 más relevantes y se anteponen a
  la pregunta como «Contexto recordado». Esto es lo que hace que la memoria
  funcione sin depender de que al modelo se le ocurra llamar a `recall`.

### Búsqueda: por significado, no solo por palabras

La búsqueda combina dos rankings con *reciprocal rank fusion*: similitud coseno
sobre embeddings y FTS5 por palabras. La diferencia es grande — medida con 8
memorias y 6 preguntas parafraseadas, sin repetir las palabras con las que se
guardaron:

| Recuperación | Aciertos en el top‑1 |
|---|---|
| Embeddings (`text-embedding-3-small`) | **5/6** |
| FTS5 (palabras) | 2/6 |

Ejemplo real de este repositorio: con la memoria «El informe mensual de MIBGAS
debe entregarse el día 5 de cada mes», la pregunta «¿qué plazo tengo para el
envío?» no comparte **ni una palabra** — FTS5 no devuelve nada y la búsqueda
semántica la coloca primera.

Los embeddings cuestan una llamada HTTP al guardar y al buscar, y son baratos
(0,02 $/millón de tokens; miles de memorias son céntimos). **Groq no ofrece
embeddings**: con Groq la búsqueda semántica se desactiva sola, avisa una vez y
todo sigue funcionando con FTS5. Con `EMBEDDINGS_MODEL=` vacío se desactiva a
propósito. Si prefieres chatear gratis con Groq pero vectorizar bien, apunta
`EMBEDDINGS_BASE_URL` a OpenAI.

### Revisar y limpiar

Una memoria equivocada contamina todas las respuestas siguientes, así que se
puede gestionar sin pasar por el modelo:

```
> /memories                  # lista, separando fijas del resto
> /memories borrar 4         # elimina por id
```

### Qué tener en cuenta

- **Lo recordado se envía al proveedor del modelo** en cada pregunta que lo
  recupere. No guardes ahí credenciales ni datos personales.
- Las memorias son texto que acaba en el prompt. Como solo se guardan a petición
  tuya el riesgo de inyección es bajo, y el prompt indica explícitamente que el
  contexto recordado es información, nunca instrucciones.
- Cambiar `EMBEDDINGS_MODEL` invalida los vectores guardados: se detectan y se
  regeneran al arrancar, sin perder ninguna memoria.

## Bases de datos

Todo el acceso es de **solo lectura**, con topes de resultados y de tiempo en
cada consulta. Las garantías no son iguales en las dos bases, y conviene
conocer la diferencia.

### Cómo se garantiza el solo-lectura en Postgres

Son dos barreras independientes, y la segunda no depende de que la primera
funcione:

1. **Validador de SQL** ([src/db/guard.ts](src/db/guard.ts)). Antes de ejecutar
   nada, neutraliza comentarios, cadenas e identificadores entrecomillados, y
   entonces exige que sea **una sola sentencia** que empiece por `SELECT`,
   `WITH`, `EXPLAIN`, `SHOW`, `TABLE` o `VALUES`. Rechaza DML y DDL, `SELECT
   INTO`, `EXPLAIN ANALYZE`, control de transacción, `SET`, y funciones que
   tocan el servidor (`pg_read_file`, `lo_import`, `pg_sleep`,
   `pg_terminate_backend`…).
2. **Transacción `READ ONLY` de Postgres** ([src/db/client.ts](src/db/client.ts)).
   Cada consulta corre en `SET TRANSACTION READ ONLY` con `statement_timeout`.
   Aunque el validador dejara pasar algo, es Postgres quien rechaza la
   escritura.

Además, toda consulta se envuelve en `SELECT * FROM (...) LIMIT n`, así que el
tope de filas no depende de que el modelo se acuerde de poner `LIMIT`.

Esto vale **con cualquier usuario de base de datos**, incluido un superusuario.
Aun así, lo recomendable es apuntar `DATABASE_URL` a un rol de solo lectura:
las barreras del código protegen de errores del modelo, no sustituyen a los
permisos.

### Cómo se garantiza el solo-lectura en MongoDB

**Aquí la garantía es más débil que en Postgres, y conviene saberlo.** MongoDB
3.4 no tiene nada equivalente a `SET TRANSACTION READ ONLY`: no existe un modo
en el que el servidor rechace escrituras por su cuenta. Las dos barreras son:

1. **Validador** ([src/mongo/guard.ts](src/mongo/guard.ts)). Lista blanca de
   etapas de agregación permitidas, más un recorrido recursivo de toda la
   estructura que rechaza `$out` y `$merge` (escriben) y `$where`, `$function`,
   `$accumulator` y `$eval` (ejecutan JavaScript en el servidor). El recorrido
   es recursivo a propósito: un `$out` escondido dentro de un `$facet` también
   se rechaza, indicando la ruta exacta.
2. **El cliente no puede escribir** ([src/mongo/client.ts](src/mongo/client.ts)).
   No hay ni una llamada a `insert`, `update`, `delete` o `drop` en ninguna ruta
   de código, y nunca se devuelve el objeto `Collection` del driver al exterior.
   Es una garantía estructural, no una que imponga el servidor.

Además: la base va **dentro de `MONGODB_URL`**, así que el agente queda acotado
a esa y no puede saltar a otra del mismo servidor; `listDatabases` no se expone
en ningún sitio. Y todo lleva `maxTimeMS` y tope de documentos.

Como la segunda barrera es estructural y no del servidor, **aquí sí importa de
verdad usar un usuario de Mongo con rol `read`**. El servidor probado no tiene
ni autenticación activada.

### Reglas específicas de la base de Mongo actual

`MONGODB_URL` apunta hoy al catálogo de obras de Flecha (`artworks`, `artists`…).
Lo que sigue depende de esa base en concreto.

#### Enlaces a las fichas de obra

Cuando el agente habla de una obra concreta, incluye su enlace público en
markdown. La URL se forma con dos slugs de colecciones distintas:

```
https://flecha.es/obras-de-{artists.slug}/{artworks.slug}
```

Comprobado contra el sitio real: las obras en `on_sale`, `price_visible` y
`sold` devuelven **200**; las que están en `hidden` devuelven **410**, así que
para esas el agente menciona la obra sin enlace y avisa de que la página está
retirada.

En la web los enlaces se abren en pestaña nueva (`target="_blank"` con
`rel="noopener noreferrer"`) y llevan una marca «↗». El renderizador solo
acepta `http` y `https`: un `[texto](javascript:…)` se queda como texto plano y
no es pinchable.

**Esta regla está escrita en el prompt** ([src/agents/prompts.ts](src/agents/prompts.ts)),
igual que las de MIBGAS. Si apuntas `MONGODB_URL` a otra base, hay que
cambiarla.

#### Referencias (DBRef)

Esta base usa `DBRef` para enlazar colecciones (`artworks` → `artists`), y se
consultan de forma distinta según la herramienta. `mongo_describe_collection` lo
detecta y lo explica en su salida, porque sin esa nota el modelo se pierde:

- En `mongo_find` funciona `{"artist.$id": {"$oid": "…"}}`.
- En `mongo_aggregate` **no**: MongoDB rechaza los `FieldPath` que empiezan por
  `$`, así que hay que rodearlo con `$objectToArray`.

## Configuración

Todo se controla desde `.env` — **cambiar de proveedor o de modelo no requiere
tocar código**.

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `LLM_API_KEY` | **Sí** | — | API key del proveedor |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | Endpoint OpenAI-compatible |
| `LLM_MODEL` | No | `gpt-5.5` | ID del modelo |
| `LLM_TEMPERATURE` | No | `0.7` | Entre 0 y 2 |
| `LLM_MAX_TOKENS` | No | `2048` | Límite de tokens de salida |
| `LLM_REQUESTS_PER_MINUTE` | No | `25` | Rate limiter de cliente |
| `LOG_LEVEL` | No | `info` | `debug` añade tokens, salidas de tools y trazas |
| `DATABASE_URL` | No | — | `postgres://…`. Sin ella, no hay tools de Postgres |
| `DB_SCHEMAS` | No | `public` | Esquemas visibles, separados por comas |
| `DB_MAX_ROWS` | No | `100` | Tope de filas por consulta |
| `DB_TIMEOUT_MS` | No | `15000` | `statement_timeout` de Postgres |
| `MONGODB_URL` | No | — | `mongodb://…/base`. Sin ella, no hay tools de Mongo |
| `MONGO_MAX_DOCS` | No | `50` | Tope de documentos por consulta |
| `MONGO_SAMPLE_SIZE` | No | `100` | Documentos muestreados al inferir el esquema |
| `MONGO_TIMEOUT_MS` | No | `15000` | `maxTimeMS` de las operaciones |
| `MEMORY_DB_PATH` | No | `.memory.db` | Fichero SQLite de la memoria |
| `EMBEDDINGS_MODEL` | No | `text-embedding-3-small` | Vacío = solo FTS5 |
| `EMBEDDINGS_BASE_URL` | No | igual que `LLM_BASE_URL` | Endpoint de embeddings |
| `MEMORY_AUTO_RECALL` | No | `4` | Memorias inyectadas por pregunta. `0` lo desactiva |
| `WEB_SEARCH_MODEL` | No | `gpt-4o-mini-search-preview` | Vacío = sin búsqueda web |
| `WEB_SEARCH_BASE_URL` | No | igual que `LLM_BASE_URL` | Endpoint de búsqueda |
| `AGENT_MAX_STEPS` | No | `8` | Iteraciones máximas por pregunta |
| `PORT` | No | `3001` | Puerto de la API web (`bun run serve`) |

### Elección de modelo

El agente depende de **tool calling nativo**, y no todos los modelos lo hacen
igual de bien. Probado contra esta base de datos:

| Modelo | Proveedor | Resultado |
|---|---|---|
| `gpt-5.5` | OpenAI | **Por defecto.** El más capaz de los probados: escribe el SQL a la primera y, cuando no encuentra datos, investiga el rango real en vez de inventárselo |
| `gpt-5.4` | OpenAI | Funciona igual de bien |
| `gpt-5.6-luna` / `-sol` / `-terra` | OpenAI | **No sirven aquí**: no admiten function tools en `/v1/chat/completions`, requerirían la Responses API |
| `gpt-5.5-pro`, `gpt-5.4-pro` | OpenAI | **No sirven aquí**: no son modelos de chat |
| `qwen/qwen3.6-27b` | Groq | La mejor de las gratuitas probadas. Completa el ciclo de forma fiable |
| `llama-3.3-70b-versatile` | Groq | Funciona, pero a veces emite la llamada como texto (`<function=…>`) y Groq la rechaza. Hay reintento automático |
| `openai/gpt-oss-120b` / `-20b` | Groq | No cierra el ciclo: ver «Limitaciones» |

Los modelos `gpt-5.x`, `o1`, `o3` y `o4` cambian el contrato de la API: rechazan
`max_tokens` (exigen `max_completion_tokens`) y solo admiten su temperatura por
defecto. El código lo detecta y adapta la petición, así que `LLM_TEMPERATURE` se
ignora con ellos — `/model` te lo indica.

### Proveedores alternativos

| Proveedor | `LLM_BASE_URL` | `LLM_MODEL` de ejemplo |
|---|---|---|
| **OpenAI** (por defecto) | `https://api.openai.com/v1` | `gpt-5.5` |
| Groq (gratis) | `https://api.groq.com/openai/v1` | `qwen/qwen3.6-27b` |
| OpenRouter | `https://openrouter.ai/api/v1` | cualquiera acabado en `:free` |
| Cerebras | `https://api.cerebras.ai/v1` | `llama-3.3-70b` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.0-flash` |

**Qué se pierde al salir de OpenAI.** El proyecto sigue funcionando con
cualquiera de los anteriores, pero OpenAI es el único probado que cubre las tres
cosas con una sola key. Con Groq, por ejemplo, el chat funciona pero
**desaparecen los embeddings** (la memoria pasa a buscar solo por palabras) y
**la búsqueda web** (no tiene modelos con búsqueda integrada). Ambas se
desactivan solas y avisan una vez. Se pueden mezclar proveedores:
`EMBEDDINGS_BASE_URL` y `WEB_SEARCH_BASE_URL` apuntan a OpenAI mientras el chat
va por otro sitio.

### Coste y cuotas

Una pregunta del agente son **2–4 llamadas al modelo**, no una: cada uso de una
herramienta es un viaje de ida y vuelta. Tenlo en cuenta al estimar el gasto con
OpenAI.

Si usas Groq, el límite que salta antes es el de **tokens**, no el de
peticiones, y cuenta `max_tokens` como solicitados aunque no se usen: con
`LLM_MAX_TOKENS=2048` cada llamada gasta unos 3.600 tokens del cupo. Contra un
límite diario de 100.000 eso son ~10 preguntas completas al día por modelo. El
límite es por modelo, así que cambiar `LLM_MODEL` renueva el cupo. No lo bajes
de 1024: los modelos que razonan antes de responder se quedan sin presupuesto y
devuelven una generación vacía.

## Interfaz web

La página muestra en la cabecera el modelo, cuántas herramientas hay activas y
el estado de la base de datos. Ese estado solo describe Postgres: si solo está
configurada Mongo, no aparece, y si responde Mongo pero no Postgres, Postgres
sale como conectada (`connected` mira si hay algún catálogo, no cuál). Para
saber qué hay activo de verdad, lo fiable es la lista de herramientas. Durante cada turno se van listando las llamadas a
herramientas, igual que en la consola, para que la espera no sea a ciegas.

| Endpoint | Qué hace |
|---|---|
| `GET /api/info` | Modelo, proveedor, herramientas, estado de Postgres, nº de memorias |
| `POST /api/chat` | Lanza un turno. Responde en **SSE** con los eventos según ocurren |
| `DELETE /api/chat?sessionId=…` | Olvida esa conversación (no toca la memoria permanente) |
| `GET /api/memories` | Lista lo recordado |
| `DELETE /api/memories/:id` | Borra una memoria |

Los eventos de `POST /api/chat` son `tool_call`, `tool_output`, `thinking`,
`answer`, `error` y `done`. Siempre termina en `done`, también si el turno
falla, para que el cliente no se quede colgado.

**Aviso de despliegue.** La API va con **CORS abierto y sin autenticación**:
está pensada para `localhost`. Quien pueda llamarla puede consultar tu base de
datos y gastar tu cuota de OpenAI. Antes de exponerla, ponle autenticación y
restringe el origen.

## Desarrollo

```bash
bun test              # 202 tests del agente y la API
bun run typecheck
bun run dev           # consola con recarga en caliente
bun run serve:dev     # API con recarga en caliente

cd frontend
bun test              # 22 tests del renderizador de markdown
bun run typecheck
bun run build         # comprueba que compila en produccion
```

Los tests no tocan la red ni la base de datos: el modelo se prueba contra un
servidor OpenAI-compatible falso, las tools de Postgres y de Mongo contra dobles
de cada base (el de Mongo delega en el validador real, para comprobar que las
tools no se lo saltan), la memoria contra SQLite en `:memory:` con un embedder falso, la búsqueda web
contra un `fetch` interpuesto, y `now` con un reloj inyectado. Todos
deterministas.

## Estructura

```
src/
├── index.ts            # entry point de consola: crea el runtime y lanza la REPL
├── config/             # lectura y validación del entorno
├── model/factory.ts    # único punto que conoce el proveedor concreto
├── db/                 # PostgreSQL
│   ├── guard.ts        # validador de solo-lectura (la pieza crítica)
│   ├── client.ts       # pool + transacción READ ONLY con timeout
│   └── introspect.ts   # catálogo de tablas y columnas
├── mongo/              # MongoDB
│   ├── guard.ts        # lista blanca de etapas + bloqueo de $out/$where
│   ├── client.ts       # acotado a una base, sin una sola operación de escritura
│   └── introspect.ts   # inferencia de esquema por muestreo
├── runtime.ts          # monta config, modelo, memoria y tools (lo comparten CLI y web)
├── server/
│   ├── index.ts        # servidor Bun
│   ├── api.ts          # rutas + SSE
│   └── sessions.ts     # una conversación por pestaña
├── memory/
│   ├── store.ts        # SQLite + FTS5 (triggers incluidos)
│   ├── embeddings.ts   # cliente de embeddings con degradación a FTS5
│   └── retrieval.ts    # búsqueda híbrida (coseno + FTS5, fusión RRF)
├── web/search.ts       # cliente de búsqueda web con extracción de citas
├── tools/
│   ├── now.ts          # fecha y hora (no depende de nada externo)
│   ├── memory.ts       # remember, recall, update_memory, forget
│   ├── web.ts          # web_search
│   ├── mongo.ts        # las cuatro tools de MongoDB
│   └── postgres.ts     # las tres tools de Postgres
├── agents/
│   ├── prompts.ts      # plantillas de prompt (el paquete npm no las trae)
│   ├── turn.ts         # un turno del agente, compartido por consola y web
│   └── sql-agent.ts    # ToolCallingAgent configurado (el nombre es anterior a Mongo)
├── cli/                # REPL, comandos y render
└── utils/errors.ts     # traducción de errores a mensajes accionables

frontend/               # Next.js 16 + React 19
├── app/
│   ├── chat.tsx        # el chat (client component)
│   └── page.tsx
└── lib/
    ├── api.ts          # cliente de la API, lector de SSE
    └── markdown.tsx    # renderizador mínimo (código, negrita, enlaces http/https)
```

## Limitaciones conocidas

### Del agente

- **`openai/gpt-oss-120b` y `-20b` no cierran el ciclo.** smolagents no envía
  las tool calls en el formato nativo de OpenAI: las aplana a texto dentro de
  mensajes `assistant`/`user` (`"Tool call fc_xxx: calling 'run_query'…"`).
  gpt-oss, entrenado sobre el formato nativo, responde vacío y Groq devuelve
  `tool_use_failed`. Arreglarlo de raíz exige reescribir
  `writeMemoryToMessages()` del agente.
- **No hay modo chat sin agente.** Como siempre hay al menos una herramienta,
  toda pregunta pasa por el ciclo ReAct. El código del chat directo se eliminó
  al quedar inalcanzable; con él se fue el streaming token a token, que el
  agente no tiene. `SYSTEM_PROMPT` ya no se usa.
- **El historial no se recorta ni se persiste.** En conversaciones largas se
  acabará superando la ventana de contexto.
- **No hay streaming del texto intermedio del agente.** Es deliberado: con
  `streamOutputs: true`, smolagents monta un `LiveBox` que mueve el cursor con
  `readline.moveCursor(process.stdout)` para redibujarse y se come nuestras
  líneas. El progreso se ve igual por las llamadas a tools.
- `Ctrl+C` durante una respuesta cierra el programa, no cancela solo esa
  respuesta: `generateStream()` no acepta señal de aborto.

### De la librería

Tres cosas que `smolagents.js@0.1.5` hace mal y que este proyecto sortea:

- **No distribuye sus plantillas de prompt.** `ToolCallingAgent` las carga con
  `loadPromptTemplates('src/prompts/toolcalling_agent.yaml')`, una ruta relativa
  al cwd que apunta a un fichero ausente del paquete npm; sin fallback, el
  agente arranca con el prompt vacío. Las aportamos en
  [src/agents/prompts.ts](src/agents/prompts.ts).
- **`verbosityLevel` no silencia nada**: `AgentLogger.log()` escribe siempre sin
  mirar `this.level`. Se sortea inyectando un `logger` propio.
- **Sus stop sequences se sabotean solas.** Pide parar en `'Calling tools:'`,
  que es exactamente lo que el propio agente escribe en el historial: el modelo
  reproduce el patrón, corta en vacío y Groq responde «model did not call a
  tool». Se eliminan en [src/model/factory.ts](src/model/factory.ts).

Además, `smolagents.js` declara `openai@^5` como peer dependency y aquí se usa
`^6` (verificado que funciona), y arrastra `vm2` —deprecado, con
vulnerabilidades de escape de sandbox— para su ejecutor de código. `vm2` se
carga al importar el agente, pero **nunca se ejecuta código en él**: hay que
resolverlo antes de habilitar `CodeAgent`. Ver `Rg3` en [SPEC.md](SPEC.md).
