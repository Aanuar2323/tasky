# Tasky — Plataforma Automatizada de Tareas con IA

**Tasky** es una aplicacion _Full-Stack_ (Node.js + Next.js) disenada para organizar, automatizar y resolver tareas mediante un asistente de IA integrado. Inspirada en workflows autonomos, soporta areas de trabajo con chats independientes, reglas por area, gestion de archivos y generacion de documentos con modelos **OpenRouter** (recomendado).

---

## Caracteristicas Principales

1. **Gestor de Tareas y Areas de Trabajo:** Organiza tus proyectos por areas funcionales. Cada area tiene sus propias reglas (`ai/layer2/areas/{areaId}/rules.md`), chats independientes con CRUD completo (crear, renombrar, eliminar), historial por area y un directorio de archivos dedicado.
2. **Selector de Chats por Area:** La barra superior (Topbar) contiene un dropdown centrado que muestra solo los chats del area activa. Al pasar el cursor sobre un chat aparece un menu de 3 puntos para renombrar o eliminar (no se puede eliminar el ultimo chat de un area).
3. **Generacion Automatica de Archivos:** A traves de instrucciones en el chat, la IA es capaz de crear de forma autonomamente documentos complejos como:
   - Hojas de calculo (`.xlsx`)
   - Documentos de Word (`.docx`)
   - Presentaciones PowerPoint (`.pptx`)
   - Graficos, diagramas y tablas en imagen (`.png`)
4. **Explorador de Archivos Integrado:** Interfaz grafica (Finder-style) para subir, descargar y organizar los archivos generados o manuales de cada proyecto.
5. **Seguridad Robusta:** Incluye defensas contra ataques (DoS, Path Traversal, XSS) mediante _Rate Limiting_, CORS y _Helmet_.

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
|   |   |   +-- generators/           # Scripts generadores de archivos binarios
|   |   +-- tests/                    # Tests unitarios (node:test)
|   |   |   +-- storage.test.js       # Tests de storage.js
|   |   |   +-- tools.test.js         # Tests de tools.js
|   |   |   +-- api.test.js           # Tests de endpoints REST
|   |   +-- .env.example              # Template de variables de entorno
|   |   +-- package.json
|   +-- web/                          # Frontend Next.js 16 + React 19 + TypeScript
|       +-- app/
|       |   +-- layout.tsx            # Root layout con CSS globals
|       |   +-- page.tsx              # Pagina principal + setup screen
|       |   +-- globals.css           # Tailwind base
|       |   +-- workspace.css         # Design system Tasky (CSS custom)
|       |   +-- lib/
|       |   |   +-- api.ts            # Cliente HTTP para backend Express
|       |   |   +-- rules-parser.ts   # Parseo/stringify de reglas Markdown
|       |   +-- components/
|       |       +-- Topbar.tsx        # Barra superior con selector de chats por area
|       |       +-- Sidebar.tsx       # Panel lateral con areas de trabajo
|       |       +-- ChatPanel.tsx     # Panel de chat con mensajes IA
|       |       +-- Composer.tsx      # Input de mensajes con attachments
|       |       +-- ModelBar.tsx      # Selector de modelo
|       |       +-- SidePanel.tsx     # Panel Info/Historial/Reglas (por area)
|       |       +-- MarkdownRenderer.tsx  # Renderizado Markdown -> HTML
|       +-- .env.example              # Template de variables de entorno
|       +-- next.config.ts
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
+-- user-config.json                  # API key guardada desde la UI (gitignored)
+-- users/default/projects/<projectId>/
    +-- info/
    |   +-- areas.json                # Define la jerarquia de Areas y Chats
    +-- rules.md                      # Reglas globales del proyecto (fallback)
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

## Seguridad (Cybersecurity)

La API cuenta con protecciones para mitigar ataques ciberneticos y posibles fraudes de saldo en servicios de terceros:

- **Helmet:** Oculta firmas y previene Cross-Site Scripting y ataques MIME.
- **Rate-Limiting (Escudo IA):** Previene ataques DoS y el agotamiento de saldo en OpenRouter API, limitando estrictamente cuantas peticiones puede hacer una IP por hora.
- **CORS Restringido:** Previene que otras paginas web roben informacion del usuario (en Produccion).
- **Defensa Path-Traversal:** Algoritmos como `safeJoin` que evitan la filtracion de rutas del sistema operativo.

> Para los detalles tecnicos profundos, lee el archivo oficial: [`security.md`](./security.md)

---

## Instalacion (paso a paso)

### Requisitos previos

| Requisito | Version | Verificar |
|-----------|---------|-----------|
| **Node.js** | 22+ | `node --version` |
| **npm** | 10+ | `npm --version` |

Tasky usa `??`/`||` (ES2021+) y npm workspaces. Node 22 garantiza compatibilidad.

---

### 1. Clonar e instalar

```bash
git clone https://github.com/Aanuar2323/tasky.git
cd tasky
npm run install:all
```

El comando `install:all` instala todas las dependencias (monorepo, backend y frontend) y ademas ejecuta el `postinstall`, que copia automaticamente los archivos `.env` desde los templates:

- `apps/web/.env.example` -> `apps/web/.env.local`
- `apps/api/.env.example` -> `apps/api/.env`

No necesitas editar ningun `.env` para empezar. La API key se configura desde la interfaz grafica en el siguiente paso.

**Problema comun:** Si ves `sh: line 1: concurrently: command not found`, las dependencias no se instalaron. Vuelve a ejecutar `npm run install:all`.

---

### 2. Iniciar el proyecto

```bash
npm run dev:all
```

Esto levanta ambos servicios en paralelo usando `concurrently`:

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

---

### 3. Configurar API key (una sola vez)

Abre http://localhost:3000. Veras la **pantalla de configuracion**:

1. Ingresa tu API key de [OpenRouter](https://openrouter.ai/keys)
2. Opcional: elige otro modelo
3. Haz clic en **"Comenzar"**

La app recarga y ya esta lista. La key se guarda en `storage/user-config.json` (ignorado por git, nunca se sube).

> La API key tambien puede configurarse via `apps/api/.env` (variable `OPENROUTER_API_KEY`), pero no es necesario — la interfaz grafica es suficiente.

---

### 4. Ejecutar tests (opcional)

```bash
npm test
```

Ejecuta los tests del backend (58 tests, 0 fallos esperados):

- `tests/storage.test.js` — CRUD del sistema de archivos, scaffolding, proteccion path traversal
- `tests/tools.test.js` — Herramientas function-calling del LLM
- `tests/api.test.js` — Endpoints REST (health, proyectos, areas, archivos, reglas, tareas, seguridad)

---

### Donde se guardan mis datos

```
storage/
+-- user-config.json               # API key (solo si usaste la UI)
+-- users/default/projects/default/
    +-- info/areas.json            # Tus areas y chats
    +-- chat/                      # Historial de conversaciones
    +-- files/generated/           # Archivos creados por la IA
```

Puedes borrar `storage/` para resetear la app a estado inicial.

---

## Variables de entorno (referencia)

### Backend (`apps/api/.env`)

| Variable | Obligatoria | Default | Descripcion |
|----------|-------------|---------|-------------|
| `OPENROUTER_API_KEY` | Si (sin UI) | — | API key de OpenRouter |
| `MODEL` | No | `nvidia/nemotron-3-ultra-550b-a55b:free` | Modelo por defecto |
| `PORT` | No | `8787` | Puerto del servidor Express |
| `APP_URL` | No | `http://localhost:5173` | URL para atribucion en OpenRouter |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | URL base personalizada |
| `NVIDIA_API_KEY` | No | — | API key de NVIDIA NIM (fallback) |
| `NVIDIA_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | URL base de NVIDIA |
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
| Pantalla de setup no desaparece | API key invalida o backend caido | Verifica `curl http://localhost:8787/health` y que la key sea correcta |
| `exports is not defined` | Node < 22 | Actualiza a Node 22+ |
| Chat responde "Error 401" | API key sin saldo o invalida | Revisa en https://openrouter.ai/keys |
| `npm run dev:all` falla | Puerto 3000 o 8787 ocupado | Libera los puertos o cambialos |
| Archivos generados no aparecen | `storage/` no existe | Se crea solo al primer uso, no deberia pasar |

---

## Lecturas complementarias

- [`security.md`](./security.md) — Documentacion detallada de seguridad y mitigacion de fraudes

---

_Desarrollado con altos estandares tecnicos, disenado para escalabilidad y maxima compatibilidad documental._
