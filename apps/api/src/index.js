/**
 * index.js — Servidor API principal de la aplicación Tasky
 *
 * Este es el punto de entrada del backend. Define todas las rutas
 * REST que consume el frontend (Next.js + React). Usa Express.js con
 * CORS habilitado y validación de esquemas con Zod.
 *
 * Arquitectura general:
 * - Almacenamiento: archivos en disco (storage/) vía storage.js
 * - IA: OpenRouter API (OpenAI-compatible) vía llm-client.js
 * - Persistencia del chat: archivos .jsonl por área y chat
 * - Reglas por área: ai/layer2/areas/{areaId}/rules.md
 *
 * Prefijo de rutas: /api/projects/:id/...
 * Puerto por defecto: 8787
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  ensureProjectScaffold,
  ensureProjectScaffoldCached,
  listDir,
  readTextFile,
  writeTextFile,
  deletePath,
  movePath,
  projectRoot,
  getStorageRoot,
  safeJoin,
} from './storage.js';

import { nvidiaChat, getAvailableProviders, setProvider, getActiveConfig, updateApiConfig, isConfigured } from './llm-client.js';

import { generateFile, readFileStructure, editFile, detectFileType } from './generators/index.js';

/**
 * Extrae el texto de un PDF usando pdfjs-dist (ESM nativo).
 * Itera página a página y concatena el texto completo.
 * @param {Buffer} buf
 * @returns {Promise<{text: string, numpages: number}>}
 */
async function extractPdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const typedArray = new Uint8Array(buf);
  const loadingTask = pdfjs.getDocument({
    data: typedArray,
    disableWorker: true,      // Node.js: sin Web Worker
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const numpages = pdf.numPages;
  const pageTexts = [];

  for (let i = 1; i <= numpages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pageTexts.push(pageText);
  }

  return { text: pageTexts.join('\n\n'), numpages };
}


/* ==========================================================
   Configuración del servidor Express y Seguridad
   ========================================================== */

const app = express();

// 1. Cabeceras de Seguridad HTTP (Protección contra XSS, Clickjacking, etc.)
app.use(helmet());

// 2. Configuración CORS Restringida (Ideal para producción, cambiar '*' por tu dominio)
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 'https://midominio.com' : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parsear cuerpos JSON (límite 10MB para permitir mensajes largos)
app.use(express.json({ limit: '10mb' }));

// 3. Rate Limiting general (Previene ataques de denegación de servicio - DoS)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200, // Límite de 200 peticiones por IP
  message: { error: 'Demasiadas peticiones. Por favor, intenta más tarde.' }
});
app.use(limiter);

// 4. Rate Limiting Estricto para endpoints de costos altos (ej. IA)
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 50, // Límite de 50 chats por hora
  message: { error: 'Has alcanzado el límite de peticiones de IA por esta hora.' }
});

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
  const safeText = typeof text === 'string' ? text : '';
  const marker = 'TASK_APP_META:';
  const idx = safeText.lastIndexOf(marker);
  if (idx === -1) return { cleanText: safeText, meta: null };

  const metaStr = safeText.slice(idx + marker.length).trim();
  const cleanText = safeText.slice(0, idx).trim();

  try {
    const meta = JSON.parse(metaStr);
    return { cleanText, meta };
  } catch {
    return { cleanText: safeText, meta: null };
  }
}

/**
 * Parsea la respuesta estructurada del LLM (JSON schema strict).
 * El LLM ahora responde con un JSON que tiene {content, meta, fileGenerated?}
 * en vez de "markdown + TASK_APP_META: {...}".
 *
 * @param {string} raw — texto crudo de la respuesta del LLM
 * @returns {{content: string, meta: object|null, fileGenerated: object|null, parseError: string|null}}
 */
function parseStructuredResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { content: '', meta: null, fileGenerated: null, parseError: 'empty_response' };
  }
  try {
    const obj = JSON.parse(raw);
    return {
      content: typeof obj.content === 'string' ? obj.content : '',
      meta: obj.meta && typeof obj.meta === 'object' ? obj.meta : null,
      fileGenerated: obj.fileGenerated && typeof obj.fileGenerated === 'object' ? obj.fileGenerated : null,
      parseError: null,
    };
  } catch {
    const { cleanText, meta } = parseMetaFromAssistant(raw);
    return { content: cleanText, meta, fileGenerated: null, parseError: 'legacy_fallback' };
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

async function loadAreasConfig(root) {
  const raw = await readTextFile(root, 'info/areas.json');
  const parsed = JSON.parse(raw);
  const areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
  return { parsed, areas };
}

function areaExists(areas, areaId) {
  return areas.some((area) => area?.id === areaId);
}

function chatExists(areas, areaId, chatId) {
  const area = areas.find((item) => item?.id === areaId);
  if (!area) return false;
  return Array.isArray(area.chats) && area.chats.some((chat) => chat?.id === chatId);
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

// ── Proveedor de IA ─────────────────────────────────────────

/**
 * GET /api/provider
 * Obtiene los proveedores de IA disponibles y sus modelos.
 * Retorna: { providers: Record<string, { label: string, model: string }> }
 */
app.get('/api/provider', (_req, res) => {
  res.json({ providers: getAvailableProviders() });
});

/**
 * POST /api/provider
 * Cambia el proveedor de IA activo.
 * Body: { provider: 'openrouter' | 'nvidia' }
 * Retorna: { ok: true }
 */
app.post('/api/provider', (req, res) => {
  const schema = z.object({ provider: z.enum(['openrouter', 'nvidia']) });
  const body = schema.parse(req.body ?? {});
  setProvider(body.provider);
  res.json({ ok: true });
});

// ── Modelos de OpenRouter ─────────────────────────────────

/**
 * GET /api/models?apiKey=<key>
 * Obtiene todos los modelos disponibles desde OpenRouter.
 * Ordena: gratis primero, luego alfabético.
 */
app.get('/api/models', async (req, res) => {
  const apiKey = String(req.query.apiKey || '') || getActiveConfig().API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'API key requerida' });
  }
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'Error al obtener modelos de OpenRouter' });
    }
    const data = await response.json();
    const models = (data.data || []).map(m => ({
      id: m.id,
      name: m.name,
      isFree: m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0),
    }));
    models.sort((a, b) => {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    res.json({ models });
  } catch (e) {
    res.status(502).json({ error: `Error al conectar con OpenRouter: ${e?.message || String(e)}` });
  }
});

// ── Setup / Status ─────────────────────────────────────────

/**
 * GET /api/status
 * Indica si el servidor está funcionando y si la IA está configurada.
 */
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    configured: isConfigured(),
    provider: getActiveConfig().LABEL,
    model: getActiveConfig().MODEL,
  });
});

/**
 * POST /api/setup
 * Guarda la API key de OpenRouter y el modelo desde el frontend.
 * Body: { apiKey: string, model?: string }
 */
app.post('/api/setup', async (req, res) => {
  const schema = z.object({
    apiKey: z.string().min(10, 'API key demasiado corta'),
    model: z.string().optional(),
  });
  const body = schema.parse(req.body ?? {});
  try {
    await updateApiConfig({ apiKey: body.apiKey, model: body.model });
    res.json({ ok: true, configured: true });
  } catch (e) {
    res.status(500).json({ error: `Error guardando config: ${e?.message || String(e)}` });
  }
});

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
  const areaId = String(req.query.areaId ?? '');
  const relPath = String(req.query.path ?? '');
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffoldCached(root);

  if (areaId) {
    const { areas } = await loadAreasConfig(root);
    if (!areaExists(areas, areaId)) {
      return res.status(404).json({ error: 'area not found' });
    }
  }

  const dir = areaId
    ? (relPath ? `ai/layer2/areas/${areaId}/${relPath}` : `ai/layer2/areas/${areaId}`)
    : (relPath || '');
  const entries = await listDir(root, dir);
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
  await ensureProjectScaffoldCached(root);
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
  await ensureProjectScaffoldCached(root);
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
  await ensureProjectScaffoldCached(root);
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
  await ensureProjectScaffoldCached(root);
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
  await ensureProjectScaffoldCached(root);
  await writeTextFile(root, 'info/areas.json', JSON.stringify(body, null, 2));
  // Re-escaffold AI layer2 para nuevas áreas
  await ensureProjectScaffoldCached(root);
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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

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
  const areaId = String(req.query.areaId ?? '');
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffoldCached(root);

  if (areaId) {
    const { areas } = await loadAreasConfig(root);
    if (!areaExists(areas, areaId)) {
      return res.status(404).json({ error: 'area not found' });
    }
  }

  const relPath = areaId ? `ai/layer2/areas/${areaId}/rules.md` : 'rules.md';
  const content = await readOptional(root, relPath);
  res.json({ content });
});

/**
 * PUT /api/projects/:id/rules
 * Actualiza las reglas del proyecto o de un área específica.
 * Body: { markdown: string, areaId?: string }
 *   - Con areaId: guarda en ai/layer2/areas/{areaId}/rules.md
 *   - Sin areaId: guarda en rules.md (global)
 * Retorna: { ok: true }
 */
app.put('/api/projects/:id/rules', async (req, res) => {
  const projectId = req.params.id;
  const schema = z.object({ markdown: z.string(), areaId: z.string().optional() });
  const body = schema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffoldCached(root);

  if (body.areaId) {
    const { areas } = await loadAreasConfig(root);
    if (!areaExists(areas, body.areaId)) {
      return res.status(404).json({ error: 'area not found' });
    }
  }

  const relPath = body.areaId ? `ai/layer2/areas/${body.areaId}/rules.md` : 'rules.md';
  await writeTextFile(root, relPath, body.markdown);
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
  await ensureProjectScaffoldCached(root);

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
  await ensureProjectScaffoldCached(root);

  const { areas } = await loadAreasConfig(root);
  if (!chatExists(areas, areaId, chatId)) {
    return res.status(404).json({ error: 'areaId/chatId not found' });
  }

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
app.post('/api/projects/:id/chat', aiLimiter, upload.array('attachments', 10), async (req, res) => {
  const projectId = req.params.id;

  // Support both JSON and multipart/form-data
  const isMultipart = req.is('multipart/form-data');
  let rawMessages, rawAreaId, rawChatId, rawTaskPath;
  if (isMultipart) {
    rawMessages = req.body?.messages;
    rawAreaId = req.body?.areaId;
    rawChatId = req.body?.chatId;
    rawTaskPath = req.body?.activeTaskPath;
  } else {
    rawMessages = req.body?.messages;
    rawAreaId = req.body?.areaId;
    rawChatId = req.body?.chatId;
    rawTaskPath = req.body?.activeTaskPath;
  }

  const schema = z.object({
    messages: z.array(
      z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })
    ),
    areaId: z.string().min(1),
    chatId: z.string().min(1),
    activeTaskPath: z.string().optional(),
  });

  const parsedMessages = typeof rawMessages === 'string' ? JSON.parse(rawMessages) : rawMessages;
  const body = schema.parse({
    messages: parsedMessages,
    areaId: rawAreaId,
    chatId: rawChatId,
    activeTaskPath: rawTaskPath,
  });

  // ── Process uploaded attachments ───────────────────────────
  const uploadedFiles = /** @type {import('multer').File[]} */ (req.files ?? []);
  const TEXT_EXTS = /\.(txt|md|markdown|csv|json|jsonl|js|ts|jsx|tsx|py|java|go|rs|c|cpp|h|hpp|css|html|xml|yaml|yml|sh|bash|sql|ini|toml|env)$/i;
  const attachmentBlocks = [];
  const attachmentMeta = [];

  for (const file of uploadedFiles) {
    const name = file.originalname;
    const mime = file.mimetype ?? '';
    const isPdf = mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
    const isText = TEXT_EXTS.test(name) || mime.startsWith('text/');
    attachmentMeta.push({ name, size: file.size, type: mime });

    if (isPdf) {
      try {
        const { text, numpages } = await extractPdfText(file.buffer);
        const excerpt = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000); // 20 KB cap
        attachmentBlocks.push(
          `---\nATTACHED PDF: ${name} (${numpages} page${numpages !== 1 ? 's' : ''}, ${(file.size / 1024).toFixed(1)} KB)\n` +
          `\`\`\`\n${excerpt}\n\`\`\`\n`
        );
      } catch (pdfErr) {
        console.warn(`pdf-parse failed for ${name}:`, pdfErr?.message);
        attachmentBlocks.push(`---\nATTACHED PDF: ${name} — could not extract text (encrypted or corrupted file).\n`);
      }
    } else if (isText) {
      const content = file.buffer.toString('utf8').slice(0, 12000); // 12 KB cap
      attachmentBlocks.push(`---\nATTACHED FILE: ${name}\n\`\`\`\n${content}\n\`\`\`\n`);
    } else if (mime.startsWith('image/')) {
      attachmentBlocks.push(`---\nATTACHED IMAGE: ${name} (${(file.size / 1024).toFixed(1)} KB) — text-only model, cannot display image content.\n`);
    } else {
      attachmentBlocks.push(`---\nATTACHED BINARY FILE: ${name} (${(file.size / 1024).toFixed(1)} KB, type: ${mime || 'unknown'}) — binary content not readable by LLM. Reference by filename only.\n`);
    }
  }

  const root = projectRoot({ userId: USER_ID, projectId });
  await ensureProjectScaffoldCached(root);

  const { areas } = await loadAreasConfig(root);
  if (!chatExists(areas, body.areaId, body.chatId)) {
    return res.status(404).json({ error: 'areaId/chatId not found' });
  }

  // Leer las reglas del proyecto para incluirlas en el prompt del sistema
  const activeTask = body.activeTaskPath;
  const areaId = body.areaId;
  const chatId = body.chatId;
  const rules = await readOptional(root, `ai/layer2/areas/${areaId}/rules.md`);
  const chatLogRel = `chat/areas/${areaId}/${chatId}.jsonl`;

  // Guardar el último mensaje del usuario en el historial persistente (.jsonl)
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    await appendJsonl(path.join(root, chatLogRel), {
      id: nanoid(12),
      ts: Date.now(),
      role: 'user',
      content: lastUser.content,
      attachments: attachmentMeta.length ? attachmentMeta : undefined,
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
      (attachmentBlocks.length
        ? `USER ATTACHMENTS (${attachmentBlocks.length} file(s) — analyze them as requested):\n${attachmentBlocks.join('\n')}\n\n`
        : '') +
      `LAYER 3 (QA/testing):\n${layer3}\n\n` +
      `You must respond with a JSON object that matches this exact schema:\n` +
      `{\n` +
      `  "content": "<markdown visible for the user, never empty>",\n` +
      `  "meta": { "complete": <bool>, "taskPath": <string|null>, "summary": "<short summary>" },\n` +
      `  "fileGenerated": <optional, only when user asks to create/edit a file>\n` +
      `}\n\n` +
      `Rules:\n` +
      `- "content" is REQUIRED and must never be empty. Put the user-facing markdown here.\n` +
      `- "meta.complete" should be true only if the user's request is fully solved.\n` +
      `- "meta.taskPath" should be the active task path if you are marking it complete, else null.\n` +
      `- "meta.summary" is a one-line summary of your response.\n` +
      `- "fileGenerated" is OPTIONAL. Include it only when the user asks to create or edit a file (Excel/Word/PowerPoint/Image). Same structure as before.\n\n` +
      `FILE GENERATION (only when user requests a file):\n` +
      `For XLSX: { "type":"xlsx", "data": { "sheets":[{"name":string,"columns":[{"header":string,"key":string,"width"?:number}],"rows":[{"key":value}],"styles"?:{"headerBold":bool,"headerBgColor":string,"headerFontColor":string}}] }, "filename": "..." }\n` +
      `For DOCX: { "type":"docx", "data": { "title"?:string,"sections":[{"type":"heading|paragraph|bullet|table|image","text"?:string,"level"?:1|2|3,"bold"?:bool,"italic"?:bool,"fontSize"?:number,"alignment"?:string,"rows"?:string[][],"imagePath"?:string,"imageWidth"?:number,"imageHeight"?:number}] }, "filename": "..." }\n` +
      `For PPTX: { "type":"pptx", "data": { "title"?:string,"slides":[{"type":"title|content|bullets|table|image","title"?:string,"subtitle"?:string,"body"?:string,"bullets"?:string[],"rows"?:string[][],"imagePath"?:string,"notes"?:string}] }, "filename": "..." }\n` +
      `For PNG chart: { "type":"png", "data": { "type":"chart","chartType":"bar|line|pie|doughnut","title":string,"labels":string[],"datasets":[{"label":string,"data":number[],"color"?:string}],"width"?:number,"height"?:number }, "filename": "..." }\n` +
      `For PNG table: { "type":"png", "data": { "type":"table","title"?:string,"headers":string[],"rows":string[][],"width"?:number,"height"?:number }, "filename": "..." }\n` +
      `For PNG text: { "type":"png", "data": { "type":"text","title":string,"subtitle"?:string,"body":string,"width"?:number,"height"?:number }, "filename": "..." }\n` +
      `For PNG diagram: { "type":"png", "data": { "type":"diagram","title":string,"nodes":[{"id":string,"label":string,"x":number,"y":number}],"edges":[{"from":string,"to":string,"label"?:string}],"width"?:number,"height"?:number }, "filename": "..." }\n` +
      `For edits, include "editPath" and "editChanges" instead of "data".\n\n` +
      `IMPORTANT LIMITS FOR FILE GENERATION:\n` +
      `- NEVER generate massive datasets. If the user asks for large datasets, generate ONLY 3 to 5 sample rows.\n` +
      `- Maximum 10 rows of data per sheet/table under any circumstance.\n` +
      `- Keep all JSON values compact: no extra whitespace, no comments, no line breaks inside values.\n` +
      `- Use descriptive filenames in Spanish when appropriate.\n`,
  };

  // Llamar a la API de NVIDIA con el historial completo + prompt del sistema
  try {
    const llmResult = await nvidiaChat({ messages: [system, ...body.messages] });
    const rawContent = llmResult?.message?.content ?? '';

    // Parsear respuesta estructurada (JSON schema strict)
    const { content: cleanText, meta, fileGenerated, parseError } = parseStructuredResponse(rawContent);

    if (parseError) {
      console.warn(`[CHAT] parse_error=${parseError} raw_len=${rawContent.length} genId=${llmResult?.generationId}`);
    }
    if (!cleanText || !cleanText.trim()) {
      console.warn(
        `[CHAT] EMPTY_CONTENT model=${llmResult?.raw?.model} genId=${llmResult?.generationId} ` +
        `comp=${llmResult?.usage?.completion_tokens} reasoning=${llmResult?.usage?.completion_tokens_details?.reasoning_tokens} ` +
        `raw_len=${rawContent.length}`
      );
    }

    const messageId = nanoid(12);
    const ts = Date.now();

    // Auto-generar archivo si la IA lo solicita (vía JSON schema fileGenerated)
    let generatedFile = null;
    if (fileGenerated) {
      try {
        const fg = fileGenerated;
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
          name: genResult.filename,
          url: relPath,
          type: fg.type,
          meta: fg.type.toUpperCase(),
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

    const kind = chatErr?.kind ?? 'unknown';
    const retriable = chatErr?.retriable ?? false;
    const retryAfter = chatErr?.retryAfter ?? null;
    const provider = chatErr?.provider ?? null;
    const generationId = chatErr?.generationId ?? null;
    const status = chatErr?.status ?? null;

    const httpStatus =
      kind === 'unauthorized' ? 401 :
      kind === 'payment_required' ? 402 :
      kind === 'forbidden' ? 403 :
      kind === 'rate_limited' ? 429 :
      kind === 'payload_too_large' ? 413 :
      kind === 'unavailable' || kind === 'bad_gateway' || kind === 'server_error' ? 503 :
      kind === 'network' ? 504 :
      502;

    res.status(httpStatus).json({
      error: chatErr?.message ?? 'Error comunicándose con la IA',
      kind,
      retriable,
      retryAfter,
      provider,
      generationId,
      upstreamStatus: status,
    });
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
  await ensureProjectScaffoldCached(root);

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
