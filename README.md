# Task (file-based task automation app)

Node.js + React (Vite) app inspired by the OpenClaw cron workflow.

## What it does (MVP)
- Projects are folders on disk under `storage/`
- Basic file explorer (tree)
- Chat (NVIDIA Integrate API + GLM 5.1)
- When the assistant says it's complete, it includes metadata so the UI shows a green translucent **Completado** button
- Clicking **Completado** moves the task from `tasks/inbox/` → `tasks/history/`
- Rules editor is a custom form that saves internal `rules.md` (markdown)

## Setup

### 1) Install deps
```bash
cd /home/anuar/Documentos/proyects/task
npm run install:all
```

### 2) Configure API key
```bash
cp apps/api/.env.example apps/api/.env
# then edit apps/api/.env and set NVIDIA_API_KEY
```

### 3) Run
```bash
npm run dev:all
```

- Web: http://localhost:5173
- API: http://localhost:8787/health

## Storage layout
Created automatically per project:
```
storage/users/default/projects/<projectId>/
  info/
  rules.md
  chat/
    active.jsonl
    history.jsonl
  tasks/
    inbox/
    history/
  files/
```

## Notes
- `.env` and `storage/` are gitignored.
- Microsoft Office compatibility: outputs should prefer `.docx` / `.xlsx`.
