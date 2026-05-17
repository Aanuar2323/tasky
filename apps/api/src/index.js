/**
 * index.js — Servidor API principal de la aplicación Task
 *
 * Este es el punto de entrada del backend. Define todas las rutas
 * REST que consume el frontend (React/Vite). Usa Express.js con
 * CORS habilitado y validación de esquemas con Zod.
 *
 * Arquitectura general:
 *   - Almacenamiento: archivos en disco (storage/) vía storage.js
 *   - IA: NVIDIA NIM API (GLM 5.1) vía nvidia.js
 *   - Persistencia del chat: archivos .jsonl (una línea por mensaje)
 *
 * Prefijo de rutas: /api/projects/:id/...
 * Puerto por defecto: 8787
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  ensureProjectScaffold,
  listDir,
  readTextFile,
  writeTextFile,
  deletePath,
  movePath,
  projectRoot,
  getStorageRoot,
  safeJoin,
} from './storage.js';

import { nvidiaChat } from './nvidia.js';

import { generateFile, readFileStructure, editFile, detectFileType } from './generators/index.js';

/* ==========================================================
   Configuración del servidor Express
   ========================================================== */

const app = express();

// Permitir peticiones desde otros orígenes (frontend en puerto diferente)
app.use(cors());

// Parsear cuerpos JSON (límite 10MB para permitir mensajes largos)
app.use(express.json({ limit: '10mb' }));

// Puerto de escucha (default: 8787)
const PORT = Number(process.env.PORT ?? 8787);

// Uploads (memoria) — límite 50MB por archivo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Usuario por defecto (MVP: un solo usuario)
const USER_ID = 'default';

/* ==========================================================
   Funciones auxiliares
   ========================================================== */

/**
 * Asegura que el directorio raíz de storage exista.
 * Se llama al iniciar el servidor.
 */
async function ensureRoot() {
  await fs.mkdir(getStorageRoot(), { recursive: true });
}

/**
 * Extrae metadatos especiales del mensaje del asistente.
 *
 * El asistente puede incluir una línea al final con el formato:
 *   TASK_APP_META: {"complete":true,"taskPath":"tasks/inbox/x.md","summary":"..."}
 *
 * Esta función separa ese metadato del texto visible para el usuario.
 *
 * @param {string} text - Texto completo devuelto por la IA
 * @returns {{cleanText: string, meta: Object|null}} Texto limpio y metadato parseado
 */
function parseMetaFromAssistant(text) {
  const marker = 'TASK_APP_META:';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return { cleanText: text, meta: null };

  const metaStr = text.slice(idx + marker.length).trim();
  const cleanText = text.slice(0, idx).trim();

  try {
    const meta = JSON.parse(metaStr);
    return { cleanText, meta };
  } catch {
    return { cleanText: text, meta: null };
  }
}

/**
 * Agrega una entrada (objeto JSON) como nueva línea al final de un archivo .jsonl.
 * Crea el directorio si no existe.
 *
 * @param {string} filePath - Ruta absoluta del archivo .jsonl
 * @param {Object} obj      - Objeto a serializar y agregar
 */
async function appendJsonl(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Lee un archivo si existe, si no devuelve string vacío.
 */
async function readOptional(root, relPath) {
  try {
    return await readTextFile(root, relPath);
  } catch {
    return '';
  }
}

/**
 * Lista archivos .md en un directorio (ruta relativa dentro del proyecto).
 */
async function listMarkdownFiles(root, relDir) {
  try {
    const abs = safeJoin(root, relDir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name !== 'summary.md')
      .map((e) => path.posix.join(relDir.split(path.sep).join(path.posix.sep), e.name));
  } catch {
    return [];
  }
}

function pickRelevantFiles(prompt, files, max = 3) {
  const tokens = (prompt ?? '')
    .toLowerCase()
    .match(/[a-z0-9áéíóúñ]+/gi)
    ?.filter((t) => t.length >= 4) ?? [];

  if (tokens.length === 0) return files.slice(0, max);

  const scored = files
    .map((f) => {
      const name = f.toLowerCase();
      const score = tokens.reduce((acc, t) => (name.includes(t) ? acc + 1 : acc), 0);
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f);

  return (scored.length ? scored : files).slice(0, max);
}

/* ==========================================================
   RUTAS DE LA API
   ========================================================== */

// ── Health Check ───────────────────────────────────────────

/**
 * GET /health
 * Verifica que el servidor esté funcionando.
 * Retorna: { ok: true }
 */
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Proyectos ──────────────────────────────────────────────

/**
 * GET /api/projects
 * Lista todos los proyectos del usuario por defecto.
 * Retorna: { projects: [{ id: string }] }
 */
app.get('/api/projects', async (_req, res) => {
  await ensureRoot();
  const userProjectsDir = path.join(getStorageRoot(), 'users', USER_ID, 'projects');
  await fs.mkdir(userProjectsDir, { recursive: true });
  const entries = await fs.readdir(userProjectsDir, { withFileTypes: true });
  const projects = entries.filter((e) => e.isDirectory()).map((e) => ({ id: e.name }));
  res.json({ projects });
});

/**
 * POST /api/projects
 * Crea un nuevo proyecto con estructura de carpetas completa.
 * Body: { name?: string } — Nombre opcional del proyecto
 * Retorna: { id: string } — ID único generado (nanoid 10 chars)
 */
app.post('/api/projects', async (req, res) => {
  const schema = z.object({ name: z.string().min(1).max(80).optional() });
  const body = schema.parse(req.body ?? {});
  const id = nanoid(10);
  const root = projectRoot({ userId: USER_ID, projectId: id });
  await ensureProjectScaffold(root);
  if (body.name) {
    await writeTextFile(root, 'info/name.txt', body.name);
  }
  res.json({ id });
});

// ── Explorador de archivos (árbol y contenido) ─────────────

/**
 * GET /api/projects/:id/tree?path=<relPath>
 * Lista el contenido de un directorio dentro del proyecto.
 * Query params: path — ruta relativa dentro del proyecto (vacío = raíz)
 * Retorna: { entries: [{name, type, path}] }
 */
app.get('/api/projects/:id/tree', async (req, res) => {
  const projectId = req.params.id;
  const relPath = String(req.query.path ?? '');
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  const entries = await listDir(root, relPath);
  res.json({ entries });
});

/**
 * GET /api/projects/:id/file?path=<relPath>
 * Lee el contenido de un archivo de texto dentro del proyecto.
 * Query params: path — ruta relativa del archivo
 * Retorna: { content: string }
 */
app.get('/api/projects/:id/file', async (req, res) => {
  const projectId = req.params.id;
  const relPath = String(req.query.path ?? '');
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  const content = await readTextFile(root, relPath);
  res.json({ content });
});

/**
 * POST /api/projects/:id/file
 * Crea o sobreescribe un archivo de texto dentro del proyecto.
 * Body: { path: string, content: string } — Ruta y contenido del archivo
 * Retorna: { ok: true }
 */
app.post('/api/projects/:id/file', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ path: z.string().min(1), content: z.string() });
  const body = schema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  await writeTextFile(root, body.path, body.content);
  res.json({ ok: true });
});

/**
 * DELETE /api/projects/:id/file
 * Elimina un archivo o directorio dentro del proyecto.
 * Body: { path: string } — Ruta relativa a eliminar
 * Retorna: { ok: true }
 */
app.delete('/api/projects/:id/file', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ path: z.string().min(1) });
  const body = schema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  await deletePath(root, body.path);
  res.json({ ok: true });
});

// ── Áreas de trabajo ───────────────────────────────────────

/**
 * GET /api/projects/:id/areas
 * Obtiene la configuración de áreas del proyecto (áreas, chats, IDs activos).
 * Retorna: { areas: Area[], activeAreaId: string }
 */
app.get('/api/projects/:id/areas', async (req, res) => {
  const projectId = req.params.id;
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  const content = await readTextFile(root, 'info/areas.json');
  res.json(JSON.parse(content));
});

/**
 * PUT /api/projects/:id/areas
 * Actualiza la configuración completa de áreas del proyecto.
 * Body: { areas: Area[], activeAreaId: string } — Configuración completa
 * Retorna: { ok: true }
 */
app.put('/api/projects/:id/areas', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({
    areas: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        pinned: z.boolean().optional(),
        chats: z.array(
          z.object({ id: z.string().min(1), name: z.string().min(1), pinned: z.boolean().optional() })
        ),
        activeChatId: z.string().min(1),
      })
    ),
    activeAreaId: z.string().min(1),
  });
  const body = schema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  await writeTextFile(root, 'info/areas.json', JSON.stringify(body, null, 2));
  // Re-escaffold AI layer2 para nuevas áreas
  await ensureProjectScaffold(root);
  res.json({ ok: true });
});

// ── Gestión de chats y áreas ───────────────────────────────

/**
 * DELETE /api/projects/:id/chat
 * Elimina un chat y su historial .jsonl.
 * Body: { areaId: string, chatId: string }
 */
app.delete('/api/projects/:id/chat', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ areaId: z.string().min(1), chatId: z.string().min(1) });
  const body = schema.parse(req.body ?? {});

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const areasRaw = await readTextFile(root, 'info/areas.json');
  const cfg = JSON.parse(areasRaw);
  const areas = Array.isArray(cfg?.areas) ? cfg.areas : [];

  const nextAreas = areas.map((a) => {
    if (a.id !== body.areaId) return a;
    const nextChats = (a.chats ?? []).filter((c) => c.id !== body.chatId);
    const nextActive = a.activeChatId === body.chatId ? (nextChats[0]?.id ?? 'c1') : a.activeChatId;
    return { ...a, chats: nextChats, activeChatId: nextActive };
  });

  cfg.areas = nextAreas;
  await writeTextFile(root, 'info/areas.json', JSON.stringify(cfg, null, 2));

  // eliminar historial
  const chatRel = `chat/areas/${body.areaId}/${body.chatId}.jsonl`;
  await deletePath(root, chatRel);

  res.json({ ok: true });
});

/**
 * DELETE /api/projects/:id/area
 * Elimina un área y su historial asociado.
 * Body: { areaId: string }
 */
app.delete('/api/projects/:id/area', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ areaId: z.string().min(1) });
  const body = schema.parse(req.body ?? {});

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const areasRaw = await readTextFile(root, 'info/areas.json');
  const cfg = JSON.parse(areasRaw);
  const areas = Array.isArray(cfg?.areas) ? cfg.areas : [];

  const nextAreas = areas.filter((a) => a.id !== body.areaId);
  const nextActiveAreaId = cfg.activeAreaId === body.areaId ? (nextAreas[0]?.id ?? 'a1') : cfg.activeAreaId;

  cfg.areas = nextAreas;
  cfg.activeAreaId = nextActiveAreaId;
  await writeTextFile(root, 'info/areas.json', JSON.stringify(cfg, null, 2));

  // eliminar historial chats y contexto del área
  await deletePath(root, `chat/areas/${body.areaId}`);
  await deletePath(root, `ai/layer2/areas/${body.areaId}`);

  res.json({ ok: true });
});

// ── Archivos: upload / download ───────────────────────────

/**
 * POST /api/projects/:id/upload
 * Sube un archivo a cualquier carpeta del proyecto.
 * FormData: file=<binary>, path=<relDir>
 */
app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
  const projectId = req.params.id;
  const relDir = String(req.body?.path ?? '');
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const fileName = req.file.originalname;
  const relPath = path.posix.join(relDir.split(path.sep).join(path.posix.sep), fileName);
  const abs = safeJoin(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, req.file.buffer);

  res.json({ ok: true, path: relPath });
});

/**
 * GET /api/projects/:id/download?path=<relPath>
 * Descarga un archivo (binary).
 */
app.get('/api/projects/:id/download', async (req, res) => {
  const projectId = req.params.id;
  const relPath = String(req.query.path ?? '');
  if (!relPath) return res.status(400).json({ error: 'path required' });

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const abs = safeJoin(root, relPath);
  return res.download(abs);
});

// ── File Generation ────────────────────────────────────────

app.post('/api/projects/:id/generate', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({
    type: z.enum(['xlsx', 'docx', 'pptx', 'png']),
    data: z.any().optional(),
    filename: z.string().min(1).max(120).optional(),
    areaId: z.string().min(1),
    chatId: z.string().min(1),
    editPath: z.string().optional(),
    editChanges: z.any().optional(),
  });
  const body = schema.parse(req.body ?? {});

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const outputDir = path.join(root, 'files', 'generated');
  let result;

  try {
    if (body.editPath && body.editChanges) {
      const inputAbs = safeJoin(root, body.editPath);
      const fileType = detectFileType(body.editPath);

      if (fileType !== body.type) {
        return res.status(400).json({ error: 'editPath type does not match type parameter' });
      }

      result = await editFile({
        type: body.type,
        inputPath: inputAbs,
        outputDir,
        changes: body.editChanges,
        filename: body.filename,
      });
    } else {
      if (!body.data) {
        return res.status(400).json({ error: 'data is required for generation' });
      }

      result = await generateFile({
        type: body.type,
        outputDir,
        data: body.data,
        filename: body.filename,
      });
    }

    const relPath = path.relative(root, result.filePath).split(path.sep).join(path.posix.sep);

    const chatLogRel = `chat/areas/${body.areaId}/${body.chatId}.jsonl`;
    await appendJsonl(path.join(root, chatLogRel), {
      id: nanoid(12),
      ts: Date.now(),
      role: 'system',
      type: 'file_generated',
      content: `Archivo generado: ${result.filename}`,
      file: {
        path: relPath,
        filename: result.filename,
        type: body.type,
      },
      areaId: body.areaId,
    });

    res.json({
      ok: true,
      file: {
        path: relPath,
        filename: result.filename,
        type: body.type,
      },
    });
  } catch (e) {
    console.error('Generation error:', e);
    res.status(500).json({ error: `Generation failed: ${e?.message ?? String(e)}` });
  }
});

app.post('/api/projects/:id/add-to-history', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({
    filePath: z.string().min(1),
    areaId: z.string().min(1),
    filename: z.string().min(1).max(120).optional(),
  });
  const body = schema.parse(req.body ?? {});

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const srcAbs = safeJoin(root, body.filePath);

  const originalName = body.filePath.split('/').pop();
  const destName = body.filename ?? originalName;
  const destRel = `history/areas/${body.areaId}/files/${destName}`;

  const destDir = path.join(root, 'history', 'areas', body.areaId, 'files');
  await fs.mkdir(destDir, { recursive: true });

  const destAbs = safeJoin(root, destRel);
  await fs.copyFile(srcAbs, destAbs);

  await appendJsonl(path.join(root, 'chat', 'history.jsonl'), {
    ts: Date.now(),
    action: 'add_to_history',
    from: body.filePath,
    to: destRel,
    areaId: body.areaId,
    filename: destName,
  });

  res.json({ ok: true, historyPath: destRel });
});

app.get('/api/projects/:id/generated-history', async (req, res) => {
  const projectId = req.params.id;
  const areaId = String(req.query.areaId ?? '');
  if (!areaId) return res.status(400).json({ error: 'areaId required' });

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  const relDir = `history/areas/${areaId}/files`;
  try {
    const entries = await listDir(root, relDir);
    res.json({ entries });
  } catch {
    res.json({ entries: [] });
  }
});

// ── Reglas del proyecto ────────────────────────────────────

/**
 * GET /api/projects/:id/rules
 * Obtiene las reglas del proyecto en formato markdown.
 * Retorna: { content: string } — Contenido de rules.md
 */
app.get('/api/projects/:id/rules', async (req, res) => {
  const projectId = req.params.id;
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  const content = await readTextFile(root, 'rules.md');
  res.json({ content });
});

/**
 * PUT /api/projects/:id/rules
 * Actualiza las reglas del proyecto.
 * Body: { markdown: string } — Contenido markdown de las reglas
 * Retorna: { ok: true }
 */
app.put('/api/projects/:id/rules', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ markdown: z.string() });
  const body = schema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  await writeTextFile(root, 'rules.md', body.markdown);
  res.json({ ok: true });
});

// ── Tareas ─────────────────────────────────────────────────

/**
 * POST /api/projects/:id/tasks
 * Crea una nueva tarea en tasks/inbox/.
 * Genera un archivo .md con el título y cuerpo proporcionados.
 * Body: { title: string, body?: string } — Título obligatorio, cuerpo opcional
 * Retorna: { taskPath: string } — Ruta relativa del archivo creado
 */
app.post('/api/projects/:id/tasks', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ title: z.string().min(1).max(120), body: z.string().optional() });
  const body = schema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  // Generar nombre de archivo seguro (sin caracteres especiales)
  const safeTitle = body.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');
  const fileName = `${Date.now()}_${safeTitle || 'task'}.md`;
  const rel = path.posix.join('tasks', 'inbox', fileName);

  // Escribir la tarea como archivo markdown
  await writeTextFile(root, rel, `# ${body.title}\n\n${body.body ?? ''}\n`);
  res.json({ taskPath: rel });
});

// ── Chat — Historial y conversación ────────────────────────

/**
 * GET /api/projects/:id/chatlog?areaId=<id>&chatId=<id>
 * Obtiene el historial de mensajes de un chat específico dentro de un área.
 * Query params: areaId — ID del área, chatId — ID del chat
 * Retorna: { entries: ChatLogEntry[] } — Lista de mensajes guardados
 */
app.get('/api/projects/:id/chatlog', async (req, res) => {
  const projectId = req.params.id;
  const areaId = String(req.query.areaId ?? '');
  const chatId = String(req.query.chatId ?? '');
  if (!areaId || !chatId) return res.status(400).json({ error: 'areaId and chatId required' });

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);
  const rel = `chat/areas/${areaId}/${chatId}.jsonl`;

  try {
    const raw = await readTextFile(root, rel);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const entries = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    res.json({ entries });
  } catch {
    // Si el archivo no existe aún, devolver lista vacía
    res.json({ entries: [] });
  }
});

/**
 * POST /api/projects/:id/chat
 * Envía un mensaje al asistente de IA y guarda la conversación.
 *
 * Flujo:
 *  1. Guarda el mensaje del usuario en el historial (.jsonl)
 *  2. Construye el prompt del sistema con las reglas y la tarea activa
 *  3. Llama a la API de NVIDIA para obtener la respuesta
 *  4. Extrae metadatos (TASK_APP_META) del mensaje del asistente
 *  5. Guarda la respuesta del asistente en el historial (.jsonl)
 *  6. Devuelve la respuesta limpia + metadatos al frontend
 *
 * Body: { messages: Message[], areaId: string, chatId: string, activeTaskPath?: string }
 * Retorna: { id: string, content: string, meta: Object|null }
 */
app.post('/api/projects/:id/chat', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({
    messages: z.array(
      z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })
    ),
    areaId: z.string().min(1),
    chatId: z.string().min(1),
    activeTaskPath: z.string().optional(),
  });
  const body = schema.parse(req.body ?? {});

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  // Leer las reglas del proyecto para incluirlas en el prompt del sistema
  const rules = await readTextFile(root, 'rules.md');
  const activeTask = body.activeTaskPath;
  const areaId = body.areaId;
  const chatId = body.chatId;
  const chatLogRel = `chat/areas/${areaId}/${chatId}.jsonl`;

  // Guardar el último mensaje del usuario en el historial persistente (.jsonl)
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    await appendJsonl(path.join(root, chatLogRel), {
      id: nanoid(12),
      ts: Date.now(),
      role: 'user',
      content: lastUser.content,
    });
  }

  const layer1 = await readOptional(root, 'ai/layer1/00-role-and-flow.md');
  const layer2Summary = await readOptional(root, 'ai/layer2/summary.md');
  const areaSummary = await readOptional(root, `ai/layer2/areas/${areaId}/summary.md`);
  const layer3 = await readOptional(root, 'ai/layer3/qa.md');
  const areaFiles = await listMarkdownFiles(root, `ai/layer2/areas/${areaId}`);
  const selectedFiles = pickRelevantFiles(lastUser?.content ?? '', areaFiles, 3);
  const selectedBlocks = await Promise.all(
    selectedFiles.map(async (rel) => {
      const content = await readOptional(root, rel);
      const clipped = content.slice(0, 4000);
      return `---\nFILE: ${rel}\n${clipped}\n`;
    })
  );
  const areaFilesList = areaFiles.length ? areaFiles.map((f) => `- ${f}`).join('\n') : '- (sin archivos)';
  const selectedText = selectedBlocks.length ? selectedBlocks.join('\n') : '---\n(no se seleccionaron archivos)\n';

  // Construir el prompt del sistema con contexto del proyecto
  const system = {
    role: 'system',
    content:
      `You are an assistant inside a file-based task app.\n\n` +
      `LAYER 1 (role + execution order):\n${layer1}\n\n` +
      `LAYER 2 (global summary):\n${layer2Summary}\n\n` +
      `LAYER 2 (area summary - ${areaId}):\n${areaSummary}\n\n` +
      `LAYER 2 (area files list):\n${areaFilesList}\n\n` +
      `LAYER 2 (selected files):\n${selectedText}\n\n` +
      `RULES (markdown):\n${rules}\n\n` +
      (activeTask
        ? `ACTIVE TASK (if you mark complete, you MUST use this taskPath):\n${activeTask}\n\n`
        : `ACTIVE TASK: none selected. If you mark complete, set taskPath=null unless the user explicitly referenced a task file.\n\n`) +
      `LAYER 3 (QA/testing):\n${layer3}\n\n` +
      `Return normal markdown for the user.\n` +
      `At the end of your message, append EXACTLY ONE line in this format:\n` +
      `TASK_APP_META: {"complete":true|false, "taskPath":string|null, "summary":string}\n` +
      `Only set complete=true if you believe the user's request is fully solved and ready to be moved to history.\n` +
        `IMPORTANT: A task moves to history only when the user clicks the Completado button in the UI.\n\n` +
        `FILE GENERATION CAPABILITY:\n` +
        `When the user asks you to create or edit a file (Excel/Word/PowerPoint/Image), you MUST:\n` +
        `1. Respond with a clear explanation of what you will generate\n` +
        `2. Append a TASK_APP_META line with fileGenerated field:\n` +
        `TASK_APP_META: {"complete":false,"taskPath":null,"summary":"...","fileGenerated":{"type":"xlsx|docx|pptx|png","data":{...},"filename":"suggested-name"}}\n\n` +
        `For edits, include editPath and editChanges instead of data:\n` +
        `TASK_APP_META: {"complete":false,"taskPath":null,"summary":"...","fileGenerated":{"type":"xlsx","editPath":"files/generated/abc.xlsx","editChanges":{...},"filename":"edited-name"}}\n\n` +
        `XLSX data: {sheets:[{name:string,columns:[{header:string,key:string,width?:number}],rows:[{key:value}],styles?:{headerBold:boolean,headerBgColor:string,headerFontColor:string}}]}\n\n` +
        `DOCX data: {title?:string,sections:[{type:"heading"|"paragraph"|"bullet"|"table"|"image",text?:string,level?:1|2|3,bold?:boolean,italic?:boolean,fontSize?:number,alignment?:"left"|"center"|"right"|"justify",rows?:string[][],imagePath?:string,imageWidth?:number,imageHeight?:number}]}\n\n` +
        `PPTX data: {title?:string,slides:[{type:"title"|"content"|"bullets"|"table"|"image",title?:string,subtitle?:string,body?:string,bullets?:string[],rows?:string[][],imagePath?:string,notes?:string}]}\n\n` +
        `PNG chart: {type:"chart",chartType:"bar"|"line"|"pie"|"doughnut",title:string,labels:string[],datasets:[{label:string,data:number[],color?:string}],width?:number,height?:number}\n` +
        `PNG table: {type:"table",title?:string,headers:string[],rows:string[][],width?:number,height?:number}\n` +
        `PNG text: {type:"text",title:string,subtitle?:string,body:string,width?:number,height?:number}\n` +
        `PNG diagram: {type:"diagram",title?:string,nodes:[{id:string,label:string,x:number,y:number}],edges:[{from:string,to:string,label?:string}],width?:number,height?:number}\n` +
        `PNG edit changes: {resize?:{width,height},crop?:{x,y,width,height},rotate?:number,addText?:[{text,x,y,fontSize,color}],brightness?:number,contrast?:number,grayscale?:boolean,blur?:number,sharpen?:boolean,watermark?:{text,fontSize,color,opacity}}\n\n` +
        `IMPORTANT LIMITS FOR FILE GENERATION:\n` +
        `- NEVER generate massive datasets. If the user asks for large datasets (e.g., 'all people you can', 'large sample'), generate ONLY a mock schema with 3 to 5 rows of sample data. Warn the user that LLMs cannot generate large datasets directly and they should run a script or supply data.\n` +
        `- Maximum 10 rows of data per sheet/table under any circumstance.\n` +
        `- Keep the TASK_APP_META JSON as compact as possible: no extra whitespace, no comments, no line breaks inside the JSON.\n` +
        `- Use descriptive filenames in Spanish when appropriate.\n` +
        `- ALWAYS provide the complete data structure in the fileGenerated field.\n`,
  };

  // Llamar a la API de NVIDIA con el historial completo + prompt del sistema
  try {
    const { content } = await nvidiaChat({ messages: [system, ...body.messages] });

    // Separar metadatos del texto visible
    const { cleanText, meta } = parseMetaFromAssistant(content);
    const messageId = nanoid(12);
    const ts = Date.now();

    // Auto-generar archivo si la IA lo solicita
    let generatedFile = null;
    if (meta?.fileGenerated) {
      try {
        const fg = meta.fileGenerated;
        const outputDir = path.join(root, 'files', 'generated');

        let genResult;
        if (fg.editPath && fg.editChanges) {
          const inputAbs = safeJoin(root, fg.editPath);
          genResult = await editFile({
            type: fg.type,
            inputPath: inputAbs,
            outputDir,
            changes: fg.editChanges,
            filename: fg.filename,
          });
        } else {
          genResult = await generateFile({
            type: fg.type,
            outputDir,
            data: fg.data,
            filename: fg.filename,
          });
        }

        const relPath = path.relative(root, genResult.filePath).split(path.sep).join(path.posix.sep);
        generatedFile = {
          path: relPath,
          filename: genResult.filename,
          type: fg.type,
        };
      } catch (genErr) {
        console.error('Auto-generation failed:', genErr);
      }
    }

    // Guardar la respuesta del asistente en el historial persistente (.jsonl)
    await appendJsonl(path.join(root, chatLogRel), {
      id: messageId,
      ts,
      role: 'assistant',
      content: cleanText,
      meta,
      file: generatedFile,
    });

    // Devolver la respuesta al frontend
    res.json({ id: messageId, content: cleanText, meta, file: generatedFile });
  } catch (chatErr) {
    console.error('Chat error:', chatErr);
    res.status(502).json({ error: chatErr?.message ?? 'Error comunicándose con la IA' });
  }
});

// ── Completar tarea ────────────────────────────────────────

/**
 * POST /api/projects/:id/complete
 * Marca una tarea como completada: la mueve de tasks/inbox/ a tasks/history/.
 * También registra la acción en el historial general (chat/history.jsonl).
 *
 * Body: { taskPath: string, note?: string } — Ruta de la tarea y nota opcional
 * Retorna: { ok: true, movedTo: string } — Ruta destino en history/
 */
app.post('/api/projects/:id/complete', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ taskPath: z.string().min(1), note: z.string().optional() });
  const body = schema.parse(req.body ?? {});

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffold(root);

  // Validar que la tarea esté en inbox (no se pueden completar tareas ya en history)
  if (!body.taskPath.startsWith('tasks/inbox/')) {
    return res.status(400).json({ error: 'taskPath must be under tasks/inbox/' });
  }

  // Mover el archivo de inbox/ a history/
  const fileName = body.taskPath.split('/').pop();
  const dest = `tasks/history/${fileName}`;
  await movePath(root, body.taskPath, dest);

  // Registrar la acción en el historial general
  await appendJsonl(path.join(root, 'chat', 'history.jsonl'), {
    ts: Date.now(),
    action: 'complete',
    from: body.taskPath,
    to: dest,
    note: body.note ?? null,
  });

  res.json({ ok: true, movedTo: dest });
});

/* ==========================================================
   Inicio del servidor
   ========================================================== */

// Asegurar que el storage exista antes de empezar a escuchar peticiones
await ensureRoot();

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
