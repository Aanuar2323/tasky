/**
 * context/extract.js — Texto plano de archivos de contexto y adjuntos.
 *
 * Formatos: texto/código (utf-8), PDF (pdfjs-dist), DOCX (mammoth),
 * PPTX (jszip + <a:t>), XLSX (xlsx-reader). Resultado cacheado por ruta +
 * mtime + tamaño (LRU) para no re-parsear PDFs en cada mensaje.
 */

import fs from 'node:fs/promises';
import { decodeXmlEntities } from './xml.js';
import { readXlsx } from './xlsx-reader.js';

export { decodeXmlEntities };

/** Extensiones que la IA puede usar como contexto. */
export const CONTEXT_EXTS = /\.(md|markdown|txt|json|jsonl|csv|tsv|xml|yaml|yml|pdf|docx|pptx|ppt|xlsx|xls|xlsm|html|htm|css|js|mjs|ts|jsx|tsx|py|java|go|rs|c|cpp|h|hpp|cs|php|rb|kt|swift|sh|bash|sql|ini|toml|env|log|rtf)$/i;

const TEXT_EXTS = /\.(md|markdown|txt|json|jsonl|csv|tsv|xml|yaml|yml|html|htm|css|js|mjs|ts|jsx|tsx|py|java|go|rs|c|cpp|h|hpp|cs|php|rb|kt|swift|sh|bash|sql|ini|toml|env|log|rtf)$/i;
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const MAX_XLSX_ROWS = 1000;
const CACHE_MAX_ENTRIES = 128;
const CACHE_MAX_ITEM_CHARS = 5_000_000;

const cache = new Map();
const stats = { hits: 0, misses: 0 };

/** 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text' | 'image' | 'binary' */
export function kindOf(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx')) return 'docx';
  if (n.endsWith('.pptx') || n.endsWith('.ppt')) return 'pptx';
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.xlsm')) return 'xlsx';
  if (TEXT_EXTS.test(n)) return 'text';
  if (IMAGE_EXTS.test(n)) return 'image';
  return 'binary';
}


function tidy(text) {
  return String(text ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const pages = [];
  const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= n; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const parts = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        parts.push(line);
        line = '';
      } else if (item.str && !item.str.endsWith(' ')) {
        line += ' ';
      }
    }
    if (line) parts.push(line);
    pages.push(parts.join('\n'));
  }
  return { text: tidy(pages.join('\n\n')), pages: pdf.numPages };
}

async function docxText(buf) {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.default.extractRawText({ buffer: buf });
  return tidy(value);
}

const CHROME_NAMES = /^Tasky (?:pie|número de diapositiva)$/;

function isSlideChrome(shapeXml) {
  if (/<p:ph\b[^>]*\btype="(?:sldNum|dt|ftr)"/.test(shapeXml)) return true;
  const name = shapeXml.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1] ?? '';
  return CHROME_NAMES.test(decodeXmlEntities(name));
}

async function pptxText(buf) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const chunks = [];
  for (const sp of slideFiles) {
    // Pie, fecha y número de diapositiva no son contenido.
    const xml = (await zip.files[sp].async('string')).replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shape) => (isSlideChrome(shape) ? '' : shape));
    const paragraphs = xml.split(/<\/a:p>/).map((pXml) => {
      const texts = [];
      const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
      let m;
      while ((m = re.exec(pXml)) !== null) texts.push(decodeXmlEntities(m[1]));
      return texts.join('').trim();
    }).filter(Boolean);
    chunks.push(`[Slide ${sp.match(/(\d+)\.xml$/)[1]}]\n${paragraphs.join('\n')}`);
  }
  return tidy(chunks.join('\n\n'));
}

async function xlsxText(buf) {
  const { sheets } = await readXlsx(buf, { maxRows: MAX_XLSX_ROWS });
  return tidy(sheets.map((sheet) => {
    const lines = [`[Hoja: ${sheet.name}]`, ...sheet.rows.map((r) => r.join('\t'))];
    if (sheet.totalRows > sheet.rows.length) lines.push(`… (${sheet.totalRows - sheet.rows.length} filas más)`);
    return lines.join('\n');
  }).join('\n\n'));
}

/**
 * Texto de un buffer según el nombre de archivo. Nunca lanza: '' si no se puede.
 */
export async function extractTextFromBuffer(buf, name) {
  try {
    switch (kindOf(name)) {
      case 'pdf':
        return (await pdfText(buf)).text;
      case 'docx':
        return await docxText(buf);
      case 'pptx':
        return await pptxText(buf);
      case 'xlsx':
        return await xlsxText(buf);
      case 'text':
        return buf.subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/^﻿/, '');
      default:
        return '';
    }
  } catch (e) {
    console.warn(`[extract] ${name}: ${e?.message ?? e}`);
    return '';
  }
}

/** Info de un PDF (texto + páginas) para adjuntos. */
export async function extractPdf(buf) {
  return pdfText(buf);
}

/**
 * Texto de un archivo en disco, cacheado por mtime + tamaño.
 */
export async function extractText(absPath) {
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    return '';
  }
  if (!st.isFile()) return '';
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    stats.hits += 1;
    cache.delete(absPath);
    cache.set(absPath, hit);
    return hit.text;
  }
  stats.misses += 1;
  let text = '';
  try {
    text = await extractTextFromBuffer(await fs.readFile(absPath), absPath);
  } catch {
    text = '';
  }
  if (text.length <= CACHE_MAX_ITEM_CHARS) {
    cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text });
    while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }
  return text;
}

export function extractStats() {
  return { ...stats, entries: cache.size };
}
