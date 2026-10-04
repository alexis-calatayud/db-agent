# SPEC — Agente de IA de consola con smolagents (TypeScript + Bun)

- **Estado:** Fases 1 y 3 implementadas (ver §10)
- **Fecha:** 2026-07-27
- **Ámbito de este documento:** define el proyecto completo. La Fase 1 (uso del modelo) y la Fase 3 (`ToolCallingAgent` + tools de PostgreSQL) están entregadas; la Fase 2 y la 4 siguen pendientes.

---

## 1. Objetivo

Construir un agente de IA ejecutable desde la **consola**, escrito en **TypeScript** sobre **Bun**, apoyado en la librería **smolagents**. El destino final del proyecto es disponer de:

- `CodeAgent` (agente que razona escribiendo y ejecutando código),
- `ToolCallingAgent` (agente que razona invocando herramientas vía JSON),
- un catálogo de **tools** propias,
- memoria de conversación y trazas de ejecución.

Ese destino se alcanza por fases. **La Fase 1 se limita al uso del modelo**: conectar con un proveedor LLM, mandar mensajes y recibir respuesta (con streaming) desde una REPL de consola. Nada de agentes ni tools todavía.

## 2. Alcance

### 2.1 Dentro del alcance (Fase 1)

| # | Requisito |
|---|---|
| R1 | Proyecto Bun + TypeScript inicializado, con todo el código fuente bajo `./src` |
| R2 | Integración con smolagents para instanciar y usar un **modelo** (`OpenAIServerModel`) |
| R3 | Proveedor LLM con **API gratuita** para pruebas, sin tarjeta de crédito |
| R4 | Configuración por variables de entorno (`.env`), con validación al arranque y mensajes de error claros |
| R5 | REPL de consola: leer entrada del usuario, enviar al modelo, imprimir la respuesta |
| R6 | Historial de conversación en memoria durante la sesión (multi-turno) |
| R7 | Streaming de la respuesta token a token en la terminal |
| R8 | Comandos de consola: `/exit`, `/clear`, `/help`, `/model` |
| R9 | Manejo de errores de red / API / rate-limit sin tumbar el proceso |

### 2.2 Fuera del alcance (Fase 1)

- `CodeAgent`, `ToolCallingAgent` y cualquier bucle agéntico.
- Tools propias o built-in.
- Ejecución de código generado por el modelo (sandbox).
- Persistencia en disco del historial.
- Interfaz gráfica, web o API HTTP. **Sólo consola.**
- Multi-agente, planificación, RAG.

## 3. Stack técnico

| Pieza | Elección | Nota |
|---|---|---|
| Runtime | **Bun** ≥ 1.2 | Ejecuta TypeScript directo, sin paso de build en dev. Aporta `bun` como gestor de paquetes, test runner y carga nativa de `.env` |
| Lenguaje | **TypeScript** en modo `strict` | ESM (`"type": "module"`) |
| Framework de agentes | **`smolagents.js`** (npm) | Port TypeScript de la librería `smolagents` de Hugging Face |
| Peer dependency | **`openai`** ^5 | Requerida por `OpenAIServerModel` de smolagents.js; se instala explícitamente |
| Proveedor LLM | **Groq** (endpoint OpenAI-compatible) | Ver §4 |
| Lint / formato | Biome (o ESLint + Prettier) | A decidir en implementación; no bloquea la Fase 1 |
| Tests | `bun test` | Cobertura mínima en Fase 1: config y formateo de mensajes |

### 3.1 Nota sobre la elección de librería

`smolagents` original es Python. Para cumplir el requisito de TypeScript/Bun se usa **`smolagents.js`**, port directo que conserva la nomenclatura y los conceptos de la librería original (`Model`, `OpenAIServerModel`, `ToolCallingAgent`, `tool()`, `Memory`, `Tool`). Se ha verificado su superficie pública, que incluye lo necesario para las fases previstas.

**Riesgos asumidos, documentados en §9.**

## 4. Proveedor de modelo (API gratuita)

### 4.1 Elección: Groq

- **Base URL:** `https://api.groq.com/openai/v1`
- **Coste:** gratuito, sin tarjeta de crédito. Sólo requiere alta y generar API key.
- **Compatibilidad:** API OpenAI-compatible → funciona directamente con `OpenAIServerModel({ apiBase, apiKey })` de smolagents.js.
- **Modelo por defecto:** `llama-3.3-70b-versatile`.
- **Alternativa dentro del mismo proveedor:** `openai/gpt-oss-120b`, `qwen/qwen3-32b`, `llama-3.1-8b-instant` (más rápido/barato en cuota).
- **Soporte de *tool calling*:** sí — condición necesaria para la Fase 3 (`ToolCallingAgent`), por eso se descartan modelos gratuitos que sólo hacen chat.
- **Límites del plan gratuito (orientativos, verificar en la consola de Groq):** ~30 req/min y ~1.000 req/día por modelo. Suficiente para desarrollo y pruebas.

### 4.2 Alternativas contempladas

| Proveedor | Base URL | Por qué no es el default |
|---|---|---|
| OpenRouter (modelos `:free`) | `https://openrouter.ai/api/v1` | Cuota gratuita más restrictiva (~50 req/día sin créditos comprados) y el catálogo `:free` rota sin aviso |
| Google Gemini (endpoint OpenAI-compat) | `https://generativelanguage.googleapis.com/v1beta/openai/` | Válido, pero compatibilidad OpenAI parcial en algunos campos |
| Cerebras | `https://api.cerebras.ai/v1` | Buen candidato secundario; catálogo de modelos más corto |

**Requisito de diseño derivado:** como los cuatro proveedores son OpenAI-compatible, la elección debe ser **configurable por entorno** (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) y **no estar hardcodeada**. Cambiar de proveedor debe ser editar el `.env`, no tocar código.

## 5. Estructura del proyecto

Todo el código fuente vive en `./src`.

```
.
├── SPEC.md
├── README.md
├── package.json
├── tsconfig.json
├── .env.example              # plantilla versionada
├── .env                      # real, en .gitignore
├── .gitignore
└── src/
    ├── index.ts              # entry point: arranca la CLI
    ├── config/
    │   ├── env.ts            # lectura + validación de variables de entorno
    │   └── types.ts          # tipos de configuración
    ├── model/
    │   └── factory.ts        # createModel(): construye el OpenAIServerModel de smolagents
    ├── cli/
    │   ├── repl.ts           # bucle principal de la consola
    │   ├── commands.ts       # /exit /clear /help /model
    │   └── render.ts         # colores, spinner, impresión de streaming
    ├── conversation/
    │   └── history.ts        # historial de ChatMessage en memoria
    ├── agents/               # (vacío en Fase 1 — reservado para Fase 2/3)
    ├── tools/                # (vacío en Fase 1 — reservado para Fase 3)
    └── utils/
        └── errors.ts         # normalización de errores de API
```

Las carpetas `agents/` y `tools/` se crean vacías (con `.gitkeep`) para fijar la arquitectura desde el principio.

## 6. Configuración

### 6.1 Variables de entorno

| Variable | Obligatoria | Default | Descripción |
|---|---|---|---|
| `LLM_API_KEY` | **Sí** | — | API key del proveedor |
| `LLM_BASE_URL` | No | `https://api.groq.com/openai/v1` | Endpoint OpenAI-compatible |
| `LLM_MODEL` | No | `llama-3.3-70b-versatile` | ID del modelo |
| `LLM_TEMPERATURE` | No | `0.7` | Temperatura de muestreo |
| `LLM_MAX_TOKENS` | No | `2048` | Límite de tokens de salida |
| `LLM_REQUESTS_PER_MINUTE` | No | `25` | Rate limiter cliente, por debajo de la cuota del proveedor |
| `SYSTEM_PROMPT` | No | (prompt genérico de asistente) | Mensaje de sistema inicial |
| `LOG_LEVEL` | No | `info` | `debug` \| `info` \| `warn` \| `error` |

### 6.2 Reglas

- `.env` **nunca** se versiona. `.env.example` sí, con valores de ejemplo y sin secretos.
- La validación ocurre **una sola vez al arranque**, en `src/config/env.ts`. Si falta `LLM_API_KEY`, el programa termina con código de salida `1` y un mensaje que indica qué variable falta y cómo obtenerla.
- La API key nunca se imprime por consola ni en logs, ni siquiera en `LOG_LEVEL=debug`.

## 7. Diseño funcional (Fase 1)

### 7.1 Contrato del módulo de modelo

`src/model/factory.ts` expone una única función:

```ts
import { OpenAIServerModel } from 'smolagents.js';
import type { AppConfig } from '../config/types';

export function createModel(config: AppConfig): OpenAIServerModel;
```

Construye el modelo con `modelId`, `apiKey`, `apiBase` y `requestsPerMinute` tomados de la config. Es el **único** punto del código que conoce el proveedor concreto; el resto de la aplicación trabaja contra el tipo `Model` de smolagents.

### 7.2 Historial

`src/conversation/history.ts` mantiene un `ChatMessage[]` de smolagents.js con los roles `SYSTEM`, `USER` y `ASSISTANT`. Expone `add()`, `getAll()`, `clear()` y `size()`. El mensaje de sistema se inserta al crear el historial y sobrevive a `clear()`.

### 7.3 Flujo de la REPL

1. Cargar y validar configuración.
2. Crear el modelo y el historial (con el system prompt).
3. Imprimir banner: modelo activo, proveedor y sugerencia de `/help`.
4. Bucle:
   1. Leer línea del usuario.
   2. Si empieza por `/`, resolver como comando y volver al paso 4.1.
   3. Añadir el mensaje del usuario al historial.
   4. Llamar a `model.generateStream({ messages })` e ir imprimiendo cada `delta.content` conforme llega.
   5. Componer la respuesta completa, añadirla al historial como `ASSISTANT`.
   6. Mostrar el consumo de tokens de la llamada si `LOG_LEVEL=debug`.
5. `Ctrl+C` o `/exit` → cierre limpio con código `0`.

### 7.4 Comandos

| Comando | Efecto |
|---|---|
| `/help` | Lista los comandos disponibles |
| `/clear` | Vacía el historial conservando el system prompt |
| `/model` | Muestra modelo, base URL y parámetros activos |
| `/exit` | Termina la sesión |

### 7.5 Manejo de errores

Los errores se normalizan en `src/utils/errors.ts` y **nunca abortan la REPL**: se imprime un mensaje legible y se vuelve al prompt.

| Situación | Comportamiento |
|---|---|
| 401 / 403 | "API key inválida o sin permisos" + recordatorio de revisar `LLM_API_KEY` |
| 429 | "Límite de peticiones alcanzado" + segundos sugeridos de espera |
| 5xx / timeout / red | Mensaje de error transitorio; el turno del usuario se descarta del historial para poder reintentar |
| Modelo desconocido (404) | Mensaje indicando que `LLM_MODEL` no existe en el proveedor |

## 8. Criterios de aceptación (Fase 1)

La Fase 1 se considera terminada cuando:

1. `bun install` completa sin errores en un clon limpio.
2. `bun run src/index.ts` con un `.env` válido abre la REPL y responde a una pregunta en lenguaje natural.
3. La respuesta se imprime **en streaming**, no de golpe al final.
4. Una conversación de tres turnos demuestra que el modelo recuerda el contexto anterior.
5. Los cuatro comandos de §7.4 funcionan como se describe.
6. Arrancar sin `LLM_API_KEY` produce un error explicativo y salida `1`, no un stack trace.
7. Una API key inválida produce el mensaje de §7.5 y la REPL sigue viva.
8. Cambiar `LLM_BASE_URL` + `LLM_MODEL` a otro proveedor OpenAI-compatible funciona **sin tocar código**.
9. `bunx tsc --noEmit` pasa sin errores en modo `strict`.
10. El `README.md` documenta cómo obtener la API key gratuita y arrancar el proyecto.

## 9. Riesgos y decisiones abiertas

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| Rg1 | `smolagents.js` está en versión temprana (0.1.x) y su última publicación es de agosto de 2025. Mantenimiento incierto | Medio | Aislar la librería tras `src/model/factory.ts` y los futuros wrappers de `src/agents`. Si hubiera que sustituirla, el blast radius queda acotado |
| Rg2 | `CodeAgent` existe en el árbol de la librería pero **no está exportado** en la API pública de la 0.1.5; sólo `ToolCallingAgent` lo está | **Alto para la Fase 4** | Se decide en la Fase 4, con tres salidas: fijar una versión posterior que lo exporte, importarlo por ruta interna, o implementar el bucle de CodeAgent sobre `MultiStepAgent`. No bloquea las Fases 1–3 |
| Rg3 | La librería arrastra `vm2` como dependencia, paquete **deprecado con vulnerabilidades críticas de escape de sandbox**, usado por su executor de código local | **Alto para la Fase 4**, nulo en Fase 1 | En Fase 1 no se ejecuta código, así que la ruta vulnerable nunca se alcanza. Antes de habilitar `CodeAgent` hay que sustituir el executor (p. ej. subproceso Bun aislado o contenedor) o descartar el executor local |
| Rg4 | Las cuotas gratuitas y los catálogos de modelos gratuitos cambian sin aviso | Bajo | Proveedor y modelo configurables por `.env` (§4.2); documentar dos alternativas en el README |
| Rg5 | Los modelos gratuitos tienen ventanas de contexto limitadas; el historial crecerá sin control | Bajo en Fase 1 | Fase 1 no recorta historial. Se aborda en Fase 2 con truncado o resumen |

**Decisiones que quedan abiertas y no bloquean la Fase 1:** elección de linter, estrategia de gestión de contexto largo, y si el sandbox de código será subproceso o contenedor.

## 10. Hoja de ruta

| Fase | Contenido | Estado |
|---|---|---|
| **1** | Andamiaje del proyecto + uso del modelo desde consola (§2.1) | **Entregada** |
| **3** | `ToolCallingAgent` + tres tools de PostgreSQL de solo lectura (§11) | **Entregada** (adelantada a petición del usuario) |
| **2** | Gestión de contexto largo: recorte o resumen del historial y de la memoria del agente | Pendiente |
| **4** | `CodeAgent` con executor de código seguro (resuelve Rg2 y Rg3) | Pendiente, condicionada |
| **5** | Multi-agente / agentes gestionados, si procede | Idea |

---

## 11. Fase 3 — Acceso de solo lectura a PostgreSQL

### 11.1 Alcance entregado

`ToolCallingAgent` que responde preguntas en lenguaje natural consultando una base
de datos PostgreSQL, con tres tools: `list_tables`, `describe_table` y `run_query`.
Se le suma `now`, que no depende de la base de datos y está siempre disponible:
el modelo no tiene reloj, y sin ella responde con la fecha que recuerde de su
entrenamiento.

Como `now` está siempre presente, el agente se crea siempre. La consecuencia es
que **el modo chat directo de la Fase 1 ha dejado de ser alcanzable**: su código
sigue en el repositorio pero ninguna configuración lo activa. Queda pendiente
decidir si se elimina o se expone con un conmutador.

### 11.2 Modelo de seguridad

El requisito «solo lectura» se cumple con **dos barreras independientes**, de modo
que ninguna dependa de que la otra funcione:

1. **Validador de SQL** (`src/db/guard.ts`). Enmascara comentarios, cadenas,
   identificadores entrecomillados y literales `$$`, y sobre el texto resultante
   exige una única sentencia que empiece por `SELECT`, `WITH`, `EXPLAIN`, `SHOW`,
   `TABLE` o `VALUES`. Rechaza DML/DDL, CTE que escriben, `SELECT INTO`,
   `EXPLAIN ANALYZE`, control de transacción, `SET` y funciones que tocan el
   servidor. Enmascarar primero es lo que evita tanto los falsos positivos
   (`WHERE accion = 'delete'`) como las evasiones (`/* */ DROP`).
2. **Transacción `READ ONLY`** (`src/db/client.ts`). `SET TRANSACTION READ ONLY`
   más `SET LOCAL statement_timeout` en cada consulta. Verificado contra la base
   real: `CREATE TABLE` dentro de esa transacción falla con *cannot execute
   CREATE TABLE in a read-only transaction*.

Complementos: toda consulta se envuelve en `SELECT * FROM (...) LIMIT n`, de forma
que el tope de filas no depende del modelo; y la salida de cada tool se corta a
6.000 caracteres.

**Límite explícito:** esto protege de errores y desvíos del modelo, no sustituye a
los permisos de base de datos. Lo recomendable sigue siendo un rol de solo lectura.

### 11.3 Decisiones de diseño

| Decisión | Motivo |
|---|---|
| El catálogo de tablas se lee al arrancar y se inyecta en el prompt de sistema | Sin él, los modelos pequeños inventan tablas de `information_schema` y agotan los pasos |
| `streamOutputs: false` | Con streaming, el `LiveBox` de smolagents mueve el cursor de la terminal y se come la salida propia |
| Logger propio y mudo | `verbosityLevel` no funciona: `AgentLogger.log()` ignora `this.level` |
| Plantillas de prompt propias | El paquete npm no distribuye su YAML y el agente arrancaría sin instrucciones |
| Se eliminan las stop sequences | smolagents pide parar en `'Calling tools:'`, cadena que él mismo escribe en el historial: el modelo la reproduce, corta en vacío y el proveedor rechaza la petición |
| Reintento ante `tool_use_failed` | Un tropiezo puntual del modelo tiraba el turno entero y todo el trabajo previo |
| Modelo por defecto `qwen/qwen3.6-27b` | Es el modelo gratuito probado que completa el ciclo de forma fiable (ver Rg6) |

### 11.4 Riesgos añadidos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| Rg6 | smolagents aplana las tool calls a texto en vez de usar el formato nativo de OpenAI. Los modelos gpt-oss no cierran el ciclo | Medio | Documentado; se usa un modelo que sí lo tolera. La solución de raíz es reescribir `writeMemoryToMessages()` |
| Rg9 | La familia `gpt-5.x` / `o1` / `o3` / `o4` cambia el contrato de la API: exige `max_completion_tokens` y rechaza cualquier temperatura que no sea la suya | Bajo | `modelQuirks()` en `src/model/factory.ts` detecta la familia por el id y adapta la petición; hay tests. Un modelo futuro con otro contrato daría un error explícito del proveedor |
| Rg10 | Los modelos `gpt-5.6-*` y los `*-pro` no admiten function tools en `/v1/chat/completions`: necesitarían la Responses API, que smolagents no usa | Bajo | Documentados como no utilizables en el README y `.env.example` |

---

## 12. Memoria permanente

### 12.1 Alcance entregado

El agente guarda datos entre sesiones **solo cuando el usuario se lo pide**, y los
recupera solo cuando vienen al caso. Cuatro tools (`remember`, `recall`,
`update_memory`, `forget`), almacenamiento en SQLite local y comando `/memories`
para revisarlo y limpiarlo sin pasar por el modelo.

### 12.2 Decisiones de diseño

| Decisión | Motivo |
|---|---|
| SQLite vía `bun:sqlite` | Persistencia y FTS5 sin añadir dependencias. La Postgres de MIBGAS no vale: es de solo lectura por diseño |
| Búsqueda híbrida (embeddings + FTS5) fusionada con *reciprocal rank fusion* | Medido: embeddings 5/6 aciertos frente a 2/6 de FTS5 con preguntas parafraseadas. RRF combina rankings sin normalizar escalas incompatibles |
| Coseno por fuerza bruta en JS | 1.000 memorias × 1536 dimensiones es ~1,5 M operaciones, por debajo del milisegundo. No justifica una extensión nativa como `sqlite-vec` |
| Embeddings opcionales y degradación perezosa | Groq no ofrece el endpoint. Se comprueba al primer uso, no al arrancar, para no gastar nada si no se usa la memoria |
| Fijas en `instructions`, relevantes en el texto de la pregunta | Las fijas cambian poco, así el prefijo del prompt se mantiene estable y la caché del proveedor sigue sirviendo. Lo variable va donde no se cachea igualmente |
| Inyección automática por pregunta | Depender de que el modelo llame a `recall` hace la memoria poco fiable |
| Guardar solo a petición del usuario | Evita acumular ruido y memorizar cosas equivocadas, que contaminarían todas las respuestas siguientes |

### 12.3 Riesgos añadidos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| Rg11 | Lo recordado se envía al proveedor del modelo en cada pregunta que lo recupere | Medio | Documentado en el README: nada de credenciales ni datos personales |
| Rg12 | Inyección indirecta: una memoria es texto que acaba en el prompt | Bajo, al guardarse solo a petición | El prompt declara que el contexto recordado es información, nunca instrucciones |
| Rg13 | Una memoria equivocada envenena respuestas futuras | Medio | `/memories`, `/memories borrar <id>`, `forget` y `update_memory` |

### 12.4 Dos trampas de la librería encontradas al integrar

- **`type: 'integer'` en una tool la vuelve inejecutable.** `'integer'` está en
  `AUTHORIZED_TYPES`, pero `validateToolArguments` compara contra `typeof`, que
  para un número de JS devuelve `'number'`. La validación falla siempre, la tool
  nunca se ejecuta y el modelo la reintenta sin entender por qué. Solo casaría
  con un `bigint`, que JSON no produce. Hay test de regresión.
- **`_processToolCalls` emite un evento por cada tool call pero las deduplica por
  id antes de ejecutarlas.** Si el modelo repite la misma id, la consola pintaba
  varias veces una llamada que solo ocurre una. Se deduplica al renderizar.

### 12.5 Corrección de robustez asociada

Al integrar se descubrió que **una caída de Postgres tumbaba el programa entero al
arrancar**, dejando inservibles `now` y la memoria, que no dependen de la base.
Ahora el fallo se degrada: avisa, arranca sin las tools de Postgres y el banner
marca la base como `NO DISPONIBLE`.
| Rg7 | Las cuotas gratuitas dan para ~10 preguntas completas al día por modelo: `max_tokens` se factura entero aunque no se use | Medio | Documentado en el README; el límite es por modelo, así que cambiar `LLM_MODEL` renueva el cupo |
| Rg8 | El usuario `postgres` de la base es superusuario | Bajo, dadas las dos barreras | Recomendado en README y `.env.example` apuntar a un rol de solo lectura |

---

## Fuentes

- [huggingface/smolagents (librería original)](https://github.com/huggingface/smolagents)
- [smolagents.js en npm](https://www.npmjs.com/package/smolagents.js)
- [Groq — free tier, límites y configuración](https://www.free-model.com/providers/groq/)
- [Groq API free tier 2026: límites reales](https://www.grizzlypeaksoftware.com/articles/p/groq-api-free-tier-limits-in-2026-what-you-actually-get-uwysd6mb)
- [OpenRouter free tier: límites y modelos](https://klymentiev.com/blog/openrouter-free-tier)
- [Free LLM API tiers en 2026: Groq, Cerebras, Mistral](https://ianlpaterson.com/blog/free-llm-api-2026/)


---

## 13. Búsqueda en internet

### 13.1 Alcance entregado

Tool `web_search`: devuelve un resumen de lo encontrado más la lista de URLs
consultadas, sin repetir dominios. Cubre datos actuales o externos que no están
ni en la base de datos ni en la memoria.

### 13.2 Decisión de proveedor

Se apoya en un **modelo de OpenAI con búsqueda integrada**
(`gpt-4o-mini-search-preview` por defecto) en lugar de en una API de búsqueda
dedicada como Brave o Tavily. Motivo: reutiliza la `LLM_API_KEY` existente, sin
dar de alta otro servicio ni añadir otra credencial al `.env`.

Coste medido con la misma pregunta contra la API real:

| Modelo | Tokens de prompt | Citas |
|---|---|---|
| `gpt-4o-mini-search-preview` | 12 | 2 |
| `gpt-4o-search-preview` | 12 | 3 |
| `gpt-5-search-api` | 31.020 | 7 |

Los `*-search-preview` facturan la búsqueda como tarifa aparte; `gpt-5-search-api`
mete el contenido recuperado en el prompt, de ahí la diferencia.

### 13.3 Riesgos añadidos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| Rg14 | Quien busca y redacta es otro modelo: el agente recibe prosa ya interpretada, que puede estar desactualizada o ser incorrecta | Medio | La tool devuelve las URLs por separado y el prompt obliga a citarlas y a no presentarlas como dato propio |
| Rg15 | El contenido de páginas web acaba en el prompt: superficie de inyección indirecta | Medio | El prompt marca el resultado como información de terceros, nunca como instrucciones. No se ejecuta nada de lo que devuelva |
| Rg16 | Groq no ofrece modelos con búsqueda web | Bajo | Degradación perezosa: aviso una vez y la tool responde que no está disponible. Cubierto por test; no verificado contra Groq real por no disponer de key válida |
| Rg17 | Cada búsqueda es una llamada facturable adicional dentro de un turno que ya son 2-4 llamadas | Bajo | Documentado; el prompt indica no usarla para lo que ya cubren las otras tools, y se comprobó que respeta la regla |
