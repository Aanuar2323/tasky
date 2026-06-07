# Subagents Shared Instructions (Tasky App)

## Goal
Build a Node.js + Next.js app branded **Tasky**: file-based organization, chat-driven task automation, area-scoped rules/info/history, and a clear completion flow.

## Non-negotiables
- Storage is file/folder based (project workspace on disk). No DB for MVP.
- A task only moves to **Historial** when the user clicks **"Completado"** on an AI message.
- UI layout: Topbar (centered chat selector by area) + Sidebar (areas) + Chat + SidePanel (Info/Historial/Reglas per area).
- Microsoft Office compatibility is a priority for produced docs: prefer .docx / .xlsx.
- OpenRouter API integration; API key must be via env var (never hardcode or commit).
- Rules, Info, and Historial are **independent per area** — not global.
- Branding is **Tasky** (not Claude). Avatar shows "T". No model/context info in UI.

## Repo layout (current)
- apps/web -> Next.js 16 + React 19 + TypeScript
- apps/api -> Node (Express)
- docs/ -> documentation, decisions, context

## Canonical storage layout
Within a root like `storage/`:
- storage/users/<userId>/projects/<projectId>/
  - info/ (metadata, areas.json)
  - rules.md (global fallback)
  - ai/layer1/ (role + execution order)
  - ai/layer2/ (global summary + per-area summaries + per-area rules)
    - areas/<areaId>/summary.md
    - areas/<areaId>/rules.md  ← area-scoped rules
  - ai/layer3/ (QA/testing gate)
  - chat/areas/<areaId>/<chatId>.jsonl  ← chat logs per area/chat
  - history/areas/<areaId>/files/  ← area-scoped history
  - tasks/inbox/ (pending tasks)
  - tasks/history/ (completed tasks)
  - files/ (uploaded/outputs)

## Area data model
```typescript
interface Area {
  id: string;
  name: string;
  pinned?: boolean;
  chats: { id: string; name: string; pinned?: boolean }[];
  activeChatId: string;
}
```

## API conventions
- All filesystem paths must be sandboxed to `storage/` and path-traversal safe (safeJoin).
- Prefer JSON schemas via zod.
- Rules endpoint accepts optional `areaId` query param to scope to area.
- Tree endpoint accepts optional `areaId` query param to list area files.
- Generated history endpoint requires `areaId` query param.

## What to put in your deliverable
- Concrete file paths and code suggestions (not just prose)
- Decisions + rationale + alternatives if relevant
- Keep it MVP-first; note follow-ups in docs/CONTEXT.md
