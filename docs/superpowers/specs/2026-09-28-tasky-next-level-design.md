# Tasky — "Next level": generación de archivos, respuestas, contexto, compatibilidad de modelos y frontend

Fecha: 2026-09-28 · Estado: aprobado por el usuario de antemano ("arma plan y ejecuta sin preguntar nada") · Camino: arquitectural

## 1. Entendimiento

**Pedido textual:** mejora completa de Tasky: mejor generación de archivos y de respuestas, mejor manejo de contexto "y todo", mejores detalles de frontend, compatibilidad con diferentes modelos. Ejecutar sin preguntar.

**Supuestos (decididos por mí, documentados):**
- Se conserva la identidad actual (tema oscuro, acento índigo, layout área/chat). Se pulen detalles, no se rediseña la marca.
- Se conserva el contrato de storage en disco y la compatibilidad con chats/archivos existentes (logs `.jsonl` viejos se siguen leyendo).
- Proveedores siguen siendo OpenRouter y NVIDIA NIM (API OpenAI-compatible). No se agregan proveedores nuevos.
- Sin dependencias pesadas nuevas (ni LibreOffice ni vector DB). Python docengine sigue siendo el motor de archivos.
- No se hacen commits automáticos; el trabajo queda en el árbol de trabajo (el WIP previo quedó respaldado en el scratchpad de la sesión).

**Criterios de éxito:**
1. Un chat normal responde en streaming (texto aparece token a token) y se puede detener.
2. Pedir un Word/Excel/PowerPoint produce un archivo con contenido real y bien formateado, incluso con modelos débiles (markdown, alias de campos, números como texto, etc. se normalizan).
3. Si el docengine rechaza el payload, el modelo recibe el error y se autocorrige (hasta 2 reintentos) antes de rendirse.
4. El contexto respeta el tamaño real de la ventana del modelo: historial recortado/compactado, archivos del área recuperados por relevancia a nivel de fragmento, reglas desactivadas y textos plantilla fuera del prompt.
5. Funciona con modelos con y sin function calling, con modelos de razonamiento (`reasoning`, `reasoning_content`, `<think>`), con modelos que emiten tool-calls como texto (Hermes/Qwen, Mistral, DeepSeek, Llama), y se adapta en caliente a errores de parámetros (`tools`, `temperature`, `max_tokens`, `response_format`).
6. Cada proveedor recuerda su propio modelo (hoy comparten uno: bug que causa 404).
7. Frontend responsive, con adjuntos reales en el composer, tarjetas de archivo con vista previa, markdown completo (tablas, código con copiar), estado vacío, selector de modelos con búsqueda y capacidades, y sin errores de lint.
8. Suite de tests verde (Node + Python), incluyendo pruebas end-to-end del chat contra un LLM simulado.

## 2. Diagnóstico (evidencia)

| Problema | Evidencia |
|---|---|
| Chat roto en el WIP | `messageId`/`ts` usados sin declarar en `index.js` (ReferenceError → 502) |
| Archivos truncados/blancos | `max_tokens: 4096` fijo; payloads grandes cortados; regla "máx 10 filas" como parche |
| 404 frecuentes | modelo compartido entre proveedores; modelos free sin endpoint con tools; 8/33 errores reales son 404 |
| Errores internos | 11/33 errores reales son 502 sin status upstream (excepciones internas, fallas de generación no aisladas) |
| Rate limit en free | 12/33 errores son 429; solo 1 reintento |
| Contexto ruidoso | reglas `disabled` y plantillas "**Instrucciones:**…" se inyectan como reglas reales |
| Contexto ciego | el modelo no conoce rutas de archivos generados → no puede editarlos; adjuntos se pierden en el turno siguiente |
| Contexto caro | cada mensaje re-extrae PDFs/DOCX completos; scoring solo por primeros 500 chars |
| Historial sin límite | el cliente manda toda la conversación; sin presupuesto de tokens |
| Editor PPTX | envuelve la clave con `{{ }}` otra vez → plantillas nunca coinciden |
| DOCX | `**negrita**` se imprime literal; sin listas anidadas; tablas sin anchos ni header repetido |
| XLSX | números como texto rompen SUM/gráficos; fila resumen suma columnas de texto; gráfico duplica datos en bloque auxiliar |
| PPTX | texto desborda; `slide_number` no hace nada; scatter cae a barras |
| Frontend | sin media queries; botón adjuntar sube a raíz del proyecto (no adjunta al mensaje); `window.prompt` para reglas/áreas; indicador "escribiendo" estático; `select` con 450 modelos sin búsqueda; 3 errores de lint |

## 3. Arquitectura

### 3.1 Backend Node (`apps/api/src`)

`index.js` (2100 líneas) se divide. Rutas quedan en `index.js`; la lógica se mueve a módulos con una sola responsabilidad:

```
src/
  index.js                 rutas Express + re-exports de compatibilidad para tests
  config.js                user-config (+ models por proveedor, migración)
  storage.js               sin cambios de contrato
  llm-client.js            fachada de compatibilidad (llmChat/nvidiaChat, providers)
  llm/
    providers.js           keys, modelo por proveedor, proveedor activo
    capabilities.js        perfil de modelo: contexto, max output, tools, visión, razonamiento, temperature
    client.js              chatCompletion(): streaming SSE + no-stream, reintentos adaptativos
    normalize.js           <think>, reasoning, tool-calls en texto (Hermes/Mistral/DeepSeek/Llama)
    errors.js              clasificación de errores → {kind, title, hint}
  context/
    extract.js             extracción de texto (pdf/docx/pptx/xlsx/texto) con caché por mtime
    retrieval.js           chunking + BM25 sobre fragmentos
    budget.js              estimación de tokens y reparto del presupuesto
    project.js             reglas activas, resúmenes (sin plantillas), historial del área, archivos generados
    history.js             historial desde el .jsonl, notas de archivos, recorte y compactación
  chat/
    prompt.js              system prompt: núcleo estable + referencia de payloads + contexto dinámico
    tools.js               definiciones y ejecución: generate_file, edit_file, read_file
    protocol.js            protocolo de texto (```tasky-file```) + parser legacy JSON + normalizeFileGenerated
    service.js             runChat(): loop agente (máx 5 pasos), eventos, persistencia
    sse.js                 escritor SSE
  generators/docengine.js  CLI Python + sidecar de fuente + nombres versionados
```

### 3.2 Flujo de un mensaje

1. `POST /api/projects/:id/chat` (JSON o multipart). Si `Accept: text/event-stream` → SSE; si no → JSON (compatibilidad y tests).
2. Adjuntos se guardan en `files/uploads/<areaId>/<chatId>/` y se registran en el mensaje del usuario (texto extraído vía caché).
3. El servidor es la fuente de verdad del historial: lee el `.jsonl`, agrega el nuevo mensaje del usuario (o, con `regenerate: true`, descarta lo posterior al último mensaje del usuario).
4. `capabilities.getModelProfile()` define ventana, `max_tokens`, modo (tools nativas vs protocolo de texto) y visión.
5. `budget` reparte: núcleo del prompt → reglas/resúmenes → archivos generados → fragmentos recuperados (BM25) → adjuntos → historial (más reciente primero, resumen de compactación si existe).
6. `service.runChat` llama al modelo en streaming. Eventos al cliente: `status`, `reasoning`, `delta`, `file`, `done`, `error`.
7. Tool calls (nativas o extraídas del texto) se ejecutan. `generate_file` inválido devuelve el error resumido al modelo para que corrija. `read_file` devuelve texto (y la fuente JSON si es un archivo generado).
8. Fin: se persiste el mensaje del asistente con `files[]` (y `file` = primero, compatibilidad), `usage`, `model`. Si el historial supera el umbral se dispara compactación en segundo plano.

### 3.3 Compatibilidad de modelos

- **Perfil del modelo:** OpenRouter → `/models` (caché 1 h): `context_length`, `top_provider.max_completion_tokens`, `supported_parameters` (`tools`, `temperature`, `reasoning`, `response_format`), `architecture.input_modalities`. NVIDIA → heurísticas por nombre (familias conocidas) + valores por defecto conservadores.
- **Aprendizaje en caliente** (persistido en `storage/model-capabilities.json`):
  - 400/404/422 que mencionan tools / "No endpoints found that support tool use" → `tools:false`, reintenta en protocolo de texto.
  - error por `temperature` → se omite.
  - error por `max_tokens`/contexto → se reduce (usa el número del mensaje si existe).
  - 402 "can only afford N" → reintenta con `max_tokens` menor si N ≥ 1024.
  - 429/503 → hasta 2 reintentos con `retry-after`/backoff exponencial + jitter.
- **Normalización de salida:** `reasoning`/`reasoning_content` → canal de razonamiento; `<think>…</think>` removido del contenido (también en streaming); tool-calls en texto (`<tool_call>`, `[TOOL_CALLS]`, tokens DeepSeek ASCII y full-width, `<|python_tag|>`, JSON `{"name","arguments|parameters"}`) → tool calls reales; argumentos como objeto o string.
- **Protocolo de texto** (modelos sin tools): respuesta en markdown + bloque opcional ```` ```tasky-file ```` con `{type, filename, summary, data}`. Parser tolerante: también acepta ```` ```json ```` con forma de archivo, wrapper legacy `{content, fileGenerated}`, objeto suelto. El bloque nunca se muestra al usuario (se filtra también durante el streaming).
- **Errores claros:** 404 de modelo inexistente, 404 de política de datos de OpenRouter (modelos free), 401/402/429 con sugerencias accionables.

### 3.4 Contexto

- **Reglas:** se parsean (`### nombre / - desc / \`enabled|disabled\``); solo las activas llegan al prompt, como lista limpia. Plantillas por defecto (detectadas por su marcador "**Instrucciones:**") se tratan como vacías.
- **Recuperación:** archivos del área + adjuntos del chat → fragmentos de ~1.200 caracteres con solapamiento → BM25 contra los últimos mensajes del usuario (con tokenización que normaliza tildes). Se inyectan los mejores fragmentos hasta el presupuesto; archivos chicos entran completos. Índice de archivos (nombre, tipo, tamaño) siempre visible para el modelo.
- **Caché de extracción** por ruta+mtime+tamaño (LRU en memoria) → no se re-parsean PDFs en cada mensaje.
- **Historial:** desde el `.jsonl`; mensajes del asistente con archivos incluyen nota `[Archivo generado: nombre (tipo) — ruta]`; errores y mensajes vacíos se excluyen. Si no entra, se recorta desde lo más viejo y se antepone el resumen de compactación (`<chatId>.summary.json`) cuando existe.
- **Archivos generados del área:** lista con ruta, resumen y fecha para que el modelo pueda leer (`read_file`) y regenerar versiones.
- **Fecha actual** e idioma de respuesta en el prompt.

### 3.5 Generación de archivos

- **Herramientas:** `generate_file {type, filename, summary, data}`, `edit_file {path, changes}` (plantillas/reemplazos/celdas sobre archivos existentes), `read_file {path, offset?}`.
- **Node:** normaliza errores de forma comunes (contenido fuera de `data`, `data` string, claves `schema/document/content`, tipo por extensión), escribe sidecar `files/generated/.tasky/<archivo>.json` con la fuente, y versiona nombres (`informe.docx` → `informe-v2.docx`). La generación fallida ya no rompe el chat.
- **Python (docengine):** capa `normalize.py` antes de pydantic:
  - DOCX: alias de secciones (`h1`, `title`, `text`, `list`, `ol`…), `data.markdown` o sección `markdown` → secciones, tablas desde lista de objetos, ítems anidados.
  - XLSX: números/porcentajes/moneda/fechas en texto → tipos reales con formato; filas como objetos → headers+rows.
  - PPTX: alias de layouts, bullets en string, sub-bullets.
  - Uniones discriminadas (`type`/`layout`) → errores legibles; `cli.py` devuelve resumen corto de errores (ruta + mensaje) para el modelo.
- **Builders:**
  - DOCX: markdown inline (negrita, cursiva, código, links), listas anidadas, callouts (info/advertencia/éxito), tablas con anchos, fila de encabezado repetida y números alineados a la derecha, portada opcional, encabezado/pie "Página X de Y", espaciado tipográfico consistente, fuente aplicada también a East Asian.
  - XLSX: Excel Table real con estilo, ancho de columnas por contenido, formatos numéricos por columna, fila resumen solo en columnas numéricas, gráficos que referencian el rango real (varios por hoja), congelar encabezado por defecto.
  - PPTX: diseño con banda de acento, auto-reducción de fuente según cantidad de texto, sub-bullets, número de diapositiva real, layouts nuevos `stats` (KPIs) y `agenda`, tablas largas partidas en varias diapositivas, scatter real (XY), doughnut/área/barras apiladas, etiquetas de datos opcionales.
  - Editores: reemplazo que cruza runs en DOCX (incluye tablas, encabezados, pies), plantillas `{{clave}}` y `clave` en PPTX, XLSX con hojas nuevas y `update_cells` por nombre de hoja.
- **Sin límite artificial de 10 filas:** guía "incluye todos los datos pedidos; si son más de ~300 filas genera una muestra representativa y dilo".

### 3.6 API nueva/cambiada

| Método | Ruta | Cambio |
|---|---|---|
| POST | `/api/projects/:id/chat` | SSE opcional, `message` o `messages`, `regenerate`, adjuntos persistidos, `files[]` |
| GET | `/api/projects/:id/preview?path=` | vista previa: docx → markdown, xlsx → hojas/filas, pptx → diapositivas, texto |
| GET | `/api/projects/:id/generated?areaId=` | archivos generados del área (desde sidecars) |
| GET | `/api/models` | agrega `contextLength`, `tools`, `vision`, `reasoning` por modelo |
| GET | `/api/status` | agrega `capabilities` del modelo activo |

### 3.7 Frontend (`apps/web/app`)

- `lib/api.ts`: `streamChat()` con `fetch` + lector SSE, `AbortController`, adjuntos multipart.
- `hooks/useChat.ts`: estado de mensajes, envío, streaming, detener, regenerar (saca esa lógica de `page.tsx`).
- `ChatPanel`: mensaje en streaming con cursor, chip de estado ("Generando informe.docx…", "Leyendo contrato.pdf"), razonamiento colapsable con segundos, acciones copiar/regenerar, tarjetas de archivo múltiples, estado vacío con 3 sugerencias.
- `FileCard` + `FilePreview` (drawer): color/ícono por tipo, vista previa, descargar, guardar en historial.
- `Composer`: chips de adjuntos (quitar), arrastrar y soltar, pegar archivos, botón detener, `isComposing` para IME, enviar deshabilitado cuando corresponde.
- `MarkdownRenderer`: tablas, bloques de código con copiar, citas, links en pestaña nueva, headings.
- `ModelSelectorModal`: lista con búsqueda, filtro "gratis", badges (tools, visión, contexto), modelo recordado por proveedor.
- `Sidebar`/`SidePanel`: renombrar área inline; editor de reglas inline (sin `window.prompt`); lista de archivos generados del área.
- CSS: contenedor de lectura centrado (no `padding: 20%`), media queries (≤ 900 px sidebar superpuesta, ≤ 600 px compacto), `100dvh`, `:focus-visible`, `prefers-reduced-motion`, tokens para error/éxito, easing `cubic-bezier(0.23, 1, 0.32, 1)` y duraciones < 250 ms.
- Copia mínima (frontend-clean-ui): se eliminan párrafos explicativos redundantes en paneles.

## 4. Manejo de errores

- Fallas de herramientas nunca tiran el request: se devuelven como resultado de herramienta y, si el modelo no se recupera, el mensaje final dice qué falló y cómo seguir.
- Errores upstream se mapean a `{title, hint, codes, retriable}` (voseo, como hoy) y se persisten.
- Streaming: errores a mitad de stream → evento `error`; el cliente conserva el texto recibido y muestra la píldora de error debajo.
- Desconexión del cliente → `AbortController` corta la llamada upstream; se persiste lo generado hasta ese punto marcado `stopped`.

## 5. Testing

- **Python** (`unittest`, `apps/api/docengine/tests`): normalización (alias, markdown, números), builders (abren con python-docx/openpyxl/python-pptx y verifican contenido), editores, resumen de errores.
- **Node** (`node:test`): `normalize` (think, tool-calls en texto), `protocol` (bloques, legacy), `retrieval`/`budget`, `project` (reglas activas, plantillas), `history`, `capabilities` (fixture de `/models`, aprendizaje en caliente), `client` (SSE, reintentos) y **E2E del chat** contra un servidor LLM simulado (texto en streaming, tool call → archivo real, autocorrección tras error de schema, modelo sin tools → protocolo de texto, tool-call en texto Hermes, 429 → reintento, regenerar).
- **Frontend:** `tsc --noEmit`, `eslint` sin errores, `next build`, y verificación visual en el navegador (escritorio y móvil).

## 6. Fuera de alcance

Autenticación multiusuario, base de datos, exportación a PDF, nuevos proveedores, embeddings/vector DB, colaboración en tiempo real.
