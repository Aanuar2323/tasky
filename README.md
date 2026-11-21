# Tasky — Espacio de trabajo con IA

**Tasky** es una aplicación full-stack (Node.js + Next.js + motor de documentos en Python) para organizar el trabajo por **áreas**, conversar con una IA que conoce los archivos y reglas de cada área, y generar **Word, Excel y PowerPoint** listos para descargar. Funciona con modelos de **OpenRouter**, **NVIDIA NIM** y tu plan de **ChatGPT** (inicio de sesión local), intercambiables en caliente desde la interfaz.

---

## Qué hace

- **Chat en streaming**: las respuestas aparecen a medida que se escriben, con estado visible ("Leyendo contrato.pdf", "Generando informe.docx…"), razonamiento colapsable en modelos que lo exponen, botón para detener y opción de regenerar.
- **Archivos de verdad**: la IA crea `.docx`, `.xlsx` y `.pptx` con contenido completo mediante herramientas (function calling). Si el motor rechaza el contenido, la IA recibe el error y se corrige sola.
- **Edición y versiones**: los archivos generados se pueden leer, editar (reemplazos, plantillas `{{clave}}`, celdas, filas, hojas, anexos) o regenerar; nunca se pisa un archivo: se crea `informe-v2.docx`.
- **Contexto con memoria**: reglas activas del área, archivos del área recuperados por relevancia (BM25 a nivel de fragmento), adjuntos del chat (PDF, Word, Excel, PowerPoint, texto e imágenes para modelos con visión), archivos generados y un resumen automático cuando la conversación ya no entra en la ventana del modelo.
- **Compatible con muchos modelos**: detecta capacidades (contexto, salida máxima, herramientas, visión, razonamiento) y se adapta en caliente a lo que cada modelo acepta.
- **Vista previa** de documentos, planillas y presentaciones sin salir de la app.

---

## Arquitectura

```text
apps/
  api/                         Backend Express 5 (Node 22+)
    src/
      index.js                 Rutas REST + SSE
      storage.js               Persistencia en disco, ids y nombres seguros
      config.js                user-config.json (keys y modelo por proveedor)
      preview.js               Vista previa de docx/xlsx/pptx/pdf/texto
      llm/
        providers.js           OpenRouter / NVIDIA NIM / ChatGPT, proveedor activo, modelo por proveedor
        chatgpt-auth.js        Sign in with ChatGPT: OAuth + PKCE, ID token, credenciales, refresh, logout
        responses.js           Responses API de ChatGPT: conversión, streaming SSE, tools con namespace, modelos
        capabilities.js        Perfil de cada modelo (catálogo + heurísticas + aprendizaje)
        client.js              Chat completions con streaming y reintentos adaptativos
        normalize.js           <think>, razonamiento y tool calls escritas como texto
        errors.js              Clasificación de errores y mensajes para la UI
      context/
        extract.js             Texto de PDF/DOCX/PPTX/XLSX/texto con caché
        xlsx-reader.js         Lector XLSX tolerante (Excel, LibreOffice, openpyxl…)
        retrieval.js           Fragmentos + BM25
        budget.js              Presupuesto de tokens por sección
        project.js             Reglas activas, resúmenes, archivos del área y generados
        history.js             Historial desde .jsonl, recorte y compactación
      chat/
        service.js             Turno de chat: contexto → loop agente → persistencia
        prompt.js              System prompt (parte estable primero)
        tools.js               generate_file, edit_file, read_file
        protocol.js            Protocolo de texto (```tasky-file```) y parser legacy
        sse.js                 Server-Sent Events
      generators/docengine.js  Cliente del CLI Python (nombres seguros, versiones, fuente)
    docengine/                 CLI Python: normalización + pydantic + builders
      cli.py                   generate|edit <docx|xlsx|pptx> (stdin JSON → stdout binario)
      normalize.py             Alias, markdown, números/fechas en texto, temas
      schemas/                 Pydantic v2 con uniones discriminadas
      builders/                docx/xlsx/pptx + editores
      utils/                   markdown, reemplazo entre runs, estilos
      tests/                   unittest
    tests/                     node:test (unitarios + e2e contra un LLM simulado)
  web/                         Next.js 16 + React 19 + TypeScript
    app/
      page.tsx                 Shell de la app (setup y workspace)
      hooks/useChat.ts         Estado del chat, streaming, detener, regenerar
      lib/api.ts, lib/sse.ts   Cliente HTTP y lector SSE
      components/              Chat, mensajes, tarjetas de archivo, vista previa,
                               composer con adjuntos, selector de modelos, paneles
      workspace.css            Sistema visual (tokens, responsive, movimiento)
docker/                        Imagen única (API + Web + Python)
```

### Flujo de un mensaje

```text
UI (useChat) ──POST /chat (SSE)──► service.runChat
                                     ├─ guarda mensaje y adjuntos (files/uploads/<área>/<chat>/)
                                     ├─ perfil del modelo (capabilities)
                                     ├─ contexto dentro del presupuesto (budget):
                                     │    reglas activas · índice de archivos · fragmentos BM25
                                     │    archivos generados · adjuntos · historial (+ resumen)
                                     ├─ loop agente (≤ 5 pasos, streaming)
                                     │    tools nativas ─► generate_file / edit_file / read_file
                                     │    sin tools    ─► bloques ```tasky-file``` en el texto
                                     └─ persiste respuesta (texto, archivos, uso) y compacta si hace falta
Eventos SSE: start · status · reasoning · delta · file · done · error
```

### Compatibilidad de modelos

| Situación | Qué hace Tasky |
|---|---|
| Modelo con function calling | Herramientas nativas (`generate_file`, `edit_file`, `read_file`) |
| Modelo sin tools (o 404 "No endpoints found that support tool use") | Cambia al protocolo de texto y recuerda la capacidad para ese modelo |
| Tool calls escritas como texto (Hermes/Qwen `<tool_call>`, Mistral `[TOOL_CALLS]`, DeepSeek, Llama `<\|python_tag\|>`, JSON suelto) | Las detecta, las ejecuta y las oculta del texto visible |
| Razonamiento (`reasoning`, `reasoning_content`, `<think>`) | Lo separa del contenido y la UI lo muestra colapsado |
| `temperature` no soportada | La omite y lo aprende |
| `max_tokens` o contexto excedido | Reduce la salida según el mensaje del proveedor |
| 402 "can only afford N" | Reintenta con menos tokens |
| 429 / 5xx / red | Hasta 2 reintentos con `retry-after` o backoff |
| Modelo con visión | Las imágenes adjuntas viajan como `image_url` |

Lo aprendido se guarda en `storage/model-capabilities.json`. Cada proveedor recuerda su propio modelo (`user-config.json → models`).

### Generación de archivos (docengine)

Node lanza `python3 apps/api/docengine/cli.py generate <fmt>` por proceso: stdin = JSON, stdout = binario. Antes de validar, `normalize.py` corrige lo habitual en modelos: alias de secciones y layouts, `markdown` en lugar de secciones, filas como objetos, números/porcentajes/monedas/fechas escritos como texto, temas con nombres cortos o predefinidos (`corporate`, `modern`, `minimal`, `dark`, `nature`, `warm`). Los errores de validación vuelven al modelo resumidos (`slides.0.chart.type: …`).

- **DOCX**: portada opcional, encabezado/pie con "Página X de Y", markdown inline (negrita, cursiva, código, links), listas anidadas y numeradas que reinician, tablas con encabezado repetido y números alineados, callouts (info/advertencia/éxito/peligro), citas, código, índice.
- **XLSX**: tablas de Excel reales, números con tipo correcto y formato por columna, anchos por contenido, fila de totales solo en columnas numéricas, encabezado congelado, formato condicional, validaciones y gráficos nativos (barras, líneas, torta, dona, área, dispersión) que referencian el rango real y funcionan en cualquier visor.
- **PPTX**: 16:9 con banda de acento, tipografía que se ajusta al volumen de texto, sub-viñetas, número de diapositiva y pie, layouts `title`, `agenda`, `content`, `two_columns`, `stats`, `chart`, `table` (se parte en varias diapositivas), `quote`, `section_header`, `closing`, imágenes y `custom`.

Contrato de la herramienta (el contenido va siempre en `data`):

```json
{ "type": "docx", "filename": "informe_ventas.docx", "summary": "Informe de ventas Q3",
  "data": { "title": "Informe de ventas", "markdown": "# Resumen\n\nLas ventas crecieron **18 %**…" } }
```

---

## Inicio rápido

### Docker (recomendado)

Requisitos: Docker 24+ con Compose v2.

```bash
git clone https://github.com/Aanuar2323/tasky.git
cd tasky
docker compose up -d --build
docker compose ps                 # 'healthy' tras ~25-30 s
curl http://localhost:8787/health # {"ok":true}
```

Abrí http://localhost:3000 y configurá la API key en el diálogo inicial.

| Puerto | Servicio |
|---|---|
| 3000 | Frontend (Next.js) |
| 8787 | Backend (Express) |

`docker compose down` detiene sin borrar `storage/` (bind mount).

### Desarrollo local

Requisitos: Node.js 22+, npm 10+, Python 3.11+ con las dependencias del motor:

```bash
git clone https://github.com/Aanuar2323/tasky.git
cd tasky
npm install
python3 -m pip install -r apps/api/docengine/requirements.txt
npm run dev:all
```

`npm install` copia los `.env` de ejemplo. La API key se configura desde la interfaz: elegí proveedor (OpenRouter o NVIDIA NIM), pegá la clave (o usá [ChatGPT](#chatgpt-plan-de-suscripción)), buscá el modelo (la lista muestra si es gratis, su contexto y si admite herramientas o visión) y empezá.

---

## ChatGPT (plan de suscripción)

Tasky puede usar tu plan de ChatGPT con [Sign in with ChatGPT](https://developers.openai.com/siwc) (modo token-sharing para clientes open source, **preview**). Elegí **ChatGPT** en el selector de modelos y pulsá **Continue with ChatGPT**.

**Cómo funciona**

1. La API registra a Tasky con `client_id=dynamic_agent_client` (`agent_name_hint=Tasky` + un `ext_agent_host_id` propio y persistente). ChatGPT devuelve el `client_id` emitido, que se guarda y se reutiliza en los inicios de sesión siguientes de esa cuenta.
2. Se abre el navegador del sistema en `auth.openai.com` con PKCE (S256), `state` y `nonce` frescos. El callback escucha **solo** en `http://127.0.0.1:<puerto>/auth/callback` (puerto preferido `1455`; si está ocupado se usa otro, la ruta no cambia), valida el `Host` y el `state`, y es de un solo uso. Ninguna ruta acepta URLs de redirección enviadas por el cliente.
3. Tras canjear el código se valida el ID token (firma contra el JWKS de OpenAI, `iss`, `aud` = client_id emitido, `exp`, `nonce`) y que el token conceda `chatgpt.tokens.use.direct`. Sin ese scope la sesión queda guardada pero el plan figura como no habilitado (**Habilitar plan** repite OAuth con `prompt=consent`).
4. Las credenciales se guardan en `storage/credentials/chatgpt/` (carpeta `0700`, archivos `0600`, escritura atómica, un archivo por `client_id`). El navegador y los logs nunca ven tokens; el único estado que expone la API es `GET /api/chatgpt/status`.
5. El access token se renueva cerca de su vencimiento (refresh serializado entre procesos; el refresh token rotado se guarda junto con scopes y expiración). **Cerrar sesión** revoca el refresh token en el `revocation_endpoint` oficial (con reintentos) y borra los tokens locales; conserva el `client_id` y el host id. Si no se confirma la revocación, la UI lo indica.

**Inferencia.** `POST https://api.openai.com/v1/responses` con `store: false` y `stream: true`. El prompt del sistema va en `instructions`; el historial y los resultados de herramientas, en `input` (`function_call` / `function_call_output`). Las herramientas locales (`generate_file`, `edit_file`, `read_file`) se agrupan en un namespace `tasky`. Se omiten los campos no admitidos (`temperature`, `max_output_tokens`, `previous_response_id`, `metadata`, `user`, …). El éxito se confirma solo con `response.completed`; `response.failed`, `response.incomplete` y los cortes se tratan por separado, con el código de error y el request ID tal cual.

**Limitaciones**

- Solo funciona con Tasky ejecutándose **en tu equipo** y el navegador en ese mismo equipo: el callback es `127.0.0.1`. **Dentro de Docker el login está deshabilitado** (el loopback del contenedor no es alcanzable desde tu navegador). Con `network_mode: host` en Linux podés habilitarlo con `TASKY_CHATGPT_ALLOW_CONTAINER=1`. Alternativa (no probada con Docker real): iniciar sesión con la API corriendo en el host sobre el mismo `./storage` que monta el contenedor; el contenedor lee `credentials/chatgpt/` y renueva la sesión sin necesitar el callback.
- Es una preview: el uso cuenta contra tu plan (revisalo en [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage)) y puede cambiar o dejar de estar disponible. No se admiten generación de imágenes, búsqueda de archivos, Code Interpreter ni MCP alojado.
- La ventana de contexto y las capacidades (visión, razonamiento) salen del catálogo de la cuenta cuando lo declara; si no, se usan valores conservadores (128K, sin visión).
- Si desconectás Tasky en la configuración de ChatGPT, la API lo detecta en el siguiente refresh y pide iniciar sesión de nuevo.

---

## Tests

```bash
cd apps/api && npm test                                                     # Node: unitarios + e2e con LLM simulado
python3 -m unittest discover -s apps/api/docengine/tests -t apps/api/docengine  # Python: normalización, builders, editores
cd apps/web && npx tsc --noEmit && npx eslint app && npm run build          # Frontend
```

Los e2e levantan un servidor OpenAI-compatible falso (`tests/helpers/mock-llm.js`) y cubren streaming, generación de archivos, autocorrección, modelos sin tools, tool calls en texto, lectura de archivos, regeneración, contexto chico, compactación, detener, adjuntos, visión, reglas y vista previa.

---

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| GET | `/api/status` | Estado, proveedor/modelo activos y `capabilities` del modelo |
| GET/POST | `/api/provider` | Proveedores configurados / cambiar el activo |
| POST | `/api/provider/keys` | Guardar key de OpenRouter o NVIDIA (ChatGPT no usa key) |
| GET | `/api/chatgpt/status` | Estado de la sesión de ChatGPT (sin tokens) |
| POST | `/api/chatgpt/login` | Inicia el login (`{ newAccount?, reconsent? }`); solo desde la UI local |
| POST | `/api/chatgpt/login/cancel` · `/logout` · `/account` | Cancelar, cerrar sesión (revoca el refresh token), elegir cuenta |
| GET | `/api/models?provider=` | Modelos con `isFree`, `contextLength`, `tools`, `vision`, `reasoning` |
| POST | `/api/setup` | Setup inicial (key, modelo, proveedor) |
| PATCH | `/api/model` | Cambiar el modelo de un proveedor |
| POST | `/api/projects/:id/chat` | Chat. JSON o multipart (`attachments`). Con `Accept: text/event-stream` responde por SSE. Body: `{ areaId, chatId, message, regenerate? }` |
| GET | `/api/projects/:id/chatlog?areaId&chatId` | Historial persistido |
| GET | `/api/projects/:id/preview?path=` | Vista previa (`markdown`, `sheets`, `slides`, `text`, `image`) |
| GET | `/api/projects/:id/generated?areaId=` | Archivos generados del área |
| GET | `/api/projects/:id/download?path=` | Descarga |
| POST | `/api/projects/:id/upload` | Subir archivo (`ai/layer2/areas/<área>` o `files/…`) |
| POST | `/api/projects/:id/add-to-history` | Guardar un archivo en el historial del área |
| GET/PUT | `/api/projects/:id/rules` | Reglas globales o del área |
| GET/PUT | `/api/projects/:id/areas` | Áreas y chats |

---

## Almacenamiento

```text
storage/
  user-config.json                      keys, proveedor activo y modelo por proveedor
  model-capabilities.json               capacidades aprendidas por modelo
  users/default/projects/<proyecto>/
    info/areas.json                     áreas y chats
    rules.md                            reglas globales (fallback)
    ai/layer1/00-role-and-flow.md       instrucciones del proyecto (opcional)
    ai/layer2/summary.md                resumen del proyecto (opcional)
    ai/layer2/areas/<área>/             archivos de contexto + reglas y resumen del área
    ai/layer3/qa.md                     criterios de calidad (opcional)
    chat/areas/<área>/<chat>.jsonl      historial (+ <chat>.summary.json al compactar)
    files/generated/                    archivos generados (+ .tasky/<archivo>.json con la fuente)
    files/uploads/<área>/<chat>/        adjuntos del chat
    history/areas/<área>/files/         archivos guardados en el historial
```

Las plantillas por defecto (reglas, resúmenes, capas) no se envían a la IA mientras no se editen.

---

## Variables de entorno (backend)

| Variable | Default | Descripción |
|---|---|---|
| `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` | — | Keys (la interfaz tiene prioridad) |
| `OPENROUTER_MODEL` / `NVIDIA_MODEL` | — | Modelo inicial por proveedor |
| `MODEL` | — | Modelo inicial del proveedor activo (compatibilidad) |
| `OPENROUTER_BASE_URL` / `NVIDIA_BASE_URL` | URLs oficiales | Endpoints OpenAI-compatibles |
| `TASKY_CHATGPT_CALLBACK_PORT` | `1455` | Puerto preferido del callback de ChatGPT (si está ocupado se usa otro) |
| `TASKY_CHATGPT_CREDENTIALS_DIR` | `<storage>/credentials/chatgpt` | Carpeta de credenciales de ChatGPT (0700/0600) |
| `TASKY_CHATGPT_ALLOW_CONTAINER` | — | `1` permite el login dentro de un contenedor con `network_mode: host` |
| `PORT` | `8787` | Puerto de la API |
| `CORS_ORIGIN` | `*` (dev) | Orígenes permitidos (coma separada) |
| `STORAGE_ROOT` | `<repo>/storage` | Carpeta de datos |
| `APP_URL` | `http://localhost:3000` | Atribución en OpenRouter |
| `TASKY_MAX_INPUT_TOKENS` | `100000` | Tope de contexto enviado por mensaje |
| `TASKY_TIMEZONE` | TZ del sistema | Zona horaria para la fecha en el prompt |
| `TASKY_LLM_IDLE_MS` | `120000` | Corte si el modelo deja de transmitir |
| `AI_RATE_LIMIT_MAX` / `RATE_LIMIT_MAX` | `120` / `600` | Límites por IP (IA por hora / general cada 15 min) |
| `DOCENGINE_TIMEOUT_MS` | `90000` | Tiempo máximo del motor de documentos |
| `PYTHON_BIN` | `python3` | Intérprete para el docengine |

Frontend: `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8787`).

---

## Solución de problemas

| Problema | Solución |
|---|---|
| "Modelo bloqueado por privacidad" (OpenRouter) | Habilitá los modelos gratuitos en openrouter.ai/settings/privacy o elegí otro modelo |
| "Límite de peticiones" | Los modelos gratuitos tienen límites por minuto y por día: esperá o cambiá de modelo |
| "Modelo no disponible" | El ID no existe en ese proveedor: elegilo desde el selector |
| El modelo no genera archivos | Si no admite herramientas, Tasky usa el modo compatible automáticamente; con modelos muy chicos conviene uno más capaz |
| "Iniciar sesión con ChatGPT requiere ejecutar Tasky en tu equipo" | Ver [ChatGPT](#chatgpt-plan-de-suscripción): el callback solo existe en `127.0.0.1` |
| `python_missing` al generar | Instalá Python 3.11+ y `pip install -r apps/api/docengine/requirements.txt` (o definí `PYTHON_BIN`) |
| `concurrently: command not found` | `npm install` en la raíz |

Seguridad: ver [`security.md`](./security.md).
