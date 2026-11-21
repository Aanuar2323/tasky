/**
 * context/xlsx-reader.js — Lector XLSX mínimo y tolerante (JSZip + XML).
 *
 * ExcelJS falla al abrir libros con tablas de Excel escritas por openpyxl
 * (relaciones con rutas absolutas), justo los que genera el docengine. Este
 * lector solo necesita workbook, relaciones, sharedStrings, estilos y hojas,
 * y entiende la salida de Excel, LibreOffice, Google Sheets, openpyxl y ExcelJS.
 *
 * Devuelve valores como texto: fechas ISO, porcentajes con %, fórmulas sin
 * valor calculado como "=FÓRMULA". Con `display: true` (vista previa) aplica los
 * formatos numéricos de cada celda al estilo es-AR y calcula fórmulas simples.
 */

import JSZip from 'jszip';
import { decodeXmlEntities } from './xml.js';
import { evaluateFormula } from './formula.js';

const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const BUILTIN_CODES = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;(#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;(#,##0.00)',
};

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = decodeXmlEntities(m[2]);
  return out;
}

function textRuns(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += decodeXmlEntities(m[1] ?? '');
  return out;
}

function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function isDateFormat(id, code) {
  if (DATE_FMT_IDS.has(id)) return true;
  if (!code) return false;
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(c) || (/m/i.test(c) && /[hs]/i.test(c));
}

function formatNumber(value, fmt) {
  if (fmt?.date) {
    const ms = EXCEL_EPOCH_MS + value * 86_400_000;
    const d = new Date(Math.round(ms / 1000) * 1000);
    if (Number.isNaN(d.getTime())) return String(value);
    const iso = d.toISOString();
    return value % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
  }
  if (fmt?.percent) return `${Number((value * 100).toFixed(10))}%`;
  return String(Number(value.toPrecision(15)));
}

/** Texto literal antes y después de la parte numérica de un formato ("$", " USD"). */
function literalParts(section) {
  let prefix = '';
  let suffix = '';
  let seenDigit = false;
  for (const m of section.matchAll(/"([^"]*)"|\\(.)|\[\$([^-\]]*)[^\]]*\]|\[[^\]]*\]|([#0?]+(?:[.,][#0?]+)*)|_.|\*.|([^%@])/g)) {
    const [, quoted, escaped, currency, digits, other] = m;
    if (digits) {
      seenDigit = true;
      continue;
    }
    const lit = quoted ?? escaped ?? currency ?? other ?? '';
    if (seenDigit) suffix += lit;
    else prefix += lit;
  }
  return { prefix: prefix.replace(/^\s+/, ''), suffix: suffix.replace(/\s+$/, '') };
}

function parseFormat(id, code) {
  const full = code || BUILTIN_CODES[id] || '';
  const date = isDateFormat(id, full);
  const section = full.split(';')[0] ?? '';
  const numeric = section.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  const percent = id === 9 || id === 10 || numeric.includes('%');
  return {
    date,
    percent,
    general: !full || full.toLowerCase() === 'general' || full === '@',
    decimals: (numeric.match(/\.([0#?]+)/)?.[1] ?? '').length,
    grouping: /[#0?],[#0?]/.test(numeric),
    ...literalParts(section),
  };
}

const nfCache = new Map();
function esNumber(value, decimals, grouping) {
  const key = `${decimals}:${grouping}`;
  if (!nfCache.has(key)) {
    nfCache.set(key, new Intl.NumberFormat('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping }));
  }
  return nfCache.get(key).format(value);
}

const generalFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 10, useGrouping: false });

/** Número como lo mostraría Excel con configuración regional es-AR. */
function formatDisplay(value, fmt) {
  if (fmt?.date) {
    const ms = EXCEL_EPOCH_MS + value * 86_400_000;
    const d = new Date(Math.round(ms / 1000) * 1000);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    return value % 1 ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
  }
  if (!fmt || fmt.general) return generalFormat.format(Number(value.toPrecision(15)));
  const n = fmt.percent ? value * 100 : value;
  const body = esNumber(Math.abs(n), fmt.decimals, fmt.grouping);
  const sign = n < 0 && Number(body.replace(/\./g, '').replace(',', '.')) !== 0 ? '-' : '';
  return `${sign}${fmt.prefix}${body}${fmt.suffix}${fmt.percent ? '%' : ''}`;
}

function resolveTarget(target) {
  const t = String(target).replace(/\\/g, '/');
  if (t.startsWith('/')) return t.slice(1);
  const parts = `xl/${t}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

async function readStyles(zip) {
  const xml = await zip.file('xl/styles.xml')?.async('string');
  if (!xml) return [];
  const codes = new Map();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    codes.set(Number(a.numFmtId), a.formatCode ?? '');
  }
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  return [...cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => {
    const id = Number(attrs(m[1]).numFmtId ?? 0);
    return parseFormat(id, codes.get(id) ?? '');
  });
}

/** Filas de una hoja: celdas con referencia, tipo y estilo, antes de convertirlas a texto. */
function* sheetRows(xml, shared) {
  let rowNumber = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    rowNumber = ra.r ? Number(ra.r) : rowNumber + 1;
    const cells = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      const inner = cm[2] ?? '';
      const col = ca.r ? colIndex(ca.r) : cells.length;
      const ref = ca.r ? ca.r.replace(/\$/g, '').toUpperCase() : `${colName(col + 1)}${rowNumber}`;
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const f = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      const cell = { col, ref, style: Number(ca.s ?? 0) };
      switch (ca.t) {
        case 's':
          cell.text = shared[Number(v)] ?? '';
          break;
        case 'inlineStr':
          cell.text = textRuns(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
          break;
        case 'str':
        case 'e':
          if (v != null) cell.text = decodeXmlEntities(v);
          else if (f) cell.formula = decodeXmlEntities(f);
          else cell.text = '';
          break;
        case 'b':
          cell.text = v === '1' ? 'TRUE' : 'FALSE';
          break;
        default:
          if (v != null && v !== '') cell.num = Number(v);
          else if (f) cell.formula = decodeXmlEntities(f);
      }
      cells.push(cell);
    }
    yield cells;
  }
}

function colName(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * @param {Buffer} buf
 * @param {{maxRows?:number, maxCols?:number, includeHidden?:boolean, display?:boolean}} [opts]
 *   display: formatea números como Excel en es-AR y calcula fórmulas simples (vista previa).
 * @returns {Promise<{sheets: Array<{name:string, state:string, rows:string[][], totalRows:number}>}>}
 */
export async function readXlsx(buf, { maxRows = 1000, maxCols = 50, includeHidden = false, display = false } = {}) {
  const zip = await JSZip.loadAsync(buf);
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  if (!workbook) throw new Error('xlsx sin workbook.xml');
  const relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const rels = new Map([...relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => {
    const a = attrs(m[1]);
    return [a.Id, resolveTarget(a.Target)];
  }));
  const sharedXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
  const styles = await readStyles(zip);

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const state = a.state ?? 'visible';
    if (state !== 'visible' && !includeHidden) continue;
    const target = rels.get(a['r:id']) ?? `xl/worksheets/sheet${a.sheetId}.xml`;
    const xml = await zip.file(target)?.async('string');
    if (!xml) continue;

    // Solo la vista previa necesita todas las celdas en memoria para calcular fórmulas.
    const allRows = display ? [...sheetRows(xml, shared)] : null;
    const byRef = new Map(allRows ? allRows.flat().map((c) => [c.ref, c]) : []);
    const computed = new Map();
    const visiting = new Set();
    // Valor de una celda para evaluar fórmulas; una fórmula que falla hace fallar a quien la usa.
    const valueOf = (ref) => {
      const c = byRef.get(ref);
      if (!c) return null;
      if (c.num !== undefined) return c.num;
      if (c.formula === undefined) return c.text || null;
      if (!computed.has(ref)) {
        if (visiting.has(ref)) throw new Error('referencia circular');
        visiting.add(ref);
        computed.set(ref, evaluateFormula(c.formula, valueOf));
        visiting.delete(ref);
      }
      const v = computed.get(ref);
      if (v === null) throw new Error('fórmula no soportada');
      return v;
    };
    const render = (c) => {
      const fmt = styles[c.style];
      if (c.num !== undefined) return display ? formatDisplay(c.num, fmt) : formatNumber(c.num, fmt);
      if (c.formula !== undefined) {
        if (display) {
          let v = null;
          try {
            v = valueOf(c.ref);
          } catch {
            v = null;
          }
          if (typeof v === 'number') return formatDisplay(v, fmt);
        }
        return `=${c.formula}`;
      }
      return c.text ?? '';
    };

    const rows = [];
    let totalRows = 0;
    for (const cells of allRows ?? sheetRows(xml, shared)) {
      const out = [];
      for (const c of cells) if (c.col < maxCols) out[c.col] = render(c);
      const row = Array.from({ length: out.length }, (_, i) => out[i] ?? '');
      while (row.length && row[row.length - 1] === '') row.pop();
      if (!row.length) continue;
      totalRows += 1;
      if (rows.length < maxRows) rows.push(row);
    }
    sheets.push({ name: a.name ?? `Hoja ${sheets.length + 1}`, state, rows, totalRows });
  }
  return { sheets };
}
