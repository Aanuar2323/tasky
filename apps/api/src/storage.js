/**
 * storage.js — Capa de almacenamiento basada en archivos
 *
 * Este módulo gestiona toda la persistencia del proyecto en disco.
 * No usa base de datos; todo se guarda como archivos/carpetas dentro
 * de un directorio raíz (storage/).
 *
 * Estructura por proyecto:
 * <storageRoot>/users/<userId>/projects/<projectId>/
 * info/ → Metadatos del proyecto (areas.json, name.txt)
 * chat/areas/ → Historial de conversaciones por área y chat (archivos .jsonl)
 * ai/layer2/areas/<areaId>/ → Contexto por área (summary.md, rules.md)
 * chat/areas/ → Historial de conversaciones por área y chat (archivos .jsonl)
 * ai/layer2/areas/<areaId>/ → Contexto por área (summary(ajkwygebfickuvaulwakfjbscfa).md, rules(ajkwygebfickuvaulwakfjbscfa).md)
 * history/areas/<areaId>/files/ → Archivos completados por área
 * tasks/
 *   inbox/ → Tareas pendientes
 *   history/ → Tareas completadas (movidas desde inbox)
 * files/ → Archivos adjuntos y outputs generados
 * rules.md → Reglas globales del proyecto (fallback si no hay reglas por área)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ==========================================================
   Configuración del directorio raíz de almacenamiento
   ========================================================== */

/**
 * Nombres de archivo (por área) con marker ofuscador.
 * El frontend oculta estos nombres exactos en el árbol visible.
 * Renombrarlos aquí repercute en storage.js, index.js, tests y SidePanel.tsx.
 */
export const AREA_RULES_FILE = 'rules(ajkwygebfickuvaulwakfjbscfa).md';
export const AREA_SUMMARY_FILE = 'summary(ajkwygebfickuvaulwakfjbscfa).md';

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

const scaffoldEnsured = new Set();

export async function ensureProjectScaffoldCached(root) {
  if (scaffoldEnsured.has(root)) return;
  await ensureProjectScaffold(root);
  scaffoldEnsured.add(root);
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
   Plantillas por defecto (también las usa context/project.js para
   reconocer contenido sin editar y no mandarlo al modelo)
   ========================================================== */

export const DEFAULT_GLOBAL_RULES = `# Reglas globales

**Instrucciones:** estas reglas aplican en todas las áreas que no tengan reglas propias. Agregalas desde el panel de reglas o escribilas acá, una por línea.

Ejemplos:
- "Respondé siempre en español neutro."
- "Usá montos en pesos argentinos con separador de miles."
- "Incluí un resumen ejecutivo al inicio de cada informe."
`;

export const DEFAULT_LAYER1 = `# Capa 1 — Instrucciones del proyecto

**Instrucciones:** escribí acá indicaciones permanentes para la IA en este proyecto: rol, tono, público y formato preferido. Mientras este archivo tenga solo esta plantilla, no se envía a la IA.
`;

export const DEFAULT_LAYER2_SUMMARY = `# Capa 2 — Resumen general del proyecto

**Instrucciones:** Describe aquí el propósito global del proyecto.
Este resumen se incluye SIEMPRE, en TODAS las áreas.
Mantenlo corto (2-4 líneas) para ahorrar tokens.

Ejemplos:
- "Este proyecto gestiona la documentación de una clínica."
- "Estamos desarrollando el plan de marketing para Q3."
- "Proyecto de automatización de informes financieros."

`;

export const DEFAULT_LAYER3 = `# Capa 3 — Criterios de calidad

**Instrucciones:** listá acá los controles que toda respuesta debe cumplir (por ejemplo, "citar la fuente de cada cifra"). Mientras este archivo tenga solo esta plantilla, no se envía a la IA.
`;

export function areaSummaryTemplate(name) {
  return `# Capa 2 — Resumen del área: ${name}

**Instrucciones:** Describe aquí:
- Propósito/objetivo de esta área específica
- Archivos clave que se generan aquí
- Convenciones de nomenclatura
- Formato o estilo preferido para los archivos

Este resumen se incluye SOLO cuando se trabaja en esta área.

`;
}

export function areaRulesTemplate(name) {
  return `# Reglas del área: ${name}

**Instrucciones:** Configura reglas específicas para cómo responde la IA en esta área.

Ejemplos:
- "Todos los informes deben incluir un resumen ejecutivo."
- "Usar tono formal y datos cuantitativos."
- "Los archivos Excel deben tener formato de tabla con bordes."
- "Siempre incluir fecha y versión en los documentos."

Estas reglas aplican SOLO cuando se trabaja en esta área.

`;
}

/* ==========================================================
   Scaffolding — Creación de la estructura por defecto
   ========================================================== */

/**
 * Asegura que un proyecto tenga toda la estructura de carpetas
 * y archivos por defecto. Si algo ya existe, no lo sobreescribe.
 *
 * Crea:
 * - Carpetas: info/, chat/areas/, tasks/inbox/, tasks/history/, files/
 * - Archivo: rules.md (global fallback, solo si no existe)
 * - Archivo: info/areas.json (solo si no existe, con 3 áreas iniciales)
 * - AI layers: ai/layer1/, ai/layer2/areas/<areaId>/, ai/layer3/
 * - Por área: summary.md + rules.md (area-scoped)
 * - Por área: history/areas/<areaId>/files/
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
      DEFAULT_GLOBAL_RULES,
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
      DEFAULT_LAYER1,
      'utf8'
    );
  }

  const layer2SummaryPath = path.join(root, 'ai', 'layer2', 'summary.md');
  try {
    await fs.access(layer2SummaryPath);
  } catch {
    await fs.writeFile(
      layer2SummaryPath,
      DEFAULT_LAYER2_SUMMARY,
      'utf8'
    );
  }

  const layer3Path = path.join(root, 'ai', 'layer3', 'qa.md');
  try {
    await fs.access(layer3Path);
  } catch {
    await fs.writeFile(
      layer3Path,
      DEFAULT_LAYER3,
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
      const areaSummaryPath = path.join(areaDir, AREA_SUMMARY_FILE);
      try {
        await fs.access(areaSummaryPath);
      } catch {
        await fs.writeFile(
          areaSummaryPath,
          areaSummaryTemplate(area.name ?? area.id),
          'utf8'
        );
      }
      const areaRulesPath = path.join(areaDir, AREA_RULES_FILE);
      try {
        await fs.access(areaRulesPath);
      } catch {
        await fs.writeFile(
          areaRulesPath,
          areaRulesTemplate(area.name ?? area.id),
          'utf8'
        );
      }
    }
  } catch {
    // ignorar si areas.json está malformado
  }

  // Crear history/areas/{areaId}/files/ para cada área existente
  try {
    const raw = await fs.readFile(areasPath, 'utf8');
    const parsed = JSON.parse(raw);
    const areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
    for (const area of areas) {
      await fs.mkdir(path.join(root, 'history', 'areas', area.id, 'files'), { recursive: true });
    }
  } catch {
    // ignorar
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

/* ==========================================================
   Skills defaults — copy generators skills from defaults
   ========================================================== */

const SKILLS_DIR = 'skills/generators';
const DEFAULTS_SKILLS_ROOT = path.join(STORAGE_ROOT, 'defaults', SKILLS_DIR);

/**
 * Returns the skills path for a user.
 * Copies defaults on first access.
 * @param {string} [userId='default']
 * @returns {string} absolute path to user skills dir
 */
export async function getUserSkillsPath(userId = 'default') {
  const userSkills = path.join(STORAGE_ROOT, 'users', userId, SKILLS_DIR);

  try {
    await fs.access(userSkills);
  } catch {
    const defaults = path.join(STORAGE_ROOT, 'defaults', SKILLS_DIR);
    try {
      const entries = await fs.readdir(DEFAULTS_SKILLS_ROOT);
      await fs.mkdir(userSkills, { recursive: true });
      for (const entry of entries) {
        const src = path.join(DEFAULTS_SKILLS_ROOT, entry);
        const dst = path.join(userSkills, entry);
        try {
          await fs.copyFile(src, dst);
        } catch { /* best effort */ }
      }
    } catch {
      // no defaults available — create empty
      await fs.mkdir(userSkills, { recursive: true });
    }
  }

  return `storage/users/${userId}/${SKILLS_DIR}`;
}

/* ==========================================================
   Identificadores y nombres de archivo seguros
   ========================================================== */

/** IDs de área/chat/proyecto: sin separadores ni puntos (evita rutas). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// eslint-disable-next-line no-control-regex
const RESERVED_CHARS = /[<>:"|?*\u0000-\u001F\u007F]/g;

/**
 * Nombre de archivo seguro (cualquier extensión): sin directorios ni
 * caracteres reservados, ≤ 120 caracteres.
 */
export function sanitizeName(name, fallback = 'archivo') {
  let base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  base = base.replace(RESERVED_CHARS, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) return fallback;
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/**
 * Guarda un archivo subido en relDir con nombre libre (nombre-2.ext si existe).
 * @returns {Promise<{name:string, path:string, size:number, type:string|null}>}
 */
export async function saveUploadedFile(root, relDir, name, buffer, mime = null) {
  const dir = safeJoin(root, relDir);
  await fs.mkdir(dir, { recursive: true });
  const clean = sanitizeName(name);
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let n = 1; n < 500; n += 1) {
    const candidate = n === 1 ? clean : `${stem}-${n}${ext}`;
    try {
      await fs.writeFile(path.join(dir, candidate), buffer, { flag: 'wx' });
      return { name: candidate, path: path.posix.join(relDir, candidate), size: buffer.length, type: mime || null };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`No se pudo guardar ${clean}`);
}
