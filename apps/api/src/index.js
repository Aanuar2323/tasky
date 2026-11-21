/**
 * index.js — API de Tasky (Express 5).
 *
 * Rutas REST del frontend. La lógica vive en módulos:
 *   storage.js        persistencia en disco (proyectos, áreas, archivos)
 *   llm/              proveedores, capacidades de modelos, cliente con streaming
 *   context/          extracción de texto, recuperación, presupuesto, historial
 *   chat/             prompt, herramientas, protocolo de texto, loop del chat
 *   generators/       cliente del docengine Python (docx/xlsx/pptx)
 *
 * Prefijo de rutas: /api/projects/:id/... · Puerto por defecto: 8787
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
  isValidId,
  sanitizeName,
  saveUploadedFile,
  ID_RE,
  AREA_RULES_FILE,
} from './storage.js';
import {
  getAvailableProviders,
  setProvider,
  getActiveConfig,
  getActiveProvider,
  updateApiConfig,
  getModelsForProvider,
  isConfigured,
  getModelProfile,
} from './llm-client.js';
import { humanizeError, httpStatusFor } from './llm/errors.js';
import { resolveReasoningEffort } from './llm/capabilities.js';
import { chatgptAuth } from './llm/chatgpt-auth.js';
import { reconcileActiveProvider } from './llm/providers.js';
import { clearChatgptCatalog, listChatgptModels } from './llm/responses.js';
import { generateFile, editFile, detectFileType } from './generators/docengine.js';
import { CONTEXT_EXTS, extractText } from './context/extract.js';
import { listAreaContextFiles, listGeneratedFiles } from './context/project.js';
import { parseStructuredResponse, normalizeFileGenerated } from './chat/protocol.js';
import { runChat } from './chat/service.js';
import { createSse } from './chat/sse.js';
import { buildPreview, isPreviewablePath } from './preview.js';

/* ==========================================================
   Servidor y seguridad
   ========================================================== */

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

function resolveCorsOrigin() {
  if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN.trim() !== '') {
    const parts = process.env.CORS_ORIGIN.trim().split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  }
  if (process.env.NODE_ENV === 'production') return 'https://midominio.com';
  return '*';
}
app.use(cors({
  origin: resolveCorsOrigin(),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
}));

app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX ?? 600),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Esperá unos minutos.' },
});
app.use(limiter);

export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_MAX ?? 120),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Alcanzaste el límite de mensajes a la IA por esta hora.' },
});

const PORT = Number(process.env.PORT ?? 8787);
const USER_ID = 'default';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

/* ==========================================================
   Utilidades
   ========================================================== */

const idSchema = z.string().regex(ID_RE, 'id inválido');

app.param('id', (req, res, next, id) => {
  if (!isValidId(id)) return res.status(400).json({ error: 'id de proyecto inválido' });
  return next();
});

async function ensureRoot() {
  await fs.mkdir(getStorageRoot(), { recursive: true });
}

async function appendJsonl(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

async function readOptional(root, relPath) {
  try {
    return await readTextFile(root, relPath);
  } catch {
    return '';
  }
}

async function projectFor(req) {
  const root = projectRoot({ userId: USER_ID, projectId: req.params.id });
  await ensureProjectScaffoldCached(root);
  return root;
}

async function loadAreasConfig(root) {
  const parsed = JSON.parse(await readTextFile(root, 'info/areas.json'));
  const areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
  return { parsed, areas };
}

function areaExists(areas, areaId) {
  return areas.some((area) => area?.id === areaId);
}

function chatExists(areas, areaId, chatId) {
  const area = areas.find((item) => item?.id === areaId);
  return !!area && Array.isArray(area.chats) && area.chats.some((chat) => chat?.id === chatId);
}

/** Texto plano de un archivo del proyecto (ruta relativa). '' si no es legible. */
async function readContextFile(root, relPath) {
  try {
    return await extractText(safeJoin(root, relPath));
  } catch {
    return '';
  }
}

/** Rutas de los archivos de contexto del área (compatibilidad). */
async function listAllContextFiles(root, areaId) {
  return (await listAreaContextFiles(root, areaId)).map((f) => f.path);
}

function allowedUploadDir(relDir) {
  const p = path.posix.normalize(String(relDir ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, ''));
  if (!p || p === '.') return 'files/uploads';
  if (p.startsWith('..') || p.split('/').some((seg) => seg.startsWith('.'))) return null;
  return p.startsWith('ai/layer2/areas/') || p.startsWith('files/') ? p : null;
}

/* ==========================================================
   Salud, proveedores y modelos
   ========================================================== */

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/provider', (_req, res) => {
  res.json({ providers: getAvailableProviders(), activeProvider: getActiveProvider() });
});

const PROVIDER_ENUM = z.enum(['openrouter', 'nvidia', 'chatgpt']);
const KEY_PROVIDER_ENUM = z.enum(['openrouter', 'nvidia']);

app.post('/api/provider', (req, res) => {
  const body = z.object({ provider: PROVIDER_ENUM }).parse(req.body ?? {});
  if (!setProvider(body.provider)) {
    return res.status(400).json({
      error: body.provider === 'chatgpt'
        ? 'Iniciá sesión con ChatGPT antes de usarlo'
        : `Provider ${body.provider} no configurado`,
    });
  }
  return res.json({ ok: true });
});

app.post('/api/provider/keys', async (req, res) => {
  // ChatGPT no tiene API key: se autentica con OAuth (/api/chatgpt/*).
  const body = z.object({
    provider: KEY_PROVIDER_ENUM,
    apiKey: z.string().min(1, 'API key requerida'),
  }).parse(req.body ?? {});
  await updateApiConfig({ apiKey: body.apiKey.trim(), provider: body.provider });
  res.json({ ok: true });
});

app.get('/api/models', async (req, res) => {
  const provider = req.query.provider || getActiveProvider();
  if (!PROVIDER_ENUM.safeParse(provider).success) {
    return res.status(400).json({ error: 'Provider inválido o no especificado. Usá ?provider=openrouter|nvidia|chatgpt' });
  }
  try {
    const { models } = await getModelsForProvider(provider);
    return res.json({ models });
  } catch (e) {
    const human = humanizeError(e);
    return res.status(provider === 'chatgpt' ? httpStatusFor(e.kind) : (e.status || 502)).json({
      error: e.message || 'Error al obtener modelos',
      kind: e.kind ?? null,
      errorHuman: human,
    });
  }
});

/* ==========================================================
   ChatGPT (Sign in with ChatGPT): estado, login, logout
   Los tokens viven solo en el servidor; estas rutas nunca los devuelven.
   ========================================================== */

/** Las acciones de ChatGPT solo las pide la UI local, no otro sitio web. */
function requireLocalOrigin(req, res, next) {
  const origin = req.get('origin');
  let allowed = true;
  if (req.get('sec-fetch-site') === 'cross-site') allowed = false;
  else if (origin) {
    const configured = String(process.env.CORS_ORIGIN ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (configured.length && !configured.includes('*')) allowed = configured.includes(origin);
    else {
      try { allowed = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); } catch { allowed = false; }
    }
  }
  if (!allowed) return res.status(403).json({ error: 'Origen no permitido' });
  return next();
}

function chatgptFailure(res, err) {
  const human = humanizeError(err);
  const status = err?.code === 'container_unsupported' ? 409 : httpStatusFor(err?.kind);
  return res.status(status).json({ error: err?.message ?? 'Error de ChatGPT', code: err?.code ?? null, kind: err?.kind ?? 'unknown', errorHuman: human });
}

app.get('/api/chatgpt/status', requireLocalOrigin, (_req, res) => {
  res.json(chatgptAuth.getStatus());
});

app.post('/api/chatgpt/login', requireLocalOrigin, async (req, res) => {
  const body = z.object({ newAccount: z.boolean().optional(), reconsent: z.boolean().optional() }).strict().parse(req.body ?? {});
  try {
    clearChatgptCatalog();
    return res.json(await chatgptAuth.startLogin(body));
  } catch (err) {
    return chatgptFailure(res, err);
  }
});

app.post('/api/chatgpt/login/cancel', requireLocalOrigin, (_req, res) => {
  chatgptAuth.cancelLogin();
  res.json({ ok: true });
});

app.post('/api/chatgpt/logout', requireLocalOrigin, async (_req, res) => {
  try {
    const { revoked } = await chatgptAuth.signOut();
    clearChatgptCatalog();
    reconcileActiveProvider();
    return res.json({ ok: true, revoked });
  } catch (err) {
    return chatgptFailure(res, err);
  }
});

app.post('/api/chatgpt/account', requireLocalOrigin, async (req, res) => {
  const body = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).strict().parse(req.body ?? {});
  try {
    await chatgptAuth.selectAccount(body.id);
    clearChatgptCatalog();
    return res.json({ ok: true });
  } catch (err) {
    return chatgptFailure(res, err);
  }
});

app.get('/api/status', async (_req, res) => {
  const providers = getAvailableProviders();
  const cfg = getActiveConfig();
  let capabilities = null;
  if (isConfigured()) {
    try {
      let p = await getModelProfile(cfg.PROVIDER, cfg.MODEL);
      if (cfg.PROVIDER === 'chatgpt' && cfg.MODEL && p.source !== 'catalog') {
        try {
          await listChatgptModels();
          p = await getModelProfile(cfg.PROVIDER, cfg.MODEL);
        } catch { /* conservar las capacidades conocidas si falla el catálogo */ }
      }
      capabilities = {
        contextLength: p.contextLength,
        maxOutput: p.maxOutput,
        tools: p.tools,
        vision: p.vision,
        reasoning: p.reasoning,
        reasoningLevels: p.reasoningLevels ?? [],
        defaultReasoningLevel: p.defaultReasoningLevel ?? null,
      };
    } catch { /* sin capacidades conocidas */ }
  }
  res.json({
    ok: true,
    configured: isConfigured(),
    provider: cfg.LABEL,
    model: cfg.MODEL,
    providerId: getActiveProvider(),
    availableProviders: providers,
    openrouterConfigured: providers.openrouter?.configured ?? false,
    nvidiaConfigured: providers.nvidia?.configured ?? false,
    chatgptConfigured: providers.chatgpt?.configured ?? false,
    capabilities,
  });
});

app.post('/api/setup', async (req, res) => {
  const body = z.object({
    apiKey: z.string().min(10, 'API key demasiado corta'),
    model: z.string().optional(),
    provider: KEY_PROVIDER_ENUM.optional(),
  }).parse(req.body ?? {});
  await updateApiConfig({ apiKey: body.apiKey.trim(), model: body.model, provider: body.provider });
  if (body.provider) setProvider(body.provider);
  res.json({ ok: true, configured: true });
});

app.patch('/api/model', async (req, res) => {
  const body = z.object({
    model: z.string().min(1, 'Modelo requerido'),
    provider: PROVIDER_ENUM.optional(),
  }).parse(req.body ?? {});
  await updateApiConfig({ model: body.model, provider: body.provider });
  res.json({ ok: true, model: body.model });
});

/* ==========================================================
   Proyectos, archivos y áreas
   ========================================================== */

app.get('/api/projects', async (_req, res) => {
  await ensureRoot();
  const dir = path.join(getStorageRoot(), 'users', USER_ID, 'projects');
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  res.json({ projects: entries.filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => ({ id: e.name })) });
});

app.post('/api/projects', async (req, res) => {
  const body = z.object({ name: z.string().min(1).max(80).optional() }).parse(req.body ?? {});
  const id = nanoid(10);
  const root = projectRoot({ userId: USER_ID, projectId: id });
  await ensureProjectScaffold(root);
  if (body.name) await writeTextFile(root, 'info/name.txt', body.name);
  res.json({ id });
});

app.get('/api/projects/:id/tree', async (req, res) => {
  const root = await projectFor(req);
  const areaId = String(req.query.areaId ?? '');
  const relPath = String(req.query.path ?? '');
  if (areaId) {
    if (!isValidId(areaId)) return res.status(400).json({ error: 'areaId inválido' });
    const { areas } = await loadAreasConfig(root);
    if (!areaExists(areas, areaId)) return res.status(404).json({ error: 'area not found' });
  }
  const dir = areaId ? (relPath ? `ai/layer2/areas/${areaId}/${relPath}` : `ai/layer2/areas/${areaId}`) : relPath;
  return res.json({ entries: await listDir(root, dir) });
});

app.get('/api/projects/:id/file', async (req, res) => {
  const root = await projectFor(req);
  res.json({ content: await readTextFile(root, String(req.query.path ?? '')) });
});

app.post('/api/projects/:id/file', async (req, res) => {
  const body = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body ?? {});
  const root = await projectFor(req);
  await writeTextFile(root, body.path, body.content);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/file', async (req, res) => {
  const body = z.object({ path: z.string().min(1) }).parse(req.body ?? {});
  const root = await projectFor(req);
  await deletePath(root, body.path);
  res.json({ ok: true });
});

const areaSchema = z.object({
  areas: z.array(z.object({
    id: idSchema,
    name: z.string().min(1).max(120),
    pinned: z.boolean().optional(),
    chats: z.array(z.object({ id: idSchema, name: z.string().min(1).max(120), pinned: z.boolean().optional() })),
    activeChatId: z.string().min(1),
  })),
  activeAreaId: z.string().min(1),
});

app.get('/api/projects/:id/areas', async (req, res) => {
  const root = await projectFor(req);
  res.json(JSON.parse(await readTextFile(root, 'info/areas.json')));
});

app.put('/api/projects/:id/areas', async (req, res) => {
  const body = areaSchema.parse(req.body ?? {});
  const root = projectRoot({ userId: USER_ID, projectId: req.params.id });
  await ensureProjectScaffold(root);
  await writeTextFile(root, 'info/areas.json', JSON.stringify(body, null, 2));
  await ensureProjectScaffold(root);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/chat', async (req, res) => {
  const body = z.object({ areaId: idSchema, chatId: idSchema }).parse(req.body ?? {});
  const root = await projectFor(req);
  const { parsed: cfg, areas } = await loadAreasConfig(root);
  cfg.areas = areas.map((a) => {
    if (a.id !== body.areaId) return a;
    const chats = (a.chats ?? []).filter((c) => c.id !== body.chatId);
    return { ...a, chats, activeChatId: a.activeChatId === body.chatId ? (chats[0]?.id ?? 'c1') : a.activeChatId };
  });
  await writeTextFile(root, 'info/areas.json', JSON.stringify(cfg, null, 2));
  await deletePath(root, `chat/areas/${body.areaId}/${body.chatId}.jsonl`);
  await deletePath(root, `chat/areas/${body.areaId}/${body.chatId}.summary.json`);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/area', async (req, res) => {
  const body = z.object({ areaId: idSchema }).parse(req.body ?? {});
  const root = await projectFor(req);
  const { parsed: cfg, areas } = await loadAreasConfig(root);
  const next = areas.filter((a) => a.id !== body.areaId);
  cfg.areas = next;
  cfg.activeAreaId = cfg.activeAreaId === body.areaId ? (next[0]?.id ?? 'a1') : cfg.activeAreaId;
  await writeTextFile(root, 'info/areas.json', JSON.stringify(cfg, null, 2));
  await deletePath(root, `chat/areas/${body.areaId}`);
  await deletePath(root, `ai/layer2/areas/${body.areaId}`);
  res.json({ ok: true });
});

app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const relDir = allowedUploadDir(req.body?.path);
  if (!relDir) return res.status(400).json({ error: 'Carpeta de destino no permitida' });
  const root = await projectFor(req);
  const saved = await saveUploadedFile(root, relDir, req.file.originalname, req.file.buffer, req.file.mimetype);
  return res.json({ ok: true, path: saved.path, name: saved.name });
});

app.get('/api/projects/:id/download', async (req, res) => {
  const relPath = String(req.query.path ?? '');
  if (!relPath) return res.status(400).json({ error: 'path required' });
  const root = await projectFor(req);
  const abs = safeJoin(root, relPath);
  await fs.access(abs);
  return res.download(abs, path.basename(abs));
});

app.get('/api/projects/:id/preview', async (req, res) => {
  const relPath = String(req.query.path ?? '');
  if (!isPreviewablePath(relPath)) return res.status(403).json({ error: 'Vista previa no disponible para esta ruta' });
  const root = await projectFor(req);
  const abs = safeJoin(root, relPath);
  await fs.access(abs);
  return res.json(await buildPreview(abs));
});

app.get('/api/projects/:id/generated', async (req, res) => {
  const areaId = String(req.query.areaId ?? '');
  if (!isValidId(areaId)) return res.status(400).json({ error: 'areaId inválido' });
  const root = await projectFor(req);
  return res.json({ files: await listGeneratedFiles(root, { areaId, limit: 100 }) });
});

/* ==========================================================
   Generación manual e historial de archivos
   ========================================================== */

app.post('/api/projects/:id/generate', async (req, res) => {
  const body = z.object({
    type: z.enum(['xlsx', 'docx', 'pptx']),
    data: z.any().optional(),
    filename: z.string().min(1).max(120).optional(),
    areaId: idSchema,
    chatId: idSchema,
    editPath: z.string().optional(),
    editChanges: z.any().optional(),
  }).parse(req.body ?? {});
  const root = await projectFor(req);
  const outputDir = path.join(root, 'files', 'generated');
  try {
    let result;
    if (body.editPath && body.editChanges) {
      if (detectFileType(body.editPath) !== body.type) {
        return res.status(400).json({ error: 'editPath type does not match type parameter' });
      }
      result = await editFile({ type: body.type, inputPath: safeJoin(root, body.editPath), outputDir, changes: body.editChanges, filename: body.filename });
    } else {
      if (!body.data) return res.status(400).json({ error: 'data is required for generation' });
      result = await generateFile({ type: body.type, outputDir, data: body.data, filename: body.filename, source: { areaId: body.areaId, chatId: body.chatId } });
    }
    const relPath = path.relative(root, result.filePath).split(path.sep).join(path.posix.sep);
    const file = { path: relPath, filename: result.filename, type: body.type };
    await appendJsonl(safeJoin(root, `chat/areas/${body.areaId}/${body.chatId}.jsonl`), {
      id: nanoid(12), ts: Date.now(), role: 'system', type: 'file_generated', content: `Archivo generado: ${result.filename}`, file, areaId: body.areaId,
    });
    return res.json({ ok: true, file });
  } catch (e) {
    const status = e.kind === 'schema_error' ? 422 : 500;
    return res.status(status).json({ error: `Generation failed: ${e?.detail ?? e?.message ?? String(e)}` });
  }
});

app.post('/api/projects/:id/add-to-history', async (req, res) => {
  const body = z.object({
    filePath: z.string().min(1),
    areaId: idSchema,
    filename: z.string().min(1).max(120).optional(),
    summary: z.string().max(500).optional(),
  }).parse(req.body ?? {});
  const root = await projectFor(req);
  const srcAbs = safeJoin(root, body.filePath);
  await fs.access(srcAbs);
  const destDirRel = `history/areas/${body.areaId}/files`;
  const destDir = safeJoin(root, destDirRel);
  await fs.mkdir(destDir, { recursive: true });
  const clean = sanitizeName(body.filename ?? path.basename(body.filePath));
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let destName = clean;
  for (let n = 2; ; n += 1) {
    try {
      await fs.copyFile(srcAbs, path.join(destDir, destName), fs.constants.COPYFILE_EXCL);
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST' || n > 500) throw e;
      destName = `${stem}-${n}${ext}`;
    }
  }
  const destRel = `${destDirRel}/${destName}`;
  if (body.summary) {
    await fs.writeFile(path.join(destDir, `${destName}.meta.json`), JSON.stringify({
      summary: body.summary, type: ext.slice(1).toLowerCase(), generatedAt: new Date().toISOString(), source: body.filePath,
    }), 'utf8');
  }
  await appendJsonl(path.join(root, 'chat', 'history.jsonl'), {
    ts: Date.now(), action: 'add_to_history', from: body.filePath, to: destRel, areaId: body.areaId, filename: destName, summary: body.summary ?? null,
  });
  return res.json({ ok: true, historyPath: destRel });
});

app.get('/api/projects/:id/generated-history', async (req, res) => {
  const areaId = String(req.query.areaId ?? '');
  if (!isValidId(areaId)) return res.status(400).json({ error: 'areaId required' });
  const root = await projectFor(req);
  const absDir = safeJoin(root, `history/areas/${areaId}/files`);
  try {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const groups = {};
    for (const entry of dirents.filter((e) => e.isFile() && !e.name.endsWith('.meta.json'))) {
      const abs = path.join(absDir, entry.name);
      const mtime = (await fs.stat(abs)).mtime;
      const day = new Date(mtime.getFullYear(), mtime.getMonth(), mtime.getDate());
      const days = Math.floor((todayStart - day) / 86_400_000);
      const date = days === 0 ? 'Hoy' : days === 1 ? 'Ayer' : `${String(mtime.getDate()).padStart(2, '0')}/${String(mtime.getMonth() + 1).padStart(2, '0')}`;
      let summary = '';
      try {
        summary = JSON.parse(await fs.readFile(`${abs}.meta.json`, 'utf8')).summary || '';
      } catch { /* sin resumen */ }
      const key = day.toISOString().slice(0, 10);
      groups[key] ??= { date, days, items: [] };
      groups[key].items.push({
        title: entry.name,
        time: `${String(mtime.getHours()).padStart(2, '0')}:${String(mtime.getMinutes()).padStart(2, '0')}`,
        meta: path.extname(entry.name).slice(1).toUpperCase() || 'FILE',
        path: `history/areas/${areaId}/files/${entry.name}`,
        ...(summary ? { summary } : {}),
      });
    }
    return res.json(Object.values(groups).sort((a, b) => a.days - b.days));
  } catch {
    return res.json([]);
  }
});

/* ==========================================================
   Reglas y tareas
   ========================================================== */

app.get('/api/projects/:id/rules', async (req, res) => {
  const root = await projectFor(req);
  const areaId = String(req.query.areaId ?? '');
  if (areaId) {
    if (!isValidId(areaId)) return res.status(400).json({ error: 'areaId inválido' });
    const { areas } = await loadAreasConfig(root);
    if (!areaExists(areas, areaId)) return res.status(404).json({ error: 'area not found' });
  }
  const relPath = areaId ? `ai/layer2/areas/${areaId}/${AREA_RULES_FILE}` : 'rules.md';
  return res.json({ content: await readOptional(root, relPath) });
});

app.put('/api/projects/:id/rules', async (req, res) => {
  const body = z.object({ markdown: z.string().max(200_000), areaId: idSchema.optional() }).parse(req.body ?? {});
  const root = await projectFor(req);
  if (body.areaId) {
    const { areas } = await loadAreasConfig(root);
    if (!areaExists(areas, body.areaId)) return res.status(404).json({ error: 'area not found' });
  }
  const relPath = body.areaId ? `ai/layer2/areas/${body.areaId}/${AREA_RULES_FILE}` : 'rules.md';
  await writeTextFile(root, relPath, body.markdown);
  return res.json({ ok: true });
});

app.post('/api/projects/:id/tasks', async (req, res) => {
  const body = z.object({ title: z.string().min(1).max(120), body: z.string().optional() }).parse(req.body ?? {});
  const root = await projectFor(req);
  const safeTitle = body.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');
  const rel = path.posix.join('tasks', 'inbox', `${Date.now()}_${safeTitle || 'task'}.md`);
  await writeTextFile(root, rel, `# ${body.title}\n\n${body.body ?? ''}\n`);
  res.json({ taskPath: rel });
});

app.post('/api/projects/:id/complete', async (req, res) => {
  const body = z.object({ taskPath: z.string().min(1), note: z.string().optional() }).parse(req.body ?? {});
  const root = await projectFor(req);
  if (!body.taskPath.startsWith('tasks/inbox/')) {
    return res.status(400).json({ error: 'taskPath must be under tasks/inbox/' });
  }
  const dest = `tasks/history/${path.posix.basename(body.taskPath)}`;
  await movePath(root, body.taskPath, dest);
  await appendJsonl(path.join(root, 'chat', 'history.jsonl'), { ts: Date.now(), action: 'complete', from: body.taskPath, to: dest, note: body.note ?? null });
  return res.json({ ok: true, movedTo: dest });
});

/* ==========================================================
   Chat
   ========================================================== */

app.get('/api/projects/:id/chatlog', async (req, res) => {
  const areaId = String(req.query.areaId ?? '');
  const chatId = String(req.query.chatId ?? '');
  if (!areaId || !chatId) return res.status(400).json({ error: 'areaId and chatId required' });
  if (!isValidId(areaId) || !isValidId(chatId)) return res.status(400).json({ error: 'ids inválidos' });
  const root = await projectFor(req);
  const { areas } = await loadAreasConfig(root);
  if (!chatExists(areas, areaId, chatId)) return res.status(404).json({ error: 'areaId/chatId not found' });
  try {
    const raw = await readTextFile(root, `chat/areas/${areaId}/${chatId}.jsonl`);
    const entries = raw.split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return res.json({ entries });
  } catch {
    return res.json({ entries: [] });
  }
});

const chatSchema = z.object({
  areaId: idSchema,
  chatId: idSchema,
  message: z.string().max(200_000).optional(),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).optional(),
  regenerate: z.boolean().optional(),
  // Nivel de razonamiento elegido. Ausente = automático (el proveedor usa su valor por defecto).
  reasoningEffort: z.string().regex(/^[\w-]{1,32}$/, 'Nivel de razonamiento inválido').optional(),
});

/**
 * POST /api/projects/:id/chat
 * JSON o multipart (adjuntos en `attachments`). Con `Accept: text/event-stream`
 * responde por SSE con eventos start/status/reasoning/delta/file/done/error;
 * si no, responde JSON {id, content, meta, file, files}.
 */
app.post('/api/projects/:id/chat', aiLimiter, upload.array('attachments', 10), async (req, res) => {
  const raw = req.body ?? {};
  let messages = raw.messages;
  if (typeof messages === 'string') {
    try { messages = JSON.parse(messages); } catch { messages = undefined; }
  }
  const parsed = chatSchema.safeParse({
    areaId: raw.areaId,
    chatId: raw.chatId,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    messages,
    regenerate: raw.regenerate === true || raw.regenerate === 'true',
    reasoningEffort: raw.reasoningEffort,
  });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  const body = parsed.data;
  const userText = body.message ?? [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  const uploads = Array.isArray(req.files) ? req.files : [];
  if (!body.regenerate && !userText.trim() && !uploads.length) {
    return res.status(400).json({ error: 'El mensaje está vacío' });
  }

  const root = await projectFor(req);
  const { areas } = await loadAreasConfig(root);
  if (!chatExists(areas, body.areaId, body.chatId)) {
    return res.status(404).json({ error: 'areaId/chatId not found' });
  }

  // Se valida antes de responder o abrir el stream: un nivel no admitido es un 400 claro.
  if (body.reasoningEffort !== undefined) {
    const active = getActiveConfig();
    try {
      await resolveReasoningEffort(active.PROVIDER, active.MODEL, body.reasoningEffort);
    } catch (err) {
      const human = humanizeError(err);
      return res.status(err?.kind === 'invalid_reasoning' ? 400 : httpStatusFor(err?.kind)).json({
        error: err?.message ?? 'Nivel de razonamiento inválido',
        kind: err?.kind ?? 'unknown',
        retriable: human.retriable,
        allowed: err?.allowed ?? null,
        errorHuman: human,
      });
    }
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const args = {
    root,
    areaId: body.areaId,
    chatId: body.chatId,
    areas,
    userText,
    uploads,
    regenerate: !!body.regenerate,
    reasoningEffort: body.reasoningEffort,
    signal: controller.signal,
  };

  if (String(req.get('accept') ?? '').includes('text/event-stream')) {
    const sse = createSse(res);
    let errorSent = false;
    try {
      await runChat({
        ...args,
        emit: (event, data) => {
          if (event === 'error') errorSent = true;
          sse.send(event, data);
        },
      });
    } catch (err) {
      if (!errorSent && err?.kind !== 'aborted') {
        const human = humanizeError(err);
        sse.send('error', { error: human, kind: err?.kind ?? 'unknown', retriable: human.retriable });
      }
    } finally {
      sse.close();
    }
    return undefined;
  }

  try {
    const record = await runChat(args);
    return res.json({ id: record.id, content: record.content, meta: record.meta ?? null, file: record.file ?? null, files: record.files ?? [] });
  } catch (err) {
    if (res.headersSent || err?.kind === 'aborted') return undefined;
    const human = humanizeError(err);
    return res.status(httpStatusFor(err?.kind)).json({
      error: err?.message ?? 'Error comunicándose con la IA',
      kind: err?.kind ?? 'unknown',
      retriable: human.retriable,
      retryAfter: err?.retryAfter ?? null,
      provider: err?.provider ?? null,
      upstreamStatus: err?.status ?? null,
      errorHuman: human,
    });
  }
});

/* ==========================================================
   Errores
   ========================================================== */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Datos inválidos', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  if (err?.message === 'Invalid path') return res.status(400).json({ error: 'Ruta inválida' });
  if (err?.code === 'ENOENT') return res.status(404).json({ error: 'No encontrado' });
  if (err?.code === 'LIMIT_FILE_SIZE' || err?.type === 'entity.too.large') return res.status(413).json({ error: 'Archivo demasiado grande' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'JSON inválido' });
  console.error('[API]', err);
  return res.status(500).json({ error: 'Error interno' });
});

/* ==========================================================
   Inicio
   ========================================================== */

await ensureRoot();

const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});

export { app, server, readContextFile, listAllContextFiles, CONTEXT_EXTS, parseStructuredResponse, normalizeFileGenerated };
