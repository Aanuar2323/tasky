# AGENTS.md — Guia para agentes que editan Tasky

Lee esto **antes** de tocar cualquier archivo. Tasky tiene decisiones de diseno intencionales que parecen "raras" pero existen por razon. No las cambies sin consultar.

---

## Idea del proyecto (no cambiar)

**Tasky** = gestor de tareas con IA integrada. NO es chatbot generico, NO es asistente de programacion, NO es wrapper de OpenAI. Es un **agente de trabajo** atado a un proyecto y a sus areas funcionales.

Reglas fundacionales:

1. **Un solo usuario.** MVP. Sin auth, sin multi-tenant. `USER_ID = 'default'` en `apps/api/src/index.js:135`. No agregues tablas de usuarios, login, JWT o sesiones.
2. **Sin base de datos.** Toda la persistencia es el filesystem bajo `storage/`. No propone migrar a SQLite/Postgres/Mongo. Si lo haces, rompes el eschema, los tests y el scaffold automatico.
3. **Tiempo de vida del contexto = tiempo de vida del proyecto.** El storage **no** se limpia automaticamente. Borrar `storage/` es el reset manual del usuario.
4. **La IA es un medio, no el fin.** El valor esta en las areas, reglas, chats y archivos generados. No conviertas Tasky en "ChatGPT con carpetas".
5. **Provider-agnostic.** OpenRouter y NVIDIA NIM son intercambiables en caliente. Nunca hardcodees un provider. Toda nueva feature de IA debe funcionar con ambos (o degradar con `fetchWithFallbacks`).
6. **UI como unico punto de setup.** La API key se configura desde el `ModelSelectorModal`, no desde variables de entorno. Las env vars son **fallback**, no primarias.

Si una feature que piden rompe alguna de estas, parar y no implementar.

---

## Stack (no migrar)

| Capa | Tecnologia | Donde |
|------|------------|-------|
| Backend | Node.js 22+ ESM, Express 5 | `apps/api/src/` |
| Frontend | Next.js 16 (standalone), React 19, TypeScript | `apps/web/app/` |
| Styling | Tailwind 4 solo base (`globals.css`); componentes en CSS custom (`workspace.css`) | `apps/web/app/workspace.css` |
| Tests | `node:test` (built-in, sin jest) | `apps/api/tests/*.test.js` |
| Lint | ESLint 9 (solo web) | `apps/web/eslint.config.mjs` |
| Monorepo | npm workspaces | `package.json` raiz |
| Deploy | Docker, 1 contenedor, 2 procesos (API + Web) | `docker/Dockerfile`, `docker-compose.yml` |

No proponer migrar a: Bun, Deno, Hono, Fastify, Postgres, Prisma, Drizzle, Vite, Remix, Astro, Tailwind-3-class-formatter, jest, vitest. La decision esta tomada.

---

## Estructura (mapa rapido)

```
tasky/
+-- apps/
|   +-- api/                      Backend
|   |   +-- src/
|   |   |   +-- index.js          Express + rutas REST (29 endpoints) + seguridad
|   |   |   +-- storage.js        File system layer: safeJoin, scaffold, CRUD
|   |   |   +-- llm-client.js     Cliente unificado OpenRouter/NIM, response_format, retries
|   |   |   +-- config.js         user-config.json load/save (merge shallow)
|   |   |   +-- tools.js          Function-calling: read_file, list_directory, write_file
|   |   |   +-- generators/      Generadores de archivos binarios
|   |   |       +-- xlsx.js docx.js pptx.js png.js pdf.js index.js
|   |   +-- tests/                4 archivos .test.js, 66 tests
|   +-- web/                      Frontend Next.js 16
|       +-- app/
|       |   +-- layout.tsx        Root layout
|       |   +-- page.tsx          Pagina unica: setup <-> workspace
|       |   +-- globals.css       Tailwind base (sin componentes)
|       |   +-- workspace.css     Design system Tasky (CSS custom)
|       |   +-- lib/
|       |   |   +-- api.ts        Cliente HTTP tipado hacia apps/api
|       |   |   +-- rules-parser.ts  Parseo/stringify reglas Markdown
|       |   +-- components/       Topbar, Sidebar, ChatPanel, Composer,
|       |                        ModelBar, ModelSelectorModal, SidePanel,
|       |                        MarkdownRenderer, ErrorPill
+-- docker/
|   +-- Dockerfile                 Multi-stage (apt-get + canvas nativo)
|   +-- entrypoint.mjs             Launcher 2 procesos con graceful shutdown
+-- docker-compose.yml             1 servicio `tasky`, puertos 3000 y 8787
+-- storage/                       (gitignored) datos del usuario
+-- package.json                   Raiz monorepo (workspaces)
+-- package-lock.json              lockfileVersion 3 — versionar siempre
+-- .dockerignore                  Excluye node_modules, .next, storage, .env*
```

---

## Como se ejecuta

Dos modos. **Docker** es el primario y el que se documenta primero.

### Docker (1 contenedor, 2 procesos)

```bash
docker compose up -d --build    # build + run
```

- Imagen basada en `node:22-bookworm-slim` (NO alpine, por `canvas` nativo).
- Stage `native` instala toolchain + `libcairo2-dev` etc. para compilar `canvas@3.2.3`.
- Stage `api-deps` corre `npm ci --omit=dev --workspace=apps/api --include-workspace-root` (sin `--ignore-scripts` porque `canvas` y `sharp` necesitan install scripts nativos).
- Stage `web-deps` corre `npm ci --workspace=apps/web --include-workspace-root` (incluye devDeps para `next build`).
- Stage `web-builder` corre `npm run build -w apps/web` -> genera `apps/web/.next/standalone`.
- Stage `runtime` copia deps API, src API, standalone de web, public, static, y el entrypoint.
- Runtime instala solo runtime libs (sin toolchain): `libcairo2`, `libgif7`, `libjpeg62-turbo`, `libpango-1.0-0`, `librsvg2-2`, `tini`, `wget`.
- `docker/entrypoint.mjs` spawnea API (`node apps/api/src/index.js`) y Web (`node apps/web/standalone/apps/web/server.js`). Si uno muere, mata el otro para que Docker reinicie el contenedor (`restart: unless-stopped`).
- Healthcheck comprueba `/health` en 8787.
- Bind mount `./storage:/app/storage` -> persiste `user-config.json` y todo el arbol de proyectos.

**No cambiar esto sin razon fuerte.** Si queres 2 contenedores, sobrescribir/comentar el compose entero y no mezclar en el mismo commit.

### Desarrollo local

```bash
npm install       # instala monorepo + postinstall (copia .env.example -> .env)
npm run dev:all   # concurrently: API + Web con hot reload
```

API en `8787`, Web en `3000`.

### Tests

```bash
npm test
```

Corre `node --test apps/api/tests/*.test.js`. **66 tests, 0 fallos esperados.** Si tu cambio rompe tests, arreglalos o no subas.

---

## Reglas criticas para editar codigo

### 1. No romper el esquema de storage

El arbol de carpetas bajo `storage/users/default/projects/<projectId>/` esta esquemado en `apps/api/src/storage.js:114` (`ensureProjectScaffold`). Antes de agregar una carpeta o archivo por defecto, entendelo:

- `info/areas.json` -> estructura de areas y chats. Schema `Area` en `apps/web/app/lib/api.ts` y en `README.md:131`.
- `rules.md` raiz -> fallback global.
- `ai/layer1/00-role-and-flow.md` -> rol + orden de ejecucion.
- `ai/layer2/summary.md` -> resumen global del proyecto.
- `ai/layer2/areas/<areaId>/{summary,rules}.md` -> resumen y reglas por area. **Nombres ofuscados** (`rules(ajkwygebfickuvaulwakfjbscfa).md`) intencionales, no los renombres por estetica. El frontend los oculta del arbol visible.
- `ai/layer3/qa.md` -> gate QA.
- `chat/areas/<areaId>/<chatId>.jsonl` -> historial, una entrada por linea.
- `history/areas/<areaId>/files/` -> archivos completados.
- `tasks/{inbox,history}/` -> tareas.
- `files/generated/` -> outputs de la IA.

`safeJoin` impide path traversal (en `storage.js:87`). Toda manipulacion de rutas del usuario debe pasar por `safeJoin`. Nunca uses `path.join(root, userInput)` directo.

### 2. No romper el response_format del LLM

`apps/api/src/llm-client.js:265` define `RESPONSE_SCHEMA` (JSON schema estricto). Las respuestas del LLM SIEMPRE son:

```json
{
  "content": "string (markdown visible, nunca vacio)",
  "meta": { "complete": boolean, "taskPath": "string|null", "summary": "string" },
  "fileGenerated": { "type": "xlsx|docx|pptx|png|pdf", "data": {}, ... } | null
}
```

`fetchWithFallbacks` reintenta sin `tools` o sin `response_format` si el modelo no los soporta. No cambies el schema sin actualizar tambien `parseStructuredResponse` en `apps/api/src/index.js:199` y el frontend.

El formato legacy `TASK_APP_META: {...}` sigue parseado como fallback. **No agregues mas logica al legacy**, solo mantenelo para compat.

### 3. No romper el provider switching

`llm-client.js` mantiene estado en module scope: `PROVIDER`, `BASE_URL`, `API_KEY`, `MODEL`, `LABEL`. `setProvider()` y `updateApiConfig()` mutan + persisten en `storage/user-config.json` via `config.js`.

Reglas:
- `saveUserConfig(partial)` hace **merge shallow**. Nunca enviar un objeto completo que pise las keys del otro provider.
- Deteccion de key real: `isRealKey()` rechaza `your_..._key_here`. No cambiar el patron sin razon.
- Provider activo por defecto: `user-config.provider` si tiene key; si no, primer provider con key (OpenRouter > NVIDIA); si ninguno, `'none'` y `isConfigured()` retorna `false`.
- `nvidiaChat` es alias de `llmChat` (retrocompat). No los separas.

### 4. No agregar dependencias nativas nuevas sin pensar

`canvas` y `sharp` ya causan dolor en Docker (toolchain, libs del sistema). Antes de agregar `puppeteer`, `playwright`, `sqlite3`, `node-sass`, `better-sqlite3` o cualquier paquete con extension `.node` o `node-gyp`: parar, ver si hay alternativa JS pura, y si no hay, documentar en este archivo que runtime libs necesita.

### 5. No tocar el design system

`apps/web/app/workspace.css` tiene design tokens en `:root` y naming conventions:

- `mb-*` ModelBar
- `msm-*` ModelSelectorModal
- `rr-*` reglas en SidePanel
- `sp-*` SidePanel
- `tp-*` Topbar

**No Tailwind para componentes.** Tailwind solo en `globals.css` para resets y base. Si queres estilar algo, usas los tokens de `:root`, no hardcoded colors. No introducir Tailwind utilities tipo `bg-blue-500` en JSX.

### 6. No romper el auth mental del setup

El frontend arranca en modo setup (si `isConfigured()` es false) o workspace. `ModelSelectorModal` gestiona ambos modos. No agregues rutas nuevas estilo `/setup` y `/workspace`. Es **una sola pagina** (`page.tsx`) que conmuta.

### 7. CORS en produccion

En `apps/api/src/index.js:100`, `resolveCorsOrigin()`:
- Si `CORS_ORIGIN` definida -> la usa (string o lista separada por comas).
- Si `NODE_ENV=production` sin `CORS_ORIGIN` -> fallback `https://midominio.com`.
- Dev -> `*`.

No cambiar a `*` en produccion "para testing". Si rompes algo con CORS, el frontend en `http://localhost:3000` no podra hablar con la API en `http://localhost:8787` y el setup modal se queda colgado.

---

## Tests: que cubren y que no

| Archivo | Cubre | No cubre |
|---------|-------|----------|
| `storage.test.js` | safeJoin, scaffold, CRUD, path traversal | Generacion de archivos binarios |
| `tools.test.js` | executeTool para read_file/list_directory/write_file | LLM real |
| `api.test.js` | Endpoints REST (health, providers, projects, areas, files, rules, tasks, setup) | Chat completo con LLM |
| `context.test.js` | Extraccion de contexto de archivos, CONTEXT_EXTS | OCR de PDF/DOCX |

Antes de push: `npm test` pasa con 0 fallos. Tests no son opcionales.

---

## Commits y estilo

- Conventional Commits en español o ingles, lo que prefieras, pero consistente.
- Subjects <=50 chars.
- **Nunca** commitear `.env`, `.env.local`, `storage/`, `node_modules`, `.next/`. Estan en `.gitignore` — si git los trackea, algo rompiste.
- No commitear `tsconfig.tsbuildinfo`, `next-env.d.ts`, `eslint.config.mjs` cambios generados por tools automaticos.

---

## Cosas que parecen bugs pero no lo son

- **`"apps/mi-proyecto": { "extraneous": true }` en `package-lock.json`**: artefacto de un rename viejo de `apps/web` (que tenia `name: "mi-proyecto"` en su `package.json`). La entrada de lockfile `"apps/web": { "name": "mi-proyecto" }` refleja el nombre interno. No "limpiar" esto por estetica — se rompe `npm ci`.
- **Nombres de archivo `rules(ajkwygebfickuvaulwakfjbscfa).md`**: ofuscacion intencional para que el usuario no los vea directos en el arbol del SidePanel. El frontend los oculta. No los renombres a `rules.md` secos porque colisionan con `ai/layer2/areas/` global.
- **`postinstall` que copia `.env.example` a `.env`**: exactamente eso. Sin ese hook, el primer `npm install` no genera los `.env` y la app no arranca en dev. No quites el `postinstall`.
- **Docker en `node:22-bookworm-slim` y no alpine**: alpine no tiene toolchain nativo para `canvas`. Probar alpine = volver a empezar el calvario de `canvas.node not found`.
- **Healthcheck solo chequea 8787, no 3000**: Next.js standalone a veces tarda en hacer bind en `127.0.0.1` dentro del contenedor; el healthcheck del Dockerfile ya cubre ambos via shell:
  ```bash
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null && wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
  ```
  Pero si solo ves `8787` mencionado en docs viejas, es porque era el primario historico.

---

## Cuando una feature requiere romper algo de lo de arriba

1. **Parar.** No codees el cambio directamente.
2. **Preguntar** explicitamente al owner si esta OK romper la regla X.
3. **Documentar la decision** aca en `AGENTS.md` (nueva seccion "Excepciones").
4. **Updatear tests** que cubran el nuevo comportamiento.
5. **Updatear `README.md`** si la feature es user-facing.

Sin estos pasos, la feature no se mergea.

---

## Excepciones

### Tauri wrapper para distribucion desktop (`apps/desktop/`)

**Decisión**: envolver Tasky en app Tauri para producir `.exe` distribuible a usuarios no-técnicos en Windows.

**Qué no toca**:
- Código de `apps/api/src/*`, `apps/web/app/*`, `apps/api/tests/*` queda intacto.
- `docker/Dockerfile` y `docker-compose.yml` siguen siendo el deploy primario documentado.
- Schema de `storage/` y `STORAGE_ROOT` se respetan; en desktop, `STORAGE_ROOT` apunta a `%APPDATA%/storage` (equivalente Windows del bind mount `./storage:/app/storage`).
- `RESPONSE_SCHEMA` del LLM y provider switching siguen funcionando igual.

**Arquitectura**:
- `apps/desktop/` = nuevo workspace Tauri. Sidecar = `node.exe` (Node.js portable descargado en build time).
- `apps/desktop/entrypoint.mjs` = clon de `docker/entrypoint.mjs` adaptado a paths Windows (`apps/api/src`, `apps/web/standalone/apps/web`).
- `scripts/prebuild-desktop.mjs` copia `apps/api/src`, `node_modules` (hoisted) y `apps/web/.next/standalone` a `apps/desktop/dist/`.
- Installer NSIS vía Tauri produce `Tasky_Setup_x64.exe`.

**Build**:
- Desarrollo local (Linux): `npx tauri dev -w apps/desktop` valida config y UI.
- Build `.exe`: GitHub Actions workflow `.github/workflows/build-release.yml` en `windows-latest` runner. Sube artifact `.exe` + crea Release en tag `v*`.
- Cross-compile desde Linux no soportado (Rust vía pacman, no `rustup`; docs Tauri lo marcan "last resort").

**Riesgos aceptados**:
- Native modules `canvas.node` y `sharp.node` se compilan/descargan prebuilt Windows en el runner Windows de GH Actions.
- WebView2 bootstrapper embebido (Win10 1809+ requerido).
- Sin code-signing EV → SmartScreen advierte "Editor desconocido". Usuario debe clickear "More info → Run anyway".

**No remover** la carpeta `apps/desktop/` ni el workflow sin discusión previa.
