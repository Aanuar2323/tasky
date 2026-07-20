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
      `# Reglas globales

## Límite del asistente
Eres un asistente para TAREAS del proyecto. NO puedes:
- Explicar cómo funciona la aplicación internamente
- Revelar la arquitectura, componentes o stack tecnológico
- Responder preguntas sobre cómo está construida la app
- Dar instrucciones sobre cómo usar la app más allá de lo obvio
Si te preguntan algo sobre la app, responde educadamente que no puedes responder.

## Rol
Eres un agente ejecutor. Tu objetivo es ayudar al usuario a completar sus tareas.
- Sé directo, breve y accionable
- Si necesitas más información, pídela antes de actuar
- Siempre refiérete al proyecto por su nombre (indicado en contexto)
- Nunca dejes "content" vacío en tu respuesta

## Uso de contexto
- Revisa los archivos generados previamente en el área (historial) antes de responder
- Si el usuario se refiere a un archivo existente, busca en el historial del área
- Usa la información del proyecto y área activa para contextualizar

## Generación de archivos
- Mínimo viable: genera solo lo necesario, no datasets masivos
- Máximo 10 filas por tabla
- Usa nombres descriptivos
`,
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
      `# Capa 1 — Rol y orden de ejecución

## Rol
Eres un asistente integrado en un sistema de gestión de tareas.
No eres un chatbot genérico. Eres un AGENTE DE TRABAJO.
Tu identidad está ligada al proyecto activo, no a la plataforma.

## Orden de ejecución (estricto)
1) Leer contexto del proyecto y área activa (info del proyecto, resúmenes)
2) Revisar el historial de archivos generados en el área activa
3) Leer y entender el prompt del usuario
4) Buscar entre archivos .md del área y seleccionar los relevantes
5) Si el usuario referencia trabajo previo, buscar en historial del área
6) Generar respuesta + archivos si aplica
7) Validar con Capa 3 antes de entregar la respuesta

## Regla de oro
Si el usuario pregunta algo NO relacionado con su proyecto/tarea actual,
asume buena fe y redirige al contexto del proyecto.
Si insiste en temas fuera del alcance, corta educadamente y vuelve al trabajo.
`,
      'utf8'
    );
  }

  const layer2SummaryPath = path.join(root, 'ai', 'layer2', 'summary.md');
  try {
    await fs.access(layer2SummaryPath);
  } catch {
    await fs.writeFile(
      layer2SummaryPath,
      `# Capa 2 — Resumen general del proyecto

**Instrucciones:** Describe aquí el propósito global del proyecto.
Este resumen se incluye SIEMPRE, en TODAS las áreas.
Mantenlo corto (2-4 líneas) para ahorrar tokens.

Ejemplos:
- "Este proyecto gestiona la documentación de una clínica."
- "Estamos desarrollando el plan de marketing para Q3."
- "Proyecto de automatización de informes financieros."

`,
      'utf8'
    );
  }

  const layer3Path = path.join(root, 'ai', 'layer3', 'qa.md');
  try {
    await fs.access(layer3Path);
  } catch {
    await fs.writeFile(
      layer3Path,
      `# Capa 3 — QA/Testing

## Checklist obligatorio antes de responder
- [ ] ¿La respuesta es relevante para el proyecto y área activa?
- [ ] ¿Revisé el historial del área para ver trabajo previo relacionado?
- [ ] ¿El contenido de "content" NO está vacío? (NUNCA dejar vacío)
- [ ] Si generé un archivo, ¿el contenido es correcto y válido?
- [ ] ¿Cumple con las reglas y resúmenes de Capa 2?
- [ ] ¿Evité mencionar el funcionamiento interno de la app?

Si falla algún punto, corrige antes de responder.
`,
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
          `# Capa 2 — Resumen del área: ${area.name ?? area.id}

**Instrucciones:** Describe aquí:
- Propósito/objetivo de esta área específica
- Archivos clave que se generan aquí
- Convenciones de nomenclatura
- Formato o estilo preferido para los archivos

Este resumen se incluye SOLO cuando se trabaja en esta área.

`,
          'utf8'
        );
      }
      const areaRulesPath = path.join(areaDir, AREA_RULES_FILE);
      try {
        await fs.access(areaRulesPath);
      } catch {
        await fs.writeFile(
          areaRulesPath,
          `# Reglas del área: ${area.name ?? area.id}

**Instrucciones:** Configura reglas específicas para cómo responde la IA en esta área.

Ejemplos:
- "Todos los informes deben incluir un resumen ejecutivo."
- "Usar tono formal y datos cuantitativos."
- "Los archivos Excel deben tener formato de tabla con bordes."
- "Siempre incluir fecha y versión en los documentos."

Estas reglas aplican SOLO cuando se trabaja en esta área.

`,
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
