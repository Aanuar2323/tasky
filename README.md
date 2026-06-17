# 🚀 Tasky — Plataforma Automatizada de Tareas con IA

**Tasky** es una aplicación _Full-Stack_ (Node.js + Next.js) diseñada para organizar, automatizar y resolver tareas mediante un asistente de IA integrado. Inspirada en workflows autónomos, soporta áreas de trabajo con chats independientes, reglas por área, gestión de archivos y generación de documentos con modelos **OpenRouter** (recomendado).

---

## ✨ Características Principales

1. **Gestor de Tareas y Áreas de Trabajo:** Organiza tus proyectos por áreas funcionales. Cada área tiene sus propias reglas (`ai/layer2/areas/{areaId}/rules.md`), chats independientes con CRUD completo (crear, renombrar, eliminar), historial por área y un directorio de archivos dedicado.
2. **Selector de Chats por Área:** La barra superior (Topbar) contiene un dropdown centrado que muestra solo los chats del área activa. Al pasar el cursor sobre un chat aparece un menú de 3 puntos para renombrar o eliminar (no se puede eliminar el último chat de un área).
3. **Generación Automática de Archivos:** A través de instrucciones en el chat, la IA es capaz de crear de forma autónoma documentos complejos como:
   - 📊 Hojas de cálculo (`.xlsx`)
   - 📄 Documentos de Word (`.docx`)
   - 📽️ Presentaciones PowerPoint (`.pptx`)
   - 🖼️ Gráficos, diagramas y tablas en imagen (`.png`)
4. **Explorador de Archivos Integrado:** Interfaz gráfica (Finder-style) para subir, descargar y organizar los archivos generados o manuales de cada proyecto.
5. **Seguridad Robusta:** Incluye defensas contra ataques (DoS, Path Traversal, XSS) mediante _Rate Limiting_, CORS y _Helmet_.

---

## 📂 Arquitectura del Repositorio (Dónde está cada cosa)

El proyecto funciona como un **Monorepo** y está dividido en dos partes principales: el backend (`api`) y el frontend (`web`).

```text
task/
│
├── apps/
│   ├── api/                          # Backend en Node.js + Express
│   │   ├── src/
│   │   │   ├── index.js              # Punto de entrada, rutas REST, seguridad
│   │   │   ├── storage.js            # Lógica del File System local (safeJoin, scaffold)
│   │   │   ├── llm-client.js         # Cliente unificado OpenRouter / NVIDIA
│   │   │   ├── config.js             # Gestión de configuración del usuario (API key UI)
│   │   │   └── generators/           # Scripts generadores de archivos binarios
│   │   ├── .env.example              # Template de variables de entorno
│   │   └── package.json
│   └── web/                          # Frontend Next.js 16 + React 19 + TypeScript
│       ├── app/
│       │   ├── layout.tsx            # Root layout con CSS globals
│       │   ├── page.tsx              # Página principal + setup screen
│       │   ├── globals.css           # Tailwind base
│       │   ├── workspace.css         # Design system Tasky (CSS custom)
│       │   ├── lib/
│       │   │   └── api.ts            # Cliente HTTP para backend Express
│       │   └── components/
│       │     ├── Topbar.tsx          # Barra superior con selector de chats por área
│       │     ├── Sidebar.tsx         # Panel lateral con áreas de trabajo
│       │     ├── ChatPanel.tsx       # Panel de chat con mensajes IA (Tasky)
│       │     ├── Composer.tsx        # Input de mensajes con attachments (Tasky)
│       │     └── SidePanel.tsx       # Panel Info/Historial/Reglas (por área)
│       ├── .env.example              # Template de variables de entorno
│       ├── next.config.ts
│       ├── tsconfig.json
│       └── package.json
│
├── storage/                          # Directorio (gitignored) — datos del usuario
├── docs/                             # Notas internas de desarrollo (gitignored)
├── security.md                       # Documentación oficial sobre ciberseguridad
└── package.json                      # Gestor de dependencias global del monorepo
```

### 🗄️ Estructura de Almacenamiento Local (`storage/`)

A diferencia de aplicaciones tradicionales con SQL, _Tasky_ utiliza el sistema de archivos local para persistir el estado de forma limpia:

```text
storage/
├── user-config.json                  # API key guardada desde la UI (gitignored)
└── users/default/projects/<projectId>/
    ├── info/
    │   └── areas.json                # Define la jerarquía de Áreas y Chats
    ├── rules.md                      # Reglas globales del proyecto (fallback)
    ├── ai/
    │   ├── layer1/
    │   │   └── 00-role-and-flow.md  # Capa 1: Rol y orden de ejecución
    │   ├── layer2/
    │   │   ├── summary.md            # Capa 2: Resumen global del proyecto
    │   │   └── areas/
    │   │       └── <areaId>/
    │   │           ├── summary.md    # Resumen del área
    │   │           └── rules.md      # Reglas del área (independientes por área)
    │   └── layer3/
    │       └── qa.md                 # Capa 3: QA/Testing gate
    ├── chat/
    │   └── areas/
    │       └── <areaId>/
    │           └── <chatId>.jsonl    # Historial de chat (una línea por mensaje)
    ├── history/
    │   └── areas/
    │       └── <areaId>/
    │           └── files/            # Archivos completados del área
    ├── tasks/
    │   ├── inbox/                    # Tareas pendientes de completar
    │   └── history/                  # Tareas completadas
    └── files/                        # Todos los archivos generados y subidos por el usuario
        └── generated/               # Archivos generados por la IA
```

---

## 🧩 Modelo de Datos: Áreas y Chats

Cada proyecto tiene **áreas** y cada área tiene **chats** independientes:

```typescript
interface Area {
  id: string;
  name: string;
  pinned?: boolean;
  chats: { id: string; name: string; pinned?: boolean }[];
  activeChatId: string;
}
```

- **Reglas** son por área: `ai/layer2/areas/{areaId}/rules.md`
- **Info (archivos)** se lista desde `ai/layer2/areas/{areaId}/`
- **Historial** se almacena en `history/areas/{areaId}/files/`
- **Chat logs** se almacenan en `chat/areas/{areaId}/{chatId}.jsonl`
- El prompt del sistema inyecta las reglas del área activa, no las globales

---

## 🛡️ Seguridad (Cybersecurity)

La API cuenta con protecciones para mitigar ataques cibernéticos y posibles fraudes de saldo en servicios de terceros:

- **Helmet:** Oculta firmas y previene Cross-Site Scripting y ataques MIME.
- **Rate-Limiting (Escudo IA):** Previene ataques DoS y el agotamiento de saldo en OpenRouter API, limitando estrictamente cuántas peticiones puede hacer una IP por hora.
- **CORS Restringido:** Previene que otras páginas web roben información del usuario (en Producción).
- **Defensa Path-Traversal:** Algoritmos como `safeJoin` que evitan la filtración de rutas del sistema operativo.

> 📚 **Para los detalles técnicos profundos, lee el archivo oficial: [`security.md`](./security.md)**

---

## ⚙️ Instalación (3 pasos)

### Requisitos previos

| Requisito | Versión | Verificar |
|-----------|---------|-----------|
| **Node.js** | 22+ | `node --version` |
| **npm** | 10+ | `npm --version` |

Tasky usa `??`/`||` (ES2021+) y npm workspaces — Node 22 garantiza compatibilidad.

---

### 1. Clonar e instalar

```bash
git clone https://github.com/Aanuar2323/tasky.git
cd tasky
npm run install:all
```

Esto instala dependencias del backend, frontend y `concurrently`. Además, crea automáticamente `apps/web/.env.local` con `NEXT_PUBLIC_API_BASE_URL=http://localhost:8787`.

---

### 2. Iniciar

```bash
npm run dev:all
```

Levanta ambos servicios:

| Servicio | URL |
|----------|-----|
| Backend (Express) | http://localhost:8787 |
| Frontend (Next.js) | http://localhost:3000 |

Verificá que el backend responda:

```bash
curl http://localhost:8787/health
# → {"ok":true}
```

---

### 3. Configurar API key (una sola vez)

Abrí http://localhost:3000. Vas a ver la **pantalla de configuración**:

1. Ingresá tu API key de [OpenRouter](https://openrouter.ai/keys)
2. Opcional: elegí otro modelo
3. Clic en **"Comenzar"**

La app recarga y ya está lista. La key se guarda en `storage/user-config.json` (ignorado por git, nunca se sube).

> **Alternativa con variables de entorno:** editá `apps/api/.env` (ya existe en el repo, contiene un placeholder) y reemplazá la API key. El placeholder se ignora automáticamente — si preferís no usar la UI, este método funciona igual.

---

### 📁 ¿Dónde se guardan mis datos?

```
storage/
├── user-config.json               # API key (solo si usaste la UI)
└── users/default/projects/default/
    ├── info/areas.json            # Tus áreas y chats
    ├── chat/                      # Historial de conversaciones
    └── files/generated/           # Archivos creados por la IA
```

Podés borrar `storage/` para resetear la app a estado inicial.

---

## 🐳 Variables de entorno (referencia)

### Backend (`apps/api/.env`)

| Variable | Obligatoria | Default | Descripción |
|----------|-------------|---------|-------------|
| `OPENROUTER_API_KEY` | Sí (sin UI) | — | API key de OpenRouter |
| `MODEL` | No | `nvidia/nemotron-3-ultra-550b-a55b:free` | Modelo por defecto |
| `PORT` | No | `8787` | Puerto del servidor Express |
| `APP_URL` | No | `http://localhost:5173` | URL para atribución en OpenRouter |

### Frontend (`apps/web/.env.local`)

| Variable | Obligatoria | Default | Descripción |
|----------|-------------|---------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | No | `http://localhost:8787` | URL base del backend (fallback en `api.ts`) |

---

## 🗺️ Solución de problemas

| Problema | Causa | Solución |
|----------|-------|----------|
| Pantalla de setup no desaparece | API key inválida o backend caído | Verificá `curl http://localhost:8787/health` y que la key sea correcta |
| `exports is not defined` | Node < 22 | Actualizá a Node 22+ |
| Chat responde "Error 401" | API key sin saldo o inválida | Revisá en https://openrouter.ai/keys |
| `npm run dev:all` falla | Puerto 3000 o 8787 ocupado | Liberá los puertos o cambialos |
| Archivos generados no aparecen | `storage/` no existe | Se crea solo al primer uso, no debería pasar |

---

## 📚 Lecturas complementarias

- [`security.md`](./security.md) — Documentación detallada de seguridad y mitigación de fraudes

---

_Desarrollado con altos estándares técnicos, diseñado para escalabilidad y máxima compatibilidad documental._
