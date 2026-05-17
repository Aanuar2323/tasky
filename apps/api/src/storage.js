/**
 * storage.js — Capa de almacenamiento basada en archivos
 *
 * Este módulo gestiona toda la persistencia del proyecto en disco.
 * No usa base de datos; todo se guarda como archivos/carpetas dentro
 * de un directorio raíz (storage/).
 *
 * Estructura por proyecto:
 *   <storageRoot>/users/<userId>/projects/<projectId>/
 *     info/          → Metadatos del proyecto (areas.json, name.txt)
 *     chat/          → Historial de conversaciones
 *       areas/       → Subcarpetas por área y por chat (archivos .jsonl)
 *     tasks/
 *       inbox/       → Tareas pendientes
 *       history/     → Tareas completadas (movidas desde inbox)
 *     files/         → Archivos adjuntos y outputs generados
 *     rules.md       → Reglas del proyecto en formato markdown
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ==========================================================
   Configuración del directorio raíz de almacenamiento
   ========================================================== */

/**
 * Raíz donde se guarda todo el storage.
 * Por defecto: <proyecto>/storage/
 * Se puede sobreescribir con la variable de entorno STORAGE_ROOT.
 */
const STORAGE_ROOT = path.resolve(
  process.env.STORAGE_ROOT ?? path.join(process.cwd(), '..', '..', 'storage')
);

/**
 * Devuelve la ruta raíz del almacenamiento.
 * @returns {string} Ruta absoluta al directorio storage
 */
export function getStorageRoot() {
  return STORAGE_ROOT;
}

/* ==========================================================
   Utilidades de rutas y seguridad
   ========================================================== */

/**
 * Calcula la ruta raíz de un proyecto específico.
 * @param {Object} params
 * @param {string} params.userId   - ID del usuario (por defecto 'default')
 * @param {string} params.projectId - ID del proyecto (obligatorio)
 * @returns {string} Ruta absoluta al directorio del proyecto
 */
export function projectRoot({ userId = 'default', projectId }) {
  if (!projectId) throw new Error('projectId required');
  return path.join(STORAGE_ROOT, 'users', userId, 'projects', projectId);
}

/**
 * Une de forma segura una ruta relativa a una raíz.
 * Previene path traversal (acceso fuera del directorio del proyecto).
 * @param {string} root    - Ruta raíz absoluta
 * @param {string} relPath - Ruta relativa dentro del proyecto
 * @returns {string} Ruta resuelta y validada
 * @throws {Error} Si la ruta resultante escapa del directorio raíz
 */
export function safeJoin(root, relPath = '') {
  const resolved = path.resolve(root, relPath);
  const normalizedRoot = path.resolve(root);
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error('Invalid path');
  }
  return resolved;
}

/* ==========================================================
   Scaffolding — Creación de la estructura por defecto
   ========================================================== */

/**
 * Asegura que un proyecto tenga toda la estructura de carpetas
 * y archivos por defecto. Si algo ya existe, no lo sobreescribe.
 *
 * Crea:
 *  - Carpetas: info/, chat/areas/, tasks/inbox/, tasks/history/, files/
 *  - Archivo: rules.md (solo si no existe)
 *  - Archivo: info/areas.json (solo si no existe, con 3 áreas iniciales)
 *
 * @param {string} root - Ruta raíz del proyecto
 */
export async function ensureProjectScaffold(root) {
  // Crear todas las carpetas necesarias (recursive: true no falla si ya existen)
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'info'), { recursive: true });
  await fs.mkdir(path.join(root, 'chat'), { recursive: true });
  await fs.mkdir(path.join(root, 'chat', 'areas'), { recursive: true });
  await fs.mkdir(path.join(root, 'tasks', 'inbox'), { recursive: true });
  await fs.mkdir(path.join(root, 'tasks', 'history'), { recursive: true });
  await fs.mkdir(path.join(root, 'files'), { recursive: true });
  await fs.mkdir(path.join(root, 'files', 'generated'), { recursive: true });

  // Crear rules.md por defecto (solo si no existe)
  const rulesPath = path.join(root, 'rules.md');
  try {
    await fs.access(rulesPath);
  } catch {
    await fs.writeFile(
      rulesPath,
      `# Rules\n\nDescribe your workflow rules here. Generated from the Rules form.\n`,
      'utf8'
    );
  }

  // Crear areas.json por defecto con 3 áreas y 1 chat cada una (solo si no existe)
  const areasPath = path.join(root, 'info', 'areas.json');
  try {
    await fs.access(areasPath);
  } catch {
    const initial = {
      areas: [
        { id: 'a1', name: 'Area #1', chats: [{ id: 'c1', name: 'Chat 1' }], activeChatId: 'c1' },
        { id: 'a2', name: 'Area 2', chats: [{ id: 'c1', name: 'Chat 1' }], activeChatId: 'c1' },
        { id: 'a3', name: 'Area 3', chats: [{ id: 'c1', name: 'Chat 1' }], activeChatId: 'c1' },
      ],
      activeAreaId: 'a1',
    };
    await fs.writeFile(areasPath, JSON.stringify(initial, null, 2), 'utf8');
  }

  // ── AI layered instructions scaffold ─────────────────────
  await fs.mkdir(path.join(root, 'ai', 'layer1'), { recursive: true });
  await fs.mkdir(path.join(root, 'ai', 'layer2', 'areas'), { recursive: true });
  await fs.mkdir(path.join(root, 'ai', 'layer3'), { recursive: true });

  const layer1Path = path.join(root, 'ai', 'layer1', '00-role-and-flow.md');
  try {
    await fs.access(layer1Path);
  } catch {
    await fs.writeFile(
      layer1Path,
      `# Capa 1 — Rol y orden de ejecución\n\n` +
        `## Rol\nEres un asistente dentro de una app de tareas basada en archivos. Sé directo, breve y accionable.\n\n` +
        `## Orden de ejecución\n` +
        `1) Leer Capa 2: resumen general.\n` +
        `2) Leer Capa 2: resumen del área activa.\n` +
        `3) Leer el prompt del usuario.\n` +
        `4) Buscar entre archivos .md del área y decidir cuáles leer o repasar.\n` +
        `5) Generar respuesta.\n` +
        `6) Validar con Capa 3 antes de responder.\n`,
      'utf8'
    );
  }

  const layer2SummaryPath = path.join(root, 'ai', 'layer2', 'summary.md');
  try {
    await fs.access(layer2SummaryPath);
  } catch {
    await fs.writeFile(
      layer2SummaryPath,
      `# Capa 2 — Resumen general\n\n` +
        `Resumen global del proyecto y cómo trabajar en él. Mantener corto para no gastar tokens.\n`,
      'utf8'
    );
  }

  const layer3Path = path.join(root, 'ai', 'layer3', 'qa.md');
  try {
    await fs.access(layer3Path);
  } catch {
    await fs.writeFile(
      layer3Path,
      `# Capa 3 — QA/Testing\n\n` +
        `Antes de responder, valida que el resultado sea correcto, completo y funcional. ` +
        `Si hay fallas, corrige y vuelve a validar hasta cumplir el estándar.\n`,
      'utf8'
    );
  }

  // Crear/asegurar carpetas de área y summary.md por cada área existente
  try {
    const raw = await fs.readFile(areasPath, 'utf8');
    const parsed = JSON.parse(raw);
    const areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
    for (const area of areas) {
      const areaDir = path.join(root, 'ai', 'layer2', 'areas', area.id);
      await fs.mkdir(areaDir, { recursive: true });
      const areaSummaryPath = path.join(areaDir, 'summary.md');
      try {
        await fs.access(areaSummaryPath);
      } catch {
        await fs.writeFile(
          areaSummaryPath,
          `# Capa 2 — Resumen del área (${area.name ?? area.id})\n\n` +
            `Describe aquí el contexto del área, objetivos y notas clave.\n`,
          'utf8'
        );
      }
    }
  } catch {
    // ignore malformed areas.json
  }

  // Create history/areas/{areaId}/files/ for each existing area
  try {
    const raw = await fs.readFile(areasPath, 'utf8');
    const parsed = JSON.parse(raw);
    const areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
    for (const area of areas) {
      await fs.mkdir(path.join(root, 'history', 'areas', area.id, 'files'), { recursive: true });
    }
  } catch {
    // ignore
  }
}


/* ==========================================================
   Operaciones de sistema de archivos
   ========================================================== */

/**
 * Lista el contenido de un directorio dentro del proyecto.
 * Devuelve carpetas primero, luego archivos, ordenados alfabéticamente.
 * @param {string} root    - Ruta raíz del proyecto
 * @param {string} relPath - Ruta relativa del directorio a listar
 * @returns {Array<{name: string, type: 'dir'|'file', path: string}>} Entradas encontradas
 */
export async function listDir(root, relPath = '') {
  const target = safeJoin(root, relPath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.posix.join(relPath.split(path.sep).join(path.posix.sep), e.name),
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

/**
 * Lee un archivo de texto dentro del proyecto.
 * @param {string} root    - Ruta raíz del proyecto
 * @param {string} relPath - Ruta relativa del archivo
 * @returns {string} Contenido del archivo como texto
 */
export async function readTextFile(root, relPath) {
  const target = safeJoin(root, relPath);
  return fs.readFile(target, 'utf8');
}

/**
 * Escribe un archivo de texto dentro del proyecto.
 * Crea los directorios intermedios si no existen.
 * @param {string} root    - Ruta raíz del proyecto
 * @param {string} relPath - Ruta relativa del archivo
 * @param {string} content - Contenido a escribir
 */
export async function writeTextFile(root, relPath, content) {
  const target = safeJoin(root, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

/**
 * Elimina un archivo o directorio dentro del proyecto.
 * Si es directorio, lo elimina recursivamente.
 * @param {string} root    - Ruta raíz del proyecto
 * @param {string} relPath - Ruta relativa a eliminar
 */
export async function deletePath(root, relPath) {
  const target = safeJoin(root, relPath);
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Mueve un archivo o directorio dentro del proyecto.
 * Crea el directorio destino si no existe.
 * @param {string} root     - Ruta raíz del proyecto
 * @param {string} fromRel  - Ruta relativa de origen
 * @param {string} toRel    - Ruta relativa de destino
 */
export async function movePath(root, fromRel, toRel) {
  const from = safeJoin(root, fromRel);
  const to = safeJoin(root, toRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}
