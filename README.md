# 🚀 Proyecto Task — Plataforma Automatizada de Tareas con IA

**Task** es una aplicación _Full-Stack_ (Node.js + React/Vite) diseñada para organizar, automatizar y resolver tareas a través de un asistente de Inteligencia Artificial integrado. Inspirada en flujos de trabajo autónomos, permite crear flujos de chat por áreas, gestionar archivos y generar documentos estructurados automáticamente usando el poder de \*\*NVIDIA NIM

---

## ✨ Características Principales

1. **Gestor de Tareas y Áreas de Trabajo:** Organiza tus proyectos por áreas funcionales. Cada área tiene sus propias reglas (`rules.md`), un historial de chats independiente y un directorio de archivos dedicado.
2. **Generación Automática de Archivos:** A través de instrucciones en el chat, la IA es capaz de crear de forma autónoma documentos complejos como:
   - 📊 Hojas de cálculo (`.xlsx`)
   - 📄 Documentos de Word (`.docx`)
   - 📽️ Presentaciones PowerPoint (`.pptx`)
   - 🖼️ Gráficos, diagramas y tablas en imagen (`.png`)
3. **Explorador de Archivos Integrado:** Interfaz gráfica (Finder-style) para subir, descargar y organizar los archivos generados o manuales de cada proyecto.
4. **Seguridad Robusta:** Incluye defensas contra ataques (DoS, Path Traversal, XSS) mediante _Rate Limiting_, CORS y _Helmet_.

---

## 📂 Arquitectura del Repositorio (Dónde está cada cosa)

El proyecto funciona como un **Monorepo** y está dividido en dos partes principales: el backend (`api`) y el frontend (`web`).

```text
/home/anuar/Documentos/proyects/task/
│
├── apps/
│   ├── api/                  # Backend en Node.js + Express
│   │   ├── src/
│   │   │   ├── index.js      # Punto de entrada, configuración Express y Seguridad
│   │   │   ├── storage.js    # Lógica del File System local (lectura/escritura/path-traversal)
│   │   │   ├── nvidia.js     # Cliente de conexión a NVIDIA NIM API (Manejo de Prompts y Timeouts)
│   │   │   └── generators/   # Scripts generadores de archivos binarios (xlsx.js, docx.js, etc.)
│   │   └── .env              # Variables de entorno (API Keys de NVIDIA, Puerto)
│   │
│   └── web/                  # Frontend en React + Vite + TypeScript
│       └── src/
│           ├── components/   # UI: Chat.tsx, FileBrowser.tsx, AreasList.tsx, etc.
│           ├── lib/api.ts    # Cliente HTTP para conectarse al backend
│           ├── index.css     # Sistema de diseño, tokens de Tailwind y animaciones
│           └── App.tsx       # Lógica principal de enrutamiento y estado del usuario
│
├── storage/                  # Directorio (gitignored) donde se guardan los datos del usuario
│
├── plan.md                   # Documentación técnica y estructura de datos de la aplicación
├── security.md               # [NUEVO] Documentación oficial sobre la ciberseguridad del sistema
└── package.json              # Gestor de dependencias global del monorepo
```

### 🗄️ Estructura de Almacenamiento Local (`storage/`)

A diferencia de aplicaciones tradicionales con SQL, _Task_ utiliza el sistema de archivos local para persistir el estado de forma limpia:

```text
storage/users/default/projects/<projectId>/
  ├── info/
  │   └── areas.json         # Define la jerarquía de las Áreas y Chats
  ├── rules.md               # Reglas globales del proyecto inyectadas en la IA
  ├── history/               # Historial de chats pasados por área
  ├── tasks/
  │   ├── inbox/             # Tareas pendientes de completar
  │   └── history/           # Tareas completadas (movidas tras hacer clic en "Completado")
  └── files/                 # Todos los archivos generados y subidos por el usuario
```

---

## 🛡️ Seguridad (Cybersecurity)

La API cuenta con protecciones para mitigar ataques cibernéticos y posibles fraudes de saldo en servicios de terceros:

- **Helmet:** Oculta firmas y previene Cross-Site Scripting y ataques MIME.
- **Rate-Limiting (Escudo IA):** Previene ataques DoS y el agotamiento de saldo en NVIDIA API, limitando estrictamente cuántas peticiones puede hacer una IP por hora.
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

### 2. Configurar la API Key

Crea y edita las variables de entorno del backend:

```bash
cp apps/api/.env.example apps/api/.env
```

Dentro de `apps/api/.env`, asegúrate de tener tu clave de NVIDIA y el modelo correctamente configurado (se recomienda fuertemente el uso de **`meta/llama-3.1-70b-instruct`** o su versión 3.3 debido a su alta velocidad para prevenir _timeouts_):

```env
NVIDIA_API_KEY=nvapi-XXXX...
MODEL=meta/llama-3.1-70b-instruct
```

### 3. Iniciar la aplicación

Ejecuta tanto la API como la interfaz web en un solo comando:

```bash
npm run dev:all
```

- **Frontend (React UI):** http://localhost:5173
- **Backend (Express API):** http://localhost:8787/health

---

_Desarrollado con altos estándares técnicos, diseñado para escalabilidad y máxima compatibilidad documental._
