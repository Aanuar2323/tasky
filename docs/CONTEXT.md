# Project Context / Documentation Log

This file is the single source of truth for: documentation links, key decisions, known issues, corrections needed, and upcoming integrations.

## Product summary
A file-based task automation app (Node.js + React Vite) inspired by the OpenClaw cron workflow. Users manage projects stored as folders; AI chat helps solve tasks; when a solution is truly done, the UI shows a green translucent **"Completado"** button and clicking it moves the related task/message into **Historial**.

## UI sketches (source)
See the provided images in the chat.
- The **Info/Historial/Rules** selector is a single rounded container with stacked segments (sketch style).
- Many **areas** are supported (horiz scroll). There is a **+** to add.
- Center canvas supports **Chat** and **Preview** modes.
- Secondary features (Rules / Archivos / Historial) are accessed via **floating windows (modals)** to keep the main UI clean.

## Key decisions
- Monorepo with npm workspaces:
  - `apps/web` React + TS (Vite)
  - `apps/api` Express (Node)
- File-based storage under `storage/` (no DB for MVP).
- **Completion semantics (confirmed):** Option 1 — completing moves a **task file** only:
  - `tasks/inbox/<task>.md` → `tasks/history/<task>.md`
  - This move only happens on user click of **Completado**.
- NVIDIA Integrate API (OpenAI-compatible) for chat completions.
  - API key via env: `NVIDIA_API_KEY`
  - Model: `z-ai/glm-5.1` (confirm exact id if needed)
- **AI layered instructions:** `storage/.../ai/` with 3 layers
  - Layer 1: role + execution order
  - Layer 2: global summary + per-area summaries + area files
  - Layer 3: QA/testing gate before responses

## Environment
- Create `apps/api/.env` (gitignored):
  - `NVIDIA_API_KEY=...`
  - `MODEL=z-ai/glm-5.1`
  - `PORT=8787`

## Known issues / corrections needed
- Tailwind CLI: use Tailwind v3 for now (v4 cli detection issue).
- Decide how to map an AI message to a task (messageId -> task file). MVP: allow the AI to propose `taskId` and store it in message metadata.

## Upcoming integrations / phase 2
- Auth (multi-user) + per-user storage roots.
- Cron-like scheduling inside the app (daily run) mirroring Tareas/Rules.md.
- File preview: PDF viewer, images, markdown rendering.
- Export Word/Excel outputs with consistent styling.
