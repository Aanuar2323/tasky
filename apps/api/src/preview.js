/**
 * preview.js — Vista previa liviana de archivos del proyecto para la UI.
 *
 *   docx → markdown (mammoth, sin imágenes)
 *   xlsx → hojas con filas (primeras 200 × 30)
 *   pptx → diapositivas con título y líneas
 *   pdf/texto → texto; .md → markdown; imágenes → la UI usa /download
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AREA_RULES_FILE, AREA_SUMMARY_FILE } from './storage.js';
import { extractText, extractTextFromBuffer, kindOf } from './context/extract.js';
import { readXlsx } from './context/xlsx-reader.js';
import { htmlToMarkdown } from './context/html-md.js';

const MAX_MARKDOWN = 200_000;
const MAX_ROWS = 200;
const MAX_COLS = 30;
const MAX_SHEETS = 8;

/** Rutas que la UI puede previsualizar (no internas). */
export function isPreviewablePath(rel) {
  const p = path.posix.normalize(String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, ''));
  if (!p || p.startsWith('..') || path.posix.isAbsolute(p)) return false;
  if (p.split('/').some((seg) => seg.startsWith('.'))) return false;
  const base = path.posix.basename(p);
  if (base === AREA_RULES_FILE || base === AREA_SUMMARY_FILE) return false;
  return p.startsWith('files/') || p.startsWith('ai/layer2/areas/') || p.startsWith('history/areas/');
}

async function xlsxPreview(buf) {
  const { sheets } = await readXlsx(buf, { maxRows: MAX_ROWS, maxCols: MAX_COLS, display: true });
  return {
    kind: 'sheets',
    sheets: sheets.slice(0, MAX_SHEETS).map((sheet) => {
      const width = Math.max(0, ...sheet.rows.map((r) => r.length));
      return {
        name: sheet.name,
        rows: sheet.rows.map((r) => [...r, ...Array(width - r.length).fill('')]),
        totalRows: sheet.totalRows,
        truncated: sheet.totalRows > sheet.rows.length,
      };
    }),
  };
}

// El título y el subtítulo del documento se ven como encabezados, no como texto suelto.
const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Título'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Subtítulo'] => h2:fresh",
];

async function docxPreview(buf) {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml(
    { buffer: buf },
    { styleMap: DOCX_STYLE_MAP, convertImage: mammoth.images.imgElement(() => ({ src: '' })) }
  );
  const markdown = htmlToMarkdown(value).replace(/\n{3,}/g, '\n\n').trim();
  return { kind: 'markdown', markdown: markdown.slice(0, MAX_MARKDOWN), truncated: markdown.length > MAX_MARKDOWN };
}

async function pptxPreview(buf) {
  const text = await extractTextFromBuffer(buf, 'x.pptx');
  const slides = text.split(/\n\n(?=\[Slide \d+\])/).map((chunk) => {
    const lines = chunk.split('\n');
    const index = Number(lines[0]?.match(/\[Slide (\d+)\]/)?.[1] ?? 0);
    const body = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    return { index, title: body[0] ?? '', lines: body.slice(1) };
  }).filter((s) => s.index);
  return { kind: 'slides', slides };
}

/**
 * @param {string} absPath
 * @returns {Promise<object>} {kind: 'markdown'|'sheets'|'slides'|'text'|'image'|'none', ...}
 */
export async function buildPreview(absPath) {
  const name = path.basename(absPath);
  const kind = kindOf(name);
  if (kind === 'image') return { kind: 'image' };
  if (kind === 'binary') return { kind: 'none' };
  if (kind === 'xlsx' || kind === 'docx' || kind === 'pptx') {
    const buf = await fs.readFile(absPath);
    try {
      if (kind === 'xlsx') return await xlsxPreview(buf);
      if (kind === 'docx') return await docxPreview(buf);
      return await pptxPreview(buf);
    } catch {
      return { kind: 'none' };
    }
  }
  const text = await extractText(absPath);
  if (/\.(md|markdown)$/i.test(name)) return { kind: 'markdown', markdown: text.slice(0, MAX_MARKDOWN), truncated: text.length > MAX_MARKDOWN };
  return { kind: 'text', text: text.slice(0, MAX_MARKDOWN), truncated: text.length > MAX_MARKDOWN };
}
