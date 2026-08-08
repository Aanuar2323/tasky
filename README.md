# Tasky — Plataforma Automatizada de Tareas con IA

**Tasky** es una aplicacion _Full-Stack_ (Node.js + Next.js) disenada para organizar, automatizar y resolver tareas mediante un asistente de IA integrado. Inspirada en workflows autonomos, soporta areas de trabajo con chats independientes, reglas por area, gestion de archivos y generacion de documentos con modelos de **OpenRouter** y **NVIDIA NIM** (ambos intercambiables en caliente desde la UI).

---

## Caracteristicas Principales

1. **Gestor de Tareas y Areas de Trabajo:** Organiza tus proyectos por areas funcionales. Cada area tiene sus propias reglas (`ai/layer2/areas/{areaId}/rules.md` con fallback a `rules.md` raiz), chats independientes con CRUD completo (crear, renombrar, eliminar), historial por area y un directorio de archivos dedicado.
2. **Selector de Chats por Area:** La barra superior (Topbar) contiene un dropdown centrado que muestra solo los chats del area activa. Al pasar el cursor sobre un chat aparece un menu de 3 puntos para renombrar o eliminar (no se puede eliminar el ultimo chat de un area).
3. **Proveedores de IA Intercambiables:** Tasky soporta **OpenRouter** y **NVIDIA NIM** de primera clase. Desde un unico modal flotante (`ModelSelectorModal`) el usuario configura API keys, carga modelos, cambia el proveedor activo y el modelo en uso sin reiniciar el servidor. La preferencia se persiste en `storage/user-config.json` (`provider`, `model` y keys independientes por proveedor).
4. **Generacion Automatica de Archivos:** A traves de instrucciones en el chat, la IA es capaz de crear de forma autonomamente documentos complejos como:
   - Hojas de calculo (`.xlsx`) con charts nativos editables
   - Documentos de Word (`.docx`) con TOC, tablas, footer numerado
   - Presentaciones PowerPoint (`.pptx`) 16:9 con themes y layouts profesionales
   Toda generacion corre en un microservicio Python (FastAPI + python-docx/openpyxl/python-pptx) que se ejecuta como co-proceso en el mismo container Docker.
5. **Explorador de Archivos Integrado:** Interfaz grafica (Finder-style) para subir, descargar y organizar los archivos generados o manuales de cada proyecto.
6. **Contexto IA Enriquecido:** El backend extrae texto plano de archivos de contexto (`.md`, `.txt`, `.json`, `.csv`, `.pdf`, `.docx`,codigo fuente en multiples lenguajes, etc.) mediante `readContextFile` (usando `pdfjs-dist` para PDF y `mammoth` para DOCX). El selector de archivos relevantes hace content-scoring sobre los primeros 500 caracteres de cada archivo, no solo match por nombre.
7. **Gestion de Reglas Avanzada:** El `SidePanel` incluye menu kebab por regla para editar/eliminar. El parser `rules-parser.ts` soporta tags `enabled` / `disabled` explicitos además del toggle por checkbox.
8. **Seguridad Robusta:** Incluye defensas contra ataques (DoS, Path Traversal, XSS) mediante _Rate Limiting_, CORS y _Helmet_.

---

## Arquitectura del Repositorio (Donde esta cada cosa)

El proyecto funciona como un **Monorepo** y esta dividido en dos partes principales: el backend (`api`) y el frontend (`web`).

```text
task/
|
+-- apps/
|   +-- api/                          # Backend en Node.js + Express
|   |   +-- src/
|   |   |   +-- index.js              # Punto de entrada, rutas REST, seguridad
|   |   |   +-- storage.js            # Logica del File System local (safeJoin, scaffold)
|   |   |   +-- llm-client.js         # Cliente unificado OpenRouter / NVIDIA
|   |   |   +-- config.js             # Gestion de configuracion del usuario (API key UI)
|   |   |   +-- tools.js              # Herramientas function-calling para el LLM
|   |   |   +-- generators/           # Fachada de generacion (delega al docengine Python)
|   |   |   |   +-- index.js          # Re-export de {generateFile, editFile, readFileStructure, detectFileType}
|   |   |   |   +-- docengine.js      # Cliente HTTP al microservicio Python (POST /api/v1/generate|edit/<fmt>)
|   |   |   +-- docengine/            # Microservicio Python (FastAPI + uvicorn)
|   |   |       +-- main.py           # Endpoints: POST /api/v1/{generate,edit}/{docx,xlsx,pptx}
|   |   |       +-- builders/         # Builders por formato (docx_builder, xlsx_builder, pptx_builder + editores)
|   |   |       +-- schemas/          # Pydantic v2: DocxPayload, XlsxPayload, PptxPayload
|   |   |       +-- utils/            # Helpers (styles, colores, etc.)
|   |   +-- tests/                    # Tests unitarios (node:test)
|   |   |   +-- storage.test.js       # Tests de storage.js
|   |   |   +-- tools.test.js         # Tests de tools.js
|   |   |   +-- api.test.js           # Tests de endpoints REST
|   |   +-- .env.example              # Template de variables de entorno
|   |   +-- package.json
|   +-- web/                          # Frontend Next.js 16 + React 19 + TypeScript
|       +-- app/
|       |   +-- layout.tsx            # Root layout con CSS globals
|       |   +-- page.tsx              # Pagina principal (setup + workspace)
|       |   +-- globals.css           # Tailwind base
|       |   +-- workspace.css         # Design system Tasky (CSS custom, design tokens en :root)
|       |   +-- lib/
|       |   |   +-- api.ts            # Cliente HTTP para backend Express (tipos Provider/ProviderInfo)
|       |   |   +-- rules-parser.ts   # Parseo/stringify de reglas Markdown (soporta tags enabled/disabled)
|       |   +-- components/
|       |       +-- Topbar.tsx        # Barra superior con selector de chats por area
|       |       +-- Sidebar.tsx       # Panel lateral con areas de trabajo
|       |       +-- ChatPanel.tsx     # Panel de chat con mensajes IA
|       |       +-- Composer.tsx      # Input de mensajes con attachments
|       |       +-- ModelBar.tsx      # Trigger pill unico (provider + modelo) que abre ModelSelectorModal
|       |       +-- ModelSelectorModal.tsx  # Modal flotante unificado: setup inicial + cambio provider/modelo
|       |       +-- SidePanel.tsx     # Panel Info/Historial/Reglas (por area) con kebab menu en reglas
|       |       +-- MarkdownRenderer.tsx  # Renderizado Markdown -> HTML
|       +-- .env.example              # Template de variables de entorno
|       +-- next.config.ts            # output: "standalone" para deploy Docker/self-contained
|       +-- tsconfig.json
|       +-- package.json
|
+-- storage/                          # Directorio (gitignored) — datos del usuario
+-- security.md                       # Documentacion oficial sobre ciberseguridad
+-- package.json                      # Gestor de dependencias global del monorepo
```

### Estructura de Almacenamiento Local (`storage/`)

A diferencia de aplicaciones tradicionales con SQL, _Tasky_ utiliza el sistema de archivos local para persistir el estado de forma limpia:

```text
storage/
+-- user-config.json                  # Config de providers (gitignored)
+-- users/default/projects/<projectId>/
    +-- info/
    |   +-- areas.json                # Define la jerarquia de Areas y Chats
    +-- rules.md                      # Reglas globales del proyecto (fallback del area)
    +-- ai/
    |   +-- layer1/
    |   |   +-- 00-role-and-flow.md  # Capa 1: Rol y orden de ejecucion
    |   +-- layer2/
    |   |   +-- summary.md            # Capa 2: Resumen global del proyecto
    |   |   +-- areas/
    |   |       +-- <areaId>/
    |   |           +-- summary.md    # Resumen del area
    |   |           +-- rules.md      # Reglas del area (independientes por area)
    |   +-- layer3/
    |       +-- qa.md                 # Capa 3: QA/Testing gate
    +-- chat/
    |   +-- areas/
    |       +-- <areaId>/
    |           +-- <chatId>.jsonl    # Historial de chat (una linea por mensaje)
    +-- history/
    |   +-- areas/
    |       +-- <areaId>/
    |           +-- files/            # Archivos completados del area
    +-- tasks/
    |   +-- inbox/                    # Tareas pendientes de completar
    |   +-- history/                  # Tareas completadas
    +-- files/                        # Todos los archivos generados y subidos por el usuario
        +-- generated/               # Archivos generados por la IA
```

### Schema de `user-config.json`

```jsonc
{
  "openrouterApiKey": "sk-or-v1-..." | null,
  "nvidiaApiKey":     "nvapi-..."     | null,
  "provider":          "openrouter"   | "nvidia" | null,
  "model":             "openai/gpt-oss-120b:free" | null   // modelo activo del provider seleccionado
}
```

`saveUserConfig(partial)` hace merge shallow: nunca pisa keys del otro provider al guardar solo uno. `updateApiConfig({ provider })` del backend actualiza `provider` y persiste.

---

## Modelo de Datos: Areas y Chats

Cada proyecto tiene **areas** y cada area tiene **chats** independientes:

```typescript
interface Area {
  id: string;
  name: string;
  pinned?: boolean;
  chats: { id: string; name: string; pinned?: boolean }[];
  activeChatId: string;
}
```

- **Reglas** son por area: `ai/layer2/areas/{areaId}/rules.md`
- **Info (archivos)** se lista desde `ai/layer2/areas/{areaId}/`
- **Historial** se almacena en `history/areas/{areaId}/files/`
- **Chat logs** se almacenan en `chat/areas/{areaId}/{chatId}.jsonl`
- El prompt del sistema inyecta las reglas del area activa, no las globales

---

## Generacion de Archivos (docengine)

Cuando la IA responde con un campo `fileGenerated` en el chat, el backend delega la construccion del archivo binario (`.docx`/`.xlsx`/`.pptx`) a un **microservicio Python** (FastAPI + uvicorn) que corre como co-proceso dentro del mismo container Docker. Toda la generacion 100% Python — los viejos generadores JS fueron eliminados.

### Pipeline de generacion

```
Chat (LLM)                       Backend (Node)                   Microservicio (Python)
┌──────────────┐                 ┌────────────────────┐           ┌──────────────────────┐
│ LLM responde │ ──────────────► │ parseStructured    │           │ POST /api/v1/         │
│ JSON con     │  POST /chat    │ Response extrae    │           │   generate/{fmt}      │
│ fileGenerated│                 │ fileGenerated      │ ────────► │ ─────────────────────►│
│ {type, data, │                 │ → generateFile()   │  body:    │ pydantic valida       │
│  filename}   │                 │   (docengine.js)   │  data JSON│ schemas/<Fmt>Payload │
└──────────────┘                 │   POST → Python    │           │ builder genera bytes  │
                                 │ fs.writeFile       │ ◄──────── │ → StreamingResponse   │
                                 │ a files/generated  │  binario  └──────────────────────┘
                                 └────────────────────┘
```

### Componentes

| Capa | Archivo | Rol |
|------|---------|-----|
| Node — fachada | `apps/api/src/generators/index.js` | Re-exporta `{generateFile, editFile, readFileStructure, detectFileType}` (mismo contrato publico que antes). |
| Node — cliente HTTP | `apps/api/src/generators/docengine.js` | POST a `DOC_ENGINE_URL` (default `http://127.0.0.1:8788`) con timeout 60s. Si `data` es undefined/null envia `{}` como fallback. |
| Node — auto-gen en chat | `apps/api/src/index.js` (~line 1517) | Despues de parsear la respuesta del LLM, si hay `fileGenerated` llama a `generateFile()` automaticamente y devuelve `{name, url, type}` al frontend. |
| Python — entrypoint | `apps/api/docengine/main.py` | FastAPI con endpoints `POST /api/v1/generate/{docx,xlsx,pptx}` y `POST /api/v1/edit/{...}`. Sirve `StreamingResponse` con el binario. |
| Python — schemas | `apps/api/docengine/schemas/*.py` | Pydantic v2 `BaseModel` con `ConfigDict(extra="allow")`. Discriminated unions para `Section` (docx) y `Slide` (pptx). |
| Python — builders | `apps/api/docengine/builders/{docx,xlsx,pptx}_builder.py` | Logica de construccion con `python-docx`/`openpyxl`/`python-pptx`. |
| Python — entrypoint container | `docker/entrypoint.mjs` | Levanta 3 procesos en el container: api (8787), web (3000), doc-engine (8788). Si uno muere, el container se reinicia. |

### Contrato `fileGenerated` (lo que el LLM debe devolver)

```json
{
  "content": "...",
  "meta": { "complete": true, "taskPath": null, "summary": "..." },
  "fileGenerated": {
    "type": "docx | xlsx | pptx",
    "filename": "informe.docx",
    "data": { /* payload completo del formato — ver schemas en storage/defaults/skills/generators/ */ }
  }
}
```

**El contenido del documento va SIEMPRE dentro del campo `data`**, nunca bajo `schema`, `content`, `document` u otra clave.

### Skills de generacion (referencia para el LLM)

`storage/defaults/skills/generators/*.md` contiene referencias detalladas (schemas completos, ejemplos, reglas) que la IA consulta indirectamente: el system prompt (en `index.js`) incluye un **Quick Reference** con los campos clave y apunta a las rutas completas. El backend actualmente **no inline** el contenido completo de los `.md` en el prompt — el LLM solo tiene el resumen inline.

| Archivo | Formato | Cubre |
|---------|---------|-------|
| `xlsx.md` | xlsx | sheets, headers, charts nativos, formulas, freeze, sumario, conditional formatting |
| `docx.md` | docx | sections (heading/paragraph/bullets/table/quote/code/image/hyperlink/toc), footer con nº de pagina |
| `pptx.md` | pptx | slides 16:9 con layouts (title/content/two_columns/image_left/image_right/table/chart/quote/closing/custom) |

`storage/users/{user}/skills/generators/` se copia desde `defaults` la primera vez que el usuario accede (funcion `getUserSkillsPath` en `storage.js`). Las copias solo se refrescan si el directorio del usuario no existe; cambios posteriores a `defaults/` requieren borrar `storage/users/{user}/skills/` manualmente.

### Nota de prompt engineering (bug historico)

En una version anterior del system prompt, la palabra "schema" se usaba repetidamente para describir la estructura del documento ("complete schemas", "full XLSX schema", etc.). Con `glm-5.2` (NVIDIA NIM), el modelo interpretaba esa terminologia como **nombre de clave** y devolvia el contenido del documento bajo `schema` en lugar de `data`. El backend esperaba `fileGenerated.data` → undefined → `{}` → archivos en blanco (byte-identicos a un payload vacio).

El prompt ahora usa terminologia neutra y declara explicitamente:

> The document content MUST go inside the `data` field of `fileGenerated`. Do NOT use any other field name.

Regla practica para futuros cambios al prompt: **nunca uses "schema"/"schemas" como sustantivo del documento** cuando hables del payload que el LLM debe generar. Usa "payload", "contenido", "estructura", "datos" o el nombre del campo (`data`).

### Edicion de archivos existentes

Adicional a `fileGenerated`, el LLM puede devolver `editPath` + `editChanges` para modificar un archivo ya generado:

```json
{
  "fileGenerated": {
    "type": "docx",
    "editPath": "files/generated/informe.docx",
    "editChanges": { "template": { "FECHA": "2026-08-08" } }
  }
}
```

Estrategias soportadas (ver detalle en los skills): `template` (reemplaza tokens `{{PLACEHOLDER}}`) o `replace` (lista `[{find, replace}]`).

---

## Seguridad (Cybersecurity)

La API cuenta con protecciones para mitigar ataques ciberneticos y posibles fraudes de saldo en servicios de terceros:

- **Helmet:** Oculta firmas y previene Cross-Site Scripting y ataques MIME.
- **Rate-Limiting (Escudo IA):** Previene ataques DoS y el agotamiento de saldo en OpenRouter API, limitando estrictamente cuantas peticiones puede hacer una IP por hora.
- **CORS Restringido:** Previene que otras paginas web roben informacion del usuario (en Produccion).
- **Defensa Path-Traversal:** Algoritmos como `safeJoin` que evitan la filtracion de rutas del sistema operativo.

> Para los detalles tecnicos profundos, lee el archivo oficial: [`security.md`](./security.md)

---

## Inicio rapido

Tasky se puede ejecutar de dos formas. **Docker** es lo mas simple (un comando, sin instalar Node). **npm** es para desarrollo local con hot reload.

### 1. Docker (recomendado)

Requisitos: Docker 24+ con Compose v2. No necesitas Node ni npm instalados.

```bash
git clone https://github.com/Aanuar2323/tasky.git
cd tasky
docker compose up -d --build
```

Eso construye una sola imagen `tasky` con API + Web y levanta un contenedor. Ambos procesos corren dentro via un entrypoint ligero (`docker/entrypoint.mjs`).

Verifica que este **healthy** y que responda:

```bash
docker compose ps                       # estado 'healthy' tras ~25-30s
curl http://localhost:8787/health        # debe responder {"ok":true}
```

Abrí http://localhost:3000 y configura la API key cuando aparezca el modal de setup (ver seccion **Configurar API key** mas abajo).

| Puerto | Servicio | URL |
|--------|----------|-----|
| 3000 | Frontend (Next.js) | http://localhost:3000 |
| 8787 | Backend (Express) | http://localhost:8787 |

Detener / resetear:

```bash
docker compose down                     # detiene, NO borra storage/
docker compose down -v                  # ⚠️ borra volumenes (storage se mantiene en bind mount ./storage)
```

Detalles completos (variables, persistencia, troubleshooting Docker) en la seccion **[Deploy con Docker](#deploy-con-docker-unico-contenedor)** mas abajo.

---

### 2. Desarrollo local (npm)

Requisitos:

| Requisito | Version | Verificar |
|-----------|---------|-----------|
| **Node.js** | 22+ | `node --version` |
| **npm** | 10+ | `npm --version` |

Tasky usa `??`/`||` (ES2021+) y npm workspaces. Node 22 garantiza compatibilidad.

```bash
git clone https://github.com/Aanuar2323/tasky.git
cd tasky
npm install
npm run dev:all
```

`npm install` instala todo el monorepo y ejecuta el `postinstall`, que copia los `.env` desde los templates:

- `apps/web/.env.example` -> `apps/web/.env.local`
- `apps/api/.env.example` -> `apps/api/.env`

No necesitas editar ningun `.env` para empezar. La API key se configura desde la UI.

`npm run dev:all` levanta ambos servicios en paralelo con `concurrently` y hot reload:

| Servicio | URL |
|----------|-----|
| Backend (Express) | http://localhost:8787 |
| Frontend (Next.js) | http://localhost:3000 |

Verifica que el backend responda:

```bash
curl http://localhost:8787/health
# Respuesta esperada: {"ok":true}
```

Si el puerto 3000 o 8787 ya estan en uso, cambialos editando `apps/api/.env` (variable `PORT`) o `apps/web/.env.local` (variable `NEXT_PUBLIC_API_BASE_URL`).

**Problema comun:** Si ves `sh: line 1: concurrently: command not found`, las dependencias no se instalaron. Vuelve a ejecutar `npm install`.

---

### Configurar API key (una sola vez, ambos metodos)

Aplica igual para Docker y npm. Abrí http://localhost:3000. Aparecera el **`ModelSelectorModal`** (modal flotante centrado con backdrop blur) en modo setup inicial:

1. Selecciona el tab del proveedor: **OpenRouter** o **NVIDIA NIM**.
2. Ingresa la API key correspondiente ([OpenRouter](https://openrouter.ai/keys) o NVIDIA NIM).
3. Haz clic en **Guardar**. El backend la persiste en `storage/user-config.json` sin cambiar el provider activo (`POST /api/provider/keys`).
4. Opcional: haz clic en **Cargar modelos** para traer el listado desde el provider (`GET /api/models?provider=...`).
5. Selecciona el modelo deseado.
6. Haz clic en **Comenzar**. La app recarga y entra en modo workspace.

La mismo modal sirve en modo in-app: el boton pill de la `ModelBar` (esquina inferior del composer) lo abre de nuevo para cambiar provider/modelo en caliente. Si el provider destino no esta configurado, el modal permite ingresar la API key sin salir del flow.

La key se guarda en `storage/user-config.json` (ignorado por git, nunca se sube). En Docker, este archivo vive en el bind mount `./storage` asi que sobrevive reinicios del contenedor.

> Las API keys tambien pueden configurarse via `apps/api/.env` (`OPENROUTER_API_KEY`, `NVIDIA_API_KEY`), pero no es necesario — la interfaz grafica es suficiente y tiene prioridad de lectura.

---

## Tests

```bash
npm test
```

Ejecuta los tests del backend (66 tests, 0 fallos esperados):

- `tests/storage.test.js` — CRUD del sistema de archivos, scaffolding, proteccion path traversal
- `tests/tools.test.js` — Herramientas function-calling del LLM
- `tests/api.test.js` — Endpoints REST (health, proyectos, areas, archivos, reglas, tareas, seguridad, providers, models, setup con provider)

---

### Donde se guardan mis datos

```
storage/
+-- user-config.json               # Config de providers (openrouterApiKey, nvidiaApiKey, provider, model)
+-- users/default/projects/default/
    +-- info/areas.json            # Tus areas y chats
    +-- chat/                      # Historial de conversaciones
    +-- files/generated/           # Archivos creados por la IA
```

Puedes borrar `storage/` para resetear la app a estado inicial.

---

## API Reference (Backend)

Endpoints clave para integracion/extension:

| Metodo | Ruta | Body / Query | Descripcion |
|--------|------|--------------|-------------|
| `GET` | `/health` | — | Liveness check. Responde `{ ok: true }` |
| `GET` | `/api/status` | — | Estado del backend + providers disponibles. Retorna `{ ok, configured, provider, model, providerId, availableProviders, openrouterConfigured, nvidiaConfigured }` |
| `GET` | `/api/provider` | — | Providers configurados y activo: `{ providers, activeProvider }` |
| `POST` | `/api/provider` | `{ provider: 'openrouter'\|'nvidia' }` | Cambia el provider activo (persiste). 400 si el provider no tiene key |
| `POST` | `/api/provider/keys` | `{ provider, apiKey }` | Guarda la API key de un provider sin cambiar el activo |
| `GET` | `/api/models` | `?provider=openrouter\|nvidia` | Lista modelos disponibles del provider (default: activo) |
| `POST` | `/api/setup` | `{ apiKey, model?, provider? }` | Setup inicial: guarda key + modelo + provider |
| `PATCH` | `/api/model` | `{ model, provider? }` | Actualiza solo el modelo activo (sin tocar key) |
| `POST` | `/api/projects/:id/chat` | `{ messages, areaId, chatId, activeTaskPath? }` | Endpoint principal de chat (rate-limited) |

Precedencia de lectura de API key:
1. Persistido en `storage/user-config.json` (`openrouterApiKey` / `nvidiaApiKey`).
2. Variable de entorno (`OPENROUTER_API_KEY` / `NVIDIA_API_KEY`) si no hay persistido.

Seleccion de provider activo por defecto: `user-config.provider` si esta seteado; si no, primer provider con key disponible (OpenRouter > NVIDIA); si ninguno tiene key, `none` y `isConfigured()` retorna `false`.

---

## Variables de entorno (referencia)

### Backend (`apps/api/.env`)

| Variable | Obligatoria | Default | Descripcion |
|----------|-------------|---------|-------------|
| `OPENROUTER_API_KEY` | Si (sin UI) | — | API key de OpenRouter (fallback si no hay persistido) |
| `MODEL` | No | `openai/gpt-oss-120b:free` | Modelo por defecto del proveedor activo |
| `PORT` | No | `8787` | Puerto del servidor Express |
| `APP_URL` | No | `http://localhost:5173` | URL para atribucion en OpenRouter |
| `CORS_ORIGIN` | No | `*` (dev) / `https://midominio.com` (prod) | Origen(es) permitido(s) por la API. Lista separada por comas para varios |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | URL base personalizada de OpenRouter |
| `NVIDIA_API_KEY` | No | — | API key de NVIDIA NIM (fallback si no hay persistido) |
| `NVIDIA_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | URL base de NVIDIA NIM |
| `STORAGE_ROOT` | No | `<project>/storage/` | Directorio de almacenamiento personalizado |
| `NODE_ENV` | No | — | `production` activa CORS estricto |

### Frontend (`apps/web/.env.local`)

| Variable | Obligatoria | Default | Descripcion |
|----------|-------------|---------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | No | `http://localhost:8787` | URL base del backend (fallback en `api.ts`) |

---

## Solucion de problemas

| Problema | Causa | Solucion |
|----------|-------|----------|
| `concurrently: command not found` | Faltan dependencias | Ejecuta `npm run install:all` |
| Modal de setup no desaparece | API key invalida o backend caido | Verifica `curl http://localhost:8787/health` y que la key sea correcta. Si fallas con NVIDIA, prueba con OpenRouter |
| El modal muestra "Provider X no configurado" al intentar usarlo | Falta la API key de ese provider | Haz clic en el tab del provider y guarda la API key desde el input |
| `exports is not defined` | Node < 22 | Actualiza a Node 22+ |
| Chat responde "Error 401" | API key sin saldo o invalida | Revisa en https://openrouter.ai/keys o en tu dashboard de NVIDIA |
| `npm run dev:all` falla | Puerto 3000 o 8787 ocupado | Libera los puertos o cambialos |
| Archivos generados no aparecen | `storage/` no existe | Se crea solo al primer uso, no deberia pasar |
| Docker: build falla con `EUSAGE npm ci` | Falta lockfile por app | npm workspaces usan el lockfile raiz; asegurate de que `package-lock.json` exista en la raiz del repo |
| Contenedor arranca y muere | API crashea al inicio | `docker compose logs -f` para ver el trace; suele ser API key invalida o puerto ocupado |

---

## Deploy con Docker (unico contenedor)

Toda la aplicacion (API + Web) corre en un solo contenedor `tasky`. La API expone `8787` y la Web `3000` desde la misma instancia, gestionados por un entrypoint ligero.

### Requisitos
- Docker 24+ con Compose v2
- API key (OpenRouter y/o NVIDIA NIM). La podes cargar desde la UI o via `apps/api/.env`

### Comandos

```bash
# desde la raiz del repo
docker compose up -d --build      # construye imagen y arranca contenedor
docker compose ps                  # verifica estado (estado 'healthy' tras ~25s)
docker compose logs -f tasky       # logs en vivo (API + Web juntos)
curl http://localhost:8787/health  # debe responder {"ok":true}
```

Abrí `http://localhost:3000` en el navegador y configura la API key cuando aparezca el modal de setup.

### Variables de entorno clave (precargadas en `docker-compose.yml`)

| Variable | Default contenedor | Descripcion |
|----------|--------------------|-------------|
| `PORT` | `8787` | Puerto interno del API |
| `WEB_PORT` | `3000` | Puerto interno de Next.js |
| `STORAGE_ROOT` | `/app/storage` | Persistencia montada desde `./storage` |
| `CORS_ORIGIN` | `http://localhost:3000` | Origen permitido por la API; cambialo si publicas bajo un dominio |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8787` | URL que el navegador usa para hablar con la API |

Las claves de IA se leen de `apps/api/.env` (inyectado por `env_file`). Tambien podes setearlas via UI y se persisten en `storage/user-config.json`.

### Persistencia y reset

```bash
ls storage/                         # archivos de usuario (proyectos, chats, config)
docker compose down                 # detiene el contenedor, NO borra storage/
docker compose down -v              # ⚠️ borra storage/ si estuviera como volumen
```

Reset suave: borra el contenido de `storage/` (la UI vuelve a estado inicial).

### Actualizar imagen

Tras cambios en el codigo fuente:

```bash
docker compose up -d --build
```

### Stop / remove

```bash
docker compose stop                 # detiene sin borrar
docker compose down --remove-orphans
```

---

## Lecturas complementarias

- [`security.md`](./security.md) — Documentacion detallada de seguridad y mitigacion de fraudes

---

_Desarrollado con altos estandares tecnicos, disenado para escalabilidad y maxima compatibilidad documental._
