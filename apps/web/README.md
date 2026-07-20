# Tasky Web — Frontend

interfaz de usuario de Tasky, construida con **Next.js 16 + React 19 + TypeScript**.

## Estructura

```
app/
+-- layout.tsx                # Root layout (carga globals.css + workspace.css)
+-- page.tsx                  # Pagina principal: detecta setup vs workspace y monta el modal o el shell
+-- globals.css               # Tailwind base (sin componentes)
+-- workspace.css             # Design system Tasky. Design tokens en :root, todo CSS custom (sin Tailwind)
+-- lib/
|   +-- api.ts                # Cliente HTTP tipado hacia apps/api (Express). Tipos: Provider, ProviderInfo, ApiStatus, etc.
|   +-- rules-parser.ts       # Parseo/stringify de reglas Markdown (soporta tags enabled/disabled explicitos)
+-- types/
|   +-- chat.ts               # Tipos de mensajes del chat
+-- components/
    +-- Topbar.tsx            # Barra superior con selector de chats por area
    +-- Sidebar.tsx           # Panel lateral con areas de trabajo
    +-- ChatPanel.tsx         # Panel de chat con mensajes IA
    +-- Composer.tsx          # Input de mensajes con attachments
    +-- ModelBar.tsx          # Pill trigger unico: provider + modelo, click abre ModelSelectorModal
    +-- ModelSelectorModal.tsx # Modal flotante unificado: setup inicial + cambio provider/modelo en caliente
    +-- SidePanel.tsx         # Panel Info / Historial / Reglas por area (kebab menu en reglas)
    +-- MarkdownRenderer.tsx  # Renderizado Markdown -> HTML
```

## Setup

Este sub-app se ejecuta dentro del monorepo. Ver la guia completa en el [`README.md`](../../README.md) raiz.

```bash
# desde la raiz del repo
npm install
npm run dev         # alias de `next dev` (puerto 3000)
# o directo:
npx next dev -w apps/web
```

`apps/web/.env.local` se crea automaticamente desde `.env.example` en `postinstall`.

## Design system

Todo el styling vive en `app/workspace.css` como CSS plano. Los design tokens (colores, fuentes, radios, sombras) estan en el selector `:root`. Convenciones de naming:

- `mb-*` — clases del `ModelBar` (trigger del modal)
- `msm-*` — clases del `ModelSelectorModal` (overlay, modal, tabs, fields, buttons)
- `rr-*` — reglas en `SidePanel`
- `sp-*` — `SidePanel`
- `tp-*` — `Topbar`

No se usa Tailwind para componentes. `globals.css` solo trae la base y resets.

## Build de produccion

```bash
npm run build -w apps/web
```

Configurado con `output: "standalone"` en `next.config.ts` para empaquetado minimo self-contained, util para deploy en Docker o servidores sin Node toolchain.
