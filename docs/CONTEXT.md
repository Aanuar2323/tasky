# Project Context / Documentation Log

This file is the single source of truth for: documentation links, key decisions, known issues, corrections needed, and upcoming integrations.

## Product summary
A file-based task automation app (Node.js + Next.js) branded **Tasky**. Users manage projects stored as folders; AI chat helps solve tasks; when a solution is truly done, the UI shows a green translucent **"Completado"** button and clicking it moves the related task/message into **Historial**. Each area has its own rules, files, history, and multiple independent chats.

## UI Layout
- **Topbar:** Centered chat selector dropdown (scoped to active area). Hovering a chat row shows 3-dot menu for rename/delete. Side buttons for Historial, Reglas, Info. No project tabs, no model info, no "Open Design" branding.
- **Sidebar:** Area navigation with collapse/expand toggle. Each area has Info/Historial/Reglas buttons that open the SidePanel for that area.
- **Chat Panel:** Shows messages for the active chat in the active area. Avatar shows "T" (Tasky).
- **Composer:** Input area with attachment support. No model/context info displayed.
- **SidePanel:** Right panel with tabs Info/Historial/Reglas, all scoped to the active area.

## Key decisions
- Monorepo with npm workspaces:
  - `apps/web` Next.js 16 + React 19 + TypeScript
  - `apps/api` Express (Node)
- File-based storage under `storage/` (no DB for MVP).
- **Branding:** All "Claude" references replaced with "Tasky". Avatar "C" → "T". "Open Design" → "Tasky".
- **No model/context info** displayed anywhere in the UI.
- **No project tabs** in topbar — single project model, no project switching UI.
- **Chat CRUD:** Chats are scoped to areas. Each area can have multiple chats. Add/rename/delete supported. Delete blocked if it's the last chat in an area.
- **Area-scoped data:** Rules, Info (tree), and Historial are independent per area:
  - Rules: `ai/layer2/areas/{areaId}/rules.md` (not global `rules.md`)
  - Info/Tree: lists files under `ai/layer2/areas/{areaId}/`
  - Historial: `history/areas/{areaId}/files/`
- **AI layered instructions:** `storage/.../ai/` with 3 layers
  - Layer 1: role + execution order
  - Layer 2: global summary + per-area summaries + per-area rules + area files
  - Layer 3: QA/testing gate before responses
- The system prompt injects area-specific rules (not global rules).
- **Completion semantics:** completing moves a **task file** only:
  - `tasks/inbox/<task>.md` → `tasks/history/<task>.md`
  - This move only happens on user click of **Completado**.
- OpenRouter API (OpenAI-compatible) for chat completions.
- Primary provider model: configurable via `MODEL` env var.
- `response_format: json_schema` strict con `fileGenerated` opcional (top-level)
- `reasoning: { effort: 'low' }` + `max_tokens: 4096` para evitar thinking loops
- Environment variables:
  - `OPENROUTER_API_KEY` (obligatorio para OpenRouter)
  - `MODEL` (opcional)
- **Rate limit**: OpenRouter `:free` = 50 req/día. Reset diario UTC.

## API Endpoints (current)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id/areas` | Get areas config |
| PUT | `/api/projects/:id/areas` | Update areas config |
| DELETE | `/api/projects/:id/chat` | Delete a chat (body: areaId, chatId) |
| DELETE | `/api/projects/:id/area` | Delete an area (body: areaId) |
| GET | `/api/projects/:id/tree?areaId=&path=` | List directory (area-scoped if areaId) |
| GET | `/api/projects/:id/file?path=` | Read file content |
| POST | `/api/projects/:id/file` | Write file content |
| DELETE | `/api/projects/:id/file` | Delete file/directory |
| POST | `/api/projects/:id/upload` | Upload file (multipart) |
| GET | `/api/projects/:id/download?path=` | Download file (binary) |
| GET | `/api/projects/:id/rules?areaId=` | Get rules (area-scoped if areaId) |
| PUT | `/api/projects/:id/rules` | Update rules (body: markdown, areaId?) |
| GET | `/api/projects/:id/chatlog?areaId=&chatId=` | Get chat log |
| POST | `/api/projects/:id/chat` | Send message to AI |
| POST | `/api/projects/:id/generate` | Generate file (xlsx/docx/pptx/png) |
| POST | `/api/projects/:id/add-to-history` | Move file to area history |
| GET | `/api/projects/:id/generated-history?areaId=` | List area history files |
| POST | `/api/projects/:id/tasks` | Create task |
| POST | `/api/projects/:id/complete` | Complete task (move to history) |
| GET | `/api/provider` | Get available AI providers |
| POST | `/api/provider` | Switch AI provider |

## Frontend Components

| Component | File | Description |
|-----------|------|-------------|
| Topbar | `apps/web/app/components/Topbar.tsx` | Chat selector dropdown (area-scoped), side buttons for Info/Historial/Reglas |
| Sidebar | `apps/web/app/components/Sidebar.tsx` | Area navigation, collapse toggle, per-area panel buttons |
| ChatPanel | `apps/web/app/components/ChatPanel.tsx` | Chat messages display (Tasky branding, "T" avatar) |
| Composer | `apps/web/app/components/Composer.tsx` | Message input with attachments (Tasky branding, no model info) |
| SidePanel | `apps/web/app/components/SidePanel.tsx` | Info/Historial/Reglas tabs (area-scoped data) |
| page.tsx | `apps/web/app/page.tsx` | Main state management, all handlers, area-scoped data loading |

## Environment
- Create `apps/api/.env` (gitignored):
  - `OPENROUTER_API_KEY=sk-or-v1-...`
  - `MODEL=deepseek/deepseek-v4-flash:free`
  - `PORT=8787`

## Known issues / corrections needed
- Decide how to map an AI message to a task (messageId -> task file). MVP: allow the AI to propose `taskId` and store it in message metadata.

## Upcoming integrations / phase 2
- Auth (multi-user) + per-user storage roots.
- Cron-like scheduling inside the app (daily run) mirroring Tareas/Rules.md.
- File preview: PDF viewer, images, markdown rendering.
- Export Word/Excel outputs with consistent styling.
