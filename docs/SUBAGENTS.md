# Subagents Shared Instructions (Task App)

## Goal
Build a Node.js + React (Vite) app inspired by the OpenClaw cron workflow (Tareas/Rules.md): file-based organization, chat-driven task automation, and a clear completion flow.

## Non-negotiables
- Storage is file/folder based (project workspace on disk). No DB for MVP.
- A task only moves to **Historial** when the user clicks **"Completado"** on an AI message.
- UI must follow the provided sketches (tabs/areas + left mini-menu: Info / Historial / Rules).
- Microsoft Office compatibility is a priority for produced docs: prefer .docx / .xlsx.
- NVIDIA API integration using model **GLM 5.1**; API key must be via env var (never hardcode or commit).

## Repo layout (current)
- apps/web  -> React + TS (Vite)
- apps/api  -> Node (Express)
- docs/     -> documentation, decisions, context

## Canonical storage layout (proposed)
Within a root like `storage/`:
- storage/users/<userId>/projects/<projectId>/
  - info/                (metadata, attachments)
  - rules.md             (generated from Rules form)
  - chat/
    - active.jsonl       (chat log)
  - tasks/
    - inbox/             (pending tasks)
    - history/           (completed)
  - files/               (uploaded/outputs)

## API conventions
- All filesystem paths must be sandboxed to `storage/` and path-traversal safe.
- Prefer JSON schemas via zod.

## What to put in your deliverable
- Concrete file paths and code suggestions (not just prose)
- Decisions + rationale + alternatives if relevant
- Keep it MVP-first; note follow-ups in docs/CONTEXT.md
