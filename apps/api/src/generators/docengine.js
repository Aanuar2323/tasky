/**
 * docengine.js — Cliente del CLI Python (apps/api/docengine/cli.py).
 *
 * Node lanza el CLI por proceso: escribe el payload JSON en stdin y recoge el
 * binario por stdout. El CLI normaliza (normalize.py), valida con pydantic y
 * construye el archivo con python-docx / openpyxl / python-pptx.
 *
 * Garantías de este módulo:
 *  - El nombre de archivo nunca escapa de outputDir (sanitizeFilename).
 *  - Nunca pisa un archivo existente salvo `overwrite: true` (nombre versionado
 *    `informe-v2.docx`, escritura exclusiva para evitar carreras).
 *  - Guarda la fuente (`data`) en `.tasky/<archivo>.json` para poder leerla y
 *    regenerar versiones desde el chat.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', '..', 'docengine', 'cli.py');
const TIMEOUT_MS = Number(process.env.DOCENGINE_TIMEOUT_MS ?? 90_000);
const SIDECAR_DIR = '.tasky';
const MAX_NAME = 120;

const EXTENSIONS = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};

// Caracteres reservados en Windows/macOS/Linux + controles.
// eslint-disable-next-line no-control-regex
const RESERVED = /[<>:"|?*\u0000-\u001F\u007F]/g;

/**
 * Nombre de archivo seguro: sin directorios, sin caracteres reservados,
 * con la extensión del tipo y ≤ 120 caracteres.
 * @param {string|undefined|null} name
 * @param {string} type
 */
export function sanitizeFilename(name, type) {
  const ext = EXTENSIONS[type] ?? String(type || 'bin');
  let base = String(name ?? '').replace(/\\/g, '/');
  base = base.split('/').pop() ?? '';
  base = base.replace(RESERVED, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base || /^[._\s-]*$/.test(base)) return `${type}-${nanoid(8)}.${ext}`;
  if (!base.toLowerCase().endsWith(`.${ext}`)) base = `${base}.${ext}`;
  if (base.length > MAX_NAME) {
    const stem = base.slice(0, base.length - ext.length - 1);
    base = `${stem.slice(0, MAX_NAME - ext.length - 1).replace(/[.\s]+$/, '')}.${ext}`;
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = `_${base}`;
  return base;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function nextVersionName(filename, bump) {
  const ext = path.extname(filename);
  let stem = filename.slice(0, filename.length - ext.length);
  let n = 2;
  const m = stem.match(/^(.*)-v(\d+)$/);
  if (m) {
    stem = m[1];
    n = Number(m[2]) + 1;
  }
  return `${stem}-v${n + bump}${ext}`;
}

/**
 * Escribe `buf` con un nombre libre dentro de dir (o pisa si overwrite).
 * @returns {Promise<string>} nombre final
 */
async function writeUnique(dir, filename, buf, overwrite) {
  if (overwrite) {
    await fs.writeFile(path.join(dir, filename), buf);
    return filename;
  }
  let candidate = filename;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.writeFile(path.join(dir, candidate), buf, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      candidate = nextVersionName(filename, attempt);
      while (await exists(path.join(dir, candidate))) {
        attempt += 1;
        candidate = nextVersionName(filename, attempt);
      }
    }
  }
  throw new Error(`No se encontró un nombre libre para ${filename}`);
}

function pythonEnv() {
  const extra = process.env.PYTHONPATH
    ? process.env.PYTHONPATH
    : path.resolve(__dirname, '..', '..', 'docengine');
  return {
    ...process.env,
    PYTHONPATH: extra,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

function lastJsonLine(text) {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') return obj;
    } catch { /* línea no JSON (warnings de librerías) */ }
  }
  return null;
}

/**
 * Invoca el CLI y devuelve { stdout, info } (info = última línea JSON de stderr).
 * Lanza Error con .kind/.exitCode/.detail si falla.
 */
function runCli(action, fmt, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', [CLI_PATH, action, fmt], {
      env: pythonEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ya terminó */ }
      const err = new Error(`docengine ${action}/${fmt} timeout after ${TIMEOUT_MS}ms`);
      err.kind = 'timeout';
      reject(err);
    }, TIMEOUT_MS);

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error(`docengine spawn failed: ${e.message}`);
      err.kind = e.code === 'ENOENT' ? 'python_missing' : 'spawn_error';
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const info = lastJsonLine(stderrBuf);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks), info: info ?? {} });
        return;
      }
      const errorName = info?.error || `exit_${code}`;
      const detail = String(info?.detail ?? stderrBuf.trim()).slice(0, 700);
      const err = new Error(`docengine ${action}/${fmt} → ${code} ${errorName}: ${detail.slice(0, 400)}`);
      err.kind = code === 4 ? (errorName === 'edit_error' ? 'edit_error' : 'schema_error') : 'docengine_error';
      err.exitCode = code;
      err.errorName = errorName;
      err.detail = detail;
      reject(err);
    });

    child.stdin.on('error', () => { /* el proceso puede cerrar stdin antes (errores de uso) */ });
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}

/**
 * Genera un archivo y lo escribe en outputDir.
 * @param {{type:'docx'|'xlsx'|'pptx', outputDir:string, data:object, filename?:string,
 *          source?:{summary?:string, areaId?:string, chatId?:string}, overwrite?:boolean}} args
 * @returns {Promise<{filePath:string, filename:string, fixes:string[]}>}
 */
export async function generateFile({ type, outputDir, data, filename, source, overwrite = false }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeName = sanitizeFilename(filename, type);
  const { stdout, info } = await runCli('generate', type, data ?? {});
  const finalName = await writeUnique(outputDir, safeName, stdout, overwrite);
  await writeSourceSidecar(outputDir, finalName, {
    type,
    filename: finalName,
    summary: source?.summary ?? null,
    areaId: source?.areaId ?? null,
    chatId: source?.chatId ?? null,
    createdAt: new Date().toISOString(),
    data: data ?? {},
  }).catch(() => { /* el sidecar es opcional */ });
  return { filePath: path.join(outputDir, finalName), filename: finalName, fixes: Array.isArray(info.fixes) ? info.fixes : [] };
}

/**
 * Edita un archivo existente (plantillas, reemplazos, celdas, anexos) y escribe
 * el resultado con nombre nuevo (nunca pisa el original salvo overwrite).
 * @returns {Promise<{filePath:string, filename:string, stats:object}>}
 */
export async function editFile({ type, inputPath, outputDir, changes, filename, overwrite = false }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeName = sanitizeFilename(filename || path.basename(inputPath), type);
  const raw = await fs.readFile(inputPath);
  const { stdout, info } = await runCli('edit', type, { file_base64: raw.toString('base64'), changes: changes ?? {} });
  const finalName = await writeUnique(outputDir, safeName, stdout, overwrite);
  return { filePath: path.join(outputDir, finalName), filename: finalName, stats: info.stats ?? {} };
}

export async function writeSourceSidecar(outputDir, filename, sidecar) {
  const dir = path.join(outputDir, SIDECAR_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sanitizeFilename(filename, path.extname(filename).slice(1) || 'bin')}.json`), JSON.stringify(sidecar), 'utf8');
}

/**
 * Lee la fuente guardada de un archivo generado. null si no existe o está corrupta.
 */
export async function readSourceSidecar(outputDir, filename) {
  try {
    const safe = sanitizeFilename(filename, path.extname(filename).slice(1) || 'bin');
    const raw = await fs.readFile(path.join(outputDir, SIDECAR_DIR, `${safe}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Detecta el tipo de archivo por extensión.
 */
export function detectFileType(filename) {
  if (!filename) return null;
  const ext = String(filename).split('.').pop().toLowerCase();
  return ext in EXTENSIONS ? ext : null;
}

export { SIDECAR_DIR };
