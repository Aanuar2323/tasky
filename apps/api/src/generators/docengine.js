/**
 * docengine.js — Cliente HTTP del microservicio Python (FastAPI, uvicorn).
 *
 * Toda generación/edición de archivos ocurre en el servicio Python.
 * Node actúa como cliente: envía JSON al endpoint, recibe binario, lo
 * escribe en disco (outputDir) y devuelve { filePath, filename } con el
 * mismo contrato que tenían los builders JS originales (para que
 * src/index.js y storage permanezcan sin cambios).
 *
 * Variables de entorno:
 *   DOC_ENGINE_URL — URL base del servicio (default http://127.0.0.1:8788)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { nanoid } from 'nanoid';

const BASE_URL = process.env.DOC_ENGINE_URL || 'http://127.0.0.1:8788';
const TIMEOUT_MS = 60_000;

const EXTENSIONS = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};

/**
 * Normaliza un nombre de archivo asegurando la extensión correcta.
 */
function safeFilename(type, filename) {
  const ext = EXTENSIONS[type] ?? type;
  if (!filename) return `${type}-${nanoid(8)}.${ext}`;
  return filename.toLowerCase().endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
}

/**
 * POST al servicio con payload JSON. Devuelve Buffer binario del archivo.
 * Lanza Error con .kind si el servicio responde non-2xx.
 */
async function postBinary(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody?.detail ?? JSON.stringify(errBody);
      } catch {
        try { detail = await res.text(); } catch {}
      }
      const err = new Error(`docengine ${endpoint} → ${res.status}: ${detail.slice(0, 400)}`);
      err.status = res.status;
      err.kind = res.status === 422 ? 'schema_error' : 'docengine_error';
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Genera un archivo enviando el JSON al servicio Python y escribiéndolo en outputDir.
 * @param {{type:'docx'|'xlsx'|'pptx', outputDir:string, data:object, filename?:string}} args
 * @returns {Promise<{filePath:string, filename:string}>}
 */
export async function generateFile({ type, outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeName = safeFilename(type, filename);
  const buf = await postBinary(`/api/v1/generate/${type}`, data ?? {});
  const filePath = path.join(outputDir, safeName);
  await fs.writeFile(filePath, buf);
  return { filePath, filename: safeName };
}

/**
 * Edita un archivo existente.
 * @param {{type:'docx'|'xlsx'|'pptx', inputPath:string, outputDir:string, changes:object, filename?:string}} args
 * @returns {Promise<{filePath:string, filename:string}>}
 */
export async function editFile({ type, inputPath, outputDir, changes, filename }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeName = safeFilename(type, filename);
  const raw = await fs.readFile(inputPath);
  const fileBase64 = raw.toString('base64');
  const buf = await postBinary(`/api/v1/edit/${type}`, { file_base64: fileBase64, changes: changes ?? {} });
  const filePath = path.join(outputDir, safeName);
  await fs.writeFile(filePath, buf);
  return { filePath, filename: safeName };
}

/**
 * Lee estructura de un archivo (notificación ligera, el LLM usa el JSON del chatlog).
 */
export async function readFileStructure(type, filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      filename: path.basename(filePath),
      size: stat.size,
      note: `Archivo ${type.toUpperCase()} binario. La IA necesita el JSON original para editarlo. Usa editChanges con file_base64 del archivo actual.`,
    };
  } catch {
    return { note: `No se pudo leer el archivo ${type.toUpperCase()}.` };
  }
}

/**
 * Detecta el tipo de archivo por extensión.
 */
export function detectFileType(filename) {
  if (!filename) return null;
  const ext = filename.split('.').pop().toLowerCase();
  return ext in EXTENSIONS ? ext : null;
}
