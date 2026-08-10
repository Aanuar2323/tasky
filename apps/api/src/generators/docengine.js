/**
 * docengine.js — Cliente del CLI Python (apps/api/docengine/cli.py).
 *
 * Node lanza el CLI por proceso: escribe el payload JSON en stdin y
 * recoge el binario por stdout. El CLI valida con pydantic (schemas/*.py)
 * y construye el archivo con python-docx / openpyxl / python-pptx.
 *
 * Misma firma pública que antes { generateFile, editFile, detectFileType }
 * para que src/index.js no cambie.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', '..', 'docengine', 'cli.py');
const TIMEOUT_MS = 60_000;

const EXTENSIONS = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};

function safeFilename(type, filename) {
  const ext = EXTENSIONS[type] ?? type;
  if (!filename) return `${type}-${nanoid(8)}.${ext}`;
  return filename.toLowerCase().endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
}

function pythonEnv() {
  const extra = process.env.PYTHONPATH
    ? process.env.PYTHONPATH
    : path.resolve(__dirname, '..', '..', 'docengine');
  return {
    ...process.env,
    PYTHONPATH: extra,
    PYTHONUNBUFFERED: '1',
  };
}

/**
 * Invoca el CLI y devuelve el binario por stdout.
 * Lanza Error con .kind si falla.
 * @param {string} action - 'generate' | 'edit'
 * @param {string} fmt - 'docx' | 'xlsx' | 'pptx'
 * @param {object} payload - JSON a enviar por stdin
 * @returns {Promise<Buffer>}
 */
function runCli(action, fmt, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [CLI_PATH, action, fmt], {
      env: pythonEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
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
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      let detail = stderrBuf.trim();
      let errorName = `exit_${code}`;
      try {
        const parsed = JSON.parse(detail);
        errorName = parsed.error || errorName;
        detail = parsed.detail || detail;
      } catch {}
      const err = new Error(`docengine ${action}/${fmt} → ${code}: ${String(detail).slice(0, 400)}`);
      err.kind = code === 4 ? 'schema_error' : 'docengine_error';
      err.exitCode = code;
      reject(err);
    });

    try {
      child.stdin.end(JSON.stringify(payload ?? {}));
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`docengine stdin write failed: ${e.message}`));
      }
    }
  });
}

/**
 * Genera un archivo invocando el CLI Python y escribiéndolo en outputDir.
 * @param {{type:'docx'|'xlsx'|'pptx', outputDir:string, data:object, filename?:string}} args
 * @returns {Promise<{filePath:string, filename:string}>}
 */
export async function generateFile({ type, outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeName = safeFilename(type, filename);
  const buf = await runCli('generate', type, data ?? {});
  const filePath = path.join(outputDir, safeName);
  await fs.writeFile(filePath, buf);
  return { filePath, filename: safeName };
}

/**
 * Edita un archivo existente (file_base64 + changes vía CLI).
 * @param {{type:'docx'|'xlsx'|'pptx', inputPath:string, outputDir:string, changes:object, filename?:string}} args
 * @returns {Promise<{filePath:string, filename:string}>}
 */
export async function editFile({ type, inputPath, outputDir, changes, filename }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeName = safeFilename(type, filename);
  const raw = await fs.readFile(inputPath);
  const fileBase64 = raw.toString('base64');
  const buf = await runCli('edit', type, { file_base64: fileBase64, changes: changes ?? {} });
  const filePath = path.join(outputDir, safeName);
  await fs.writeFile(filePath, buf);
  return { filePath, filename: safeName };
}

/**
 * Detecta el tipo de archivo por extensión.
 */
export function detectFileType(filename) {
  if (!filename) return null;
  const ext = filename.split('.').pop().toLowerCase();
  return ext in EXTENSIONS ? ext : null;
}
