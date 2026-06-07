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
/home/anuar/Documentos/proyects/task/
│
├── apps/
│   ├── api/                          # Backend en Node.js + Express
│   │   ├── src/
│   │   │   ├── index.js              # Punto de entrada, rutas REST, seguridad
│   │   │   ├── storage.js            # Lógica del File System local (safeJoin, scaffold)
│   │   ├── llm-client.js             # Cliente unificado OpenRouter / NVIDIA
│   │   └── generators/               # Scripts generadores de archivos binarios
│   └── web/                          # Frontend Next.js 16 + React 19 + TypeScript
│       ├── app/
│       │   ├── layout.tsx            # Root layout con CSS globals
│       │   ├── page.tsx              # Página principal (estado global, handlers)
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
│       ├── public/                   # Assets estáticos
│       ├── next.config.ts
│       ├── tsconfig.json
│       └── package.json
│
├── storage/                          # Directorio (gitignored) donde se guardan los datos del usuario
├── docs/
│   ├── CONTEXT.md                    # Documentación de contexto y decisiones
│   └── SUBAGENTS.md                  # Instrucciones compartidas para subagentes
├── security.md                       # Documentación oficial sobre ciberseguridad
└── package.json                      # Gestor de dependencias global del monorepo
```

### 🗄️ Estructura de Almacenamiento Local (`storage/`)

A diferencia de aplicaciones tradicionales con SQL, _Tasky_ utiliza el sistema de archivos local para persistir el estado de forma limpia:

```text
storage/users/default/projects/<projectId>/
├── info/
│   └── areas.json                    # Define la jerarquía de Áreas y Chats
├── rules.md                          # Reglas globales del proyecto (fallback)
├── ai/
│   ├── layer1/
│   │   └── 00-role-and-flow.md      # Capa 1: Rol y orden de ejecución
│   ├── layer2/
│   │   ├── summary.md                # Capa 2: Resumen global del proyecto
│   │   └── areas/
│   │       └── <areaId>/
│   │           ├── summary.md        # Resumen del área
│   │           └── rules.md          # Reglas del área (independientes por área)
│   └── layer3/
│       └── qa.md                     # Capa 3: QA/Testing gate
├── chat/
│   └── areas/
│       └── <areaId>/
│           └── <chatId>.jsonl        # Historial de chat (una línea por mensaje)
├── history/
│   └── areas/
│       └── <areaId>/
│           └── files/                # Archivos completados del área
├── tasks/
│   ├── inbox/                        # Tareas pendientes de completar
│   └── history/                      # Tareas completadas
└── files/                            # Todos los archivos generados y subidos por el usuario
    └── generated/                    # Archivos generados por la IA
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

## ⚙️ Instalación y Uso Local

### 1. Instalar dependencias

Desde la raíz del proyecto, instala todas las dependencias del monorepo (frontend y backend):

```bash
npm run install:all
```

### 2. Configurar variables de entorno

#### Backend (`apps/api/.env`)

Crea y edita las variables de entorno del backend:

```bash
cp apps/api/.env.example apps/api/.env
```

Dentro de `apps/api/.env`, asegúrate de tener tu clave de OpenRouter y el modelo correctamente configurado:

```env
OPENROUTER_API_KEY=tu_clave_aquí
MODEL=deepseek/deepseek-v4-flash:free
```

#### Frontend (`apps/web/.env.local`)

Crea el archivo de entorno del frontend:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Dentro de `apps/web/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
```

### 3. Iniciar la aplicación

Ejecuta tanto la API como la interfaz web en un solo comando:

```bash
npm run dev:all
```

- **Frontend (Next.js):** http://localhost:3000
- **Backend (Express API):** http://localhost:8787/health

---

_Desarrollado con altos estándares técnicos, diseñado para escalabilidad y máxima compatibilidad documental._
