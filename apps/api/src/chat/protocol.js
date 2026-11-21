/**
 * chat/protocol.js — Contratos de salida del modelo para archivos.
 *
 *  - Protocolo de texto (modelos sin function calling): respuesta en markdown
 *    más bloques ```tasky-file``` con {type, filename, summary, data}.
 *  - Parser legacy tolerante (`parseStructuredResponse`) para el wrapper
 *    {content, meta, fileGenerated} que usaban versiones anteriores.
 *  - `normalizeFileGenerated`: corrige formas habituales antes del docengine.
 */

import { nanoid } from 'nanoid';
import { sanitizeFilename } from '../generators/docengine.js';

/**
 * Sanitiza raw output de modelos que rompen JSON:
 *  - elimina tokens extraños tipo `<]minimax[>`, `<]tag[>`
 *  - elimina chars de control no escapables
 *  - reemplaza double-escape común: `\"` después de `:` ya escaped → `"` (MiniMax bug)
 * No toca el contenido válido del JSON, solo prepara para reintentar JSON.parse.
 */
function sanitizeRawOutput(s) {
  if (!s) return s;
  return s
    .replace(/<\][a-zA-Z0-9_-]*\[>/g, '')        // tokens brand-like
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // chars de control no imprimibles
    .replace(/\\+"/g, '"')                        // \\\\" -> " (over-escape de comillas)
    .trim();
}

/**
 * Extrae el primer bloque JSON balanceado { ... } de s, ignorando texto
 * antes/después (mensaje markdown, "📎 Archivo...", etc.).
 * Si no encuentra balance, retorna null.
 */
export function extractBalancedJson(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === '"') { inStr = false; }
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extrae el contenido del primer fenced code block ```json ... ``` o ``` ... ```.
 * Retorna null si no hay fence.
 */
function extractFencedJson(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
}

/**
 * Legacy: extrae metadato TASK_APP_META: {...} del final del texto.
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
 * Best-effort: extrae `fileGenerated: {...}` de un string corrupto.
 * Devuelve el objeto parseado o null. Acepta que el snippet sea incompleto.
 */
function extractFileGeneratedBestEffort(s) {
  const m = s.match(/"fileGenerated"\s*:\s*(\{[\s\S]*?\})\s*[,\}]/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export const VALID_TYPES = new Set(['docx', 'xlsx', 'pptx']);

/**
 * Detecta formato DeepSeek: `<|tool_call_begin|>{...}<|tool_call_end|>` o
 * `<|tool_call_begin|>{...}` (truncado al final). Retorna el JSON interior o null.
 */
function extractToolCallJson(s) {
  const m = s.match(/<\|tool_call_begin\|>\s*(\{[\s\S]*?)(?:<\|tool_call_end\|>|$)/);
  if (!m) return null;
  let cand = m[1].trim();
  // Si está truncado al final, intentar cerrar llaves balanceadas
  const firstBrace = cand.indexOf('{');
  if (firstBrace > 0) cand = cand.slice(firstBrace);
  const balanced = extractBalancedJson(cand);
  return balanced ?? cand;
}

/**
 * Detecta wrapper suelto: el content es un JSON `{"type":"docx","filename":...,"data":{...}}`
 * sin el wrapper `{content,meta,fileGenerated}`. Si ese JSON tiene `type` valido + (`data`
 * o `filename`), lo trata como `fileGenerated` directo.
 * Retorna el objeto `fileGenerated` o null.
 */
function extractSlossWrapper(s) {
  const balanced = extractBalancedJson(s);
  if (!balanced) return null;
  try {
    const obj = JSON.parse(balanced);
    if (obj && typeof obj === 'object' && VALID_TYPES.has(obj.type) && (obj.data || obj.filename || obj.editPath)) {
      // wrapper suelto Confirmado: es un fileGenerated directo
      return obj;
    }
  } catch { /* probar tool_call o otro path */ }
  return null;
}

/**
 * Parsea la respuesta del LLM con cascada defensiva:
 *  1. JSON.parse directo
 *  2. Bloque fenced ```json ... ```
 *  3. JSON balanceado ignorando texto antes/después
 *  4. Sanitizar + reintentar JSON.parse
 *  5. extractFileGeneratedBestEffort (substring "fileGenerated":{...})
 *  5b. DeepSeek tool_call tokens <|tool_call_begin|>{...}
 *  5c. Wrapper suelto {"type":"docx","data":{...}} (sin wrapper content/meta/fileGenerated)
 *  6. Legacy TASK_APP_META (meta only, fileGenerated=null)
 *
 * @param {string} raw
 * @returns {{content:string, meta:object|null, fileGenerated:object|null, parseError:string|null, parseWarnings:string[]}}
 */
export function parseStructuredResponse(raw) {
  const warnings = [];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { content: '', meta: null, fileGenerated: null, parseError: 'empty_response', parseWarnings: warnings };
  }

  /**
   * Construye resultado desde un objeto parseado. Distingue:
   *  - wrapper estándar: tiene `content` o `meta` o `fileGenerated` → usar esas claves
   *  - wrapper suelto: tiene `type` válido (docx/xlsx/pptx) + `data` o `filename` → es un fileGenerated directo
   */
  const buildResult = (obj, warnLabel) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const isWrapper = 'content' in obj || 'meta' in obj || 'fileGenerated' in obj;
      const isSloss = VALID_TYPES.has(obj.type) && (obj.data || obj.filename || obj.editPath);
      if (isSloss && !isWrapper) {
        if (warnLabel) warnings.push(`${warnLabel}_sloss_wrapper`);
        return {
          content: '',
          meta: null,
          fileGenerated: obj,
          parseError: null,
          parseWarnings: warnings,
        };
      }
    }
    if (warnLabel) warnings.push(warnLabel);
    return {
      content: typeof obj?.content === 'string' ? obj.content : '',
      meta: obj?.meta && typeof obj.meta === 'object' ? obj.meta : null,
      fileGenerated: obj?.fileGenerated && typeof obj.fileGenerated === 'object' ? obj.fileGenerated : null,
      parseError: null,
      parseWarnings: warnings,
    };
  };

  // 1. JSON directo
  try {
    const obj = JSON.parse(raw);
    return buildResult(obj, null);
  } catch (e) { warnings.push(`step1_json_parse:${e.message}`); }

  // 2. Fenced
  const fenced = extractFencedJson(raw);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced);
      return buildResult(obj, 'step2_fenced_json_recovered');
    } catch (e) { warnings.push(`step2_fenced_parse:${e.message}`); }
  }

  // 3. JSON balanceado (ignora texto antes/después)
  const balanced = extractBalancedJson(raw);
  if (balanced) {
    try {
      const obj = JSON.parse(balanced);
      return buildResult(obj, 'step3_balanced_json_recovered');
    } catch (e) { warnings.push(`step3_balanced_parse:${e.message}`); }
  }

  // 4. Sanitizar + reintentar
  const cleaned = sanitizeRawOutput(raw);
  if (cleaned !== raw) {
    const cleanedBalanced = extractBalancedJson(cleaned) ?? cleaned;
    try {
      const obj = JSON.parse(cleanedBalanced);
      return buildResult(obj, 'step4_sanitized_recovered');
    } catch (e) { warnings.push(`step4_sanitized_parse:${e.message}`); }
  }

  // 5. fileGenerated best-effort (al menos salvar el archivo si el resto es basura)
  const fg = extractFileGeneratedBestEffort(cleaned);
  if (fg) {
    warnings.push('step5_file_generated_best_effort');
    const { cleanText, meta } = parseMetaFromAssistant(raw);
    return {
      content: cleanText || raw.slice(0, 2000),
      meta,
      fileGenerated: fg,
      parseError: 'partial_recovery',
      parseWarnings: warnings,
    };
  }

  // 5b. DeepSeek tool_call tokens: <|tool_call_begin|>{...}<|tool_call_end|>
  // Algunos modelos (DeepSeek V3/V4, Qwen, yi) emiten sus propios tokens de function-calling
  // en vez de respetar response_format json_schema. El blob interior es el fileGenerated directo.
  const toolCallJson = extractToolCallJson(cleaned);
  if (toolCallJson) {
    try {
      const obj = JSON.parse(toolCallJson);
      if (obj && VALID_TYPES.has(obj.type)) {
        warnings.push('step5b_tool_call_recovered');
        return {
          content: '',
          meta: null,
          fileGenerated: obj,
          parseError: 'partial_recovery',
          parseWarnings: warnings,
        };
      }
    } catch (e) { warnings.push(`step5b_tool_call_parse:${e.message}`); }
  }

  // 5c. Wrapper suelto: el content es un JSON tipo {"type":"docx","data":{...}} sin el wrapper
  // {content,meta,fileGenerated}. Si llega aquí, balanced no pudo parsearlo o no era válido.
  const slossFg = extractSlossWrapper(cleaned);
  if (slossFg) {
    warnings.push('step5c_sloss_wrapper_recovered');
    return {
      content: '',
      meta: null,
      fileGenerated: slossFg,
      parseError: 'partial_recovery',
      parseWarnings: warnings,
    };
  }

  // 6. Legacy fallback final (meta only)
  warnings.push('step6_legacy_fallback');
  const { cleanText, meta } = parseMetaFromAssistant(raw);
  return {
    content: cleanText || raw,
    meta,
    fileGenerated: null,
    parseError: 'legacy_fallback',
    parseWarnings: warnings,
  };
}

const EXT = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };
const META_KEYS = new Set(['type', 'filename', 'summary', 'editPath', 'editChanges', 'data', 'path', 'changes']);
const CONTENT_KEYS = ['sections', 'markdown', 'sheets', 'slides'];
const ALT_DATA_KEYS = ['schema', 'document', 'payload', 'body', 'content'];

function hasContent(type, d) {
  if (!d || typeof d !== 'object' || !Object.keys(d).length) return false;
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : !!v && typeof v === 'object');
  if (type === 'docx') return nonEmpty(d.sections) || nonEmpty(d.markdown) || nonEmpty(d.content) || nonEmpty(d.body) || nonEmpty(d.blocks);
  if (type === 'xlsx') return nonEmpty(d.sheets) || nonEmpty(d.rows) || nonEmpty(d.headers) || nonEmpty(d.worksheets);
  if (type === 'pptx') return nonEmpty(d.slides) || nonEmpty(d.pages) || nonEmpty(d.content);
  return true;
}

/**
 * Normaliza `fileGenerated` / argumentos de generate_file antes del docengine.
 * Corrige: type por extensión, `data` como string, contenido fuera de `data`,
 * `data` doblemente envuelta, nombres faltantes/sin extensión/con rutas.
 * @returns {{fg: object|null, fixes: string[]}}
 */
export function normalizeFileGenerated(fg) {
  if (!fg || typeof fg !== 'object') return { fg: null, fixes: [] };
  const fixes = [];
  const out = { ...fg };

  if (!out.type || !EXT[out.type]) {
    const probe = out.filename || out.editPath || '';
    const ext = String(probe).toLowerCase().match(/\.(\w+)$/)?.[1];
    if (ext && EXT[ext]) {
      out.type = EXT[ext];
      fixes.push(`type_inferred_from_extension:${ext}`);
    }
  }

  if (out.data && typeof out.data === 'string') {
    try {
      out.data = JSON.parse(out.data);
      fixes.push('data_string_parsed_to_object');
    } catch {
      fixes.push('data_string_unparseable_left_as_is');
    }
  }

  const isEdit = !!(out.editPath && out.editChanges);
  if (!isEdit && (!out.data || typeof out.data !== 'object')) {
    if (CONTENT_KEYS.some((k) => k in out)) {
      out.data = Object.fromEntries(Object.entries(out).filter(([k]) => !META_KEYS.has(k)));
      for (const k of Object.keys(out.data)) delete out[k];
      fixes.push('data_hoisted_from_top_level');
    } else {
      for (const key of ALT_DATA_KEYS) {
        const v = out[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          out.data = v;
          delete out[key];
          fixes.push(`data_from_${key}`);
          break;
        }
        if (key === 'content' && out.type === 'docx' && typeof v === 'string' && v.trim()) {
          out.data = { markdown: v };
          delete out[key];
          fixes.push('data_from_content');
          break;
        }
      }
    }
  }
  if (out.data && typeof out.data === 'object' && out.data.data && typeof out.data.data === 'object'
      && !CONTENT_KEYS.some((k) => k in out.data)) {
    out.data = { ...out.data, ...out.data.data };
    delete out.data.data;
    fixes.push('data_unwrapped');
  }

  if (!out.filename) {
    out.filename = `${out.type || 'file'}-${nanoid(8)}.${EXT[out.type] || 'bin'}`;
    fixes.push('filename_generated');
  } else if (out.type && EXT[out.type]) {
    if (!String(out.filename).toLowerCase().endsWith(`.${EXT[out.type]}`)) {
      out.filename = `${out.filename}.${EXT[out.type]}`;
      fixes.push('filename_extension_appended');
    }
    const safe = sanitizeFilename(out.filename, out.type);
    if (safe !== out.filename) {
      out.filename = safe;
      fixes.push('filename_sanitized');
    }
  }

  if (isEdit) {
    if (typeof out.editChanges !== 'object' || Object.keys(out.editChanges).length === 0) {
      fixes.push('empty_edit_changes_skipped');
      return { fg: null, fixes };
    }
    return { fg: out, fixes };
  }
  if (!out.data || typeof out.data !== 'object' || Object.keys(out.data).length === 0) {
    fixes.push('empty_data_skipped');
    return { fg: null, fixes };
  }
  if (!hasContent(out.type, out.data)) {
    fixes.push(`empty_${out.type}_${out.type === 'docx' ? 'sections' : out.type === 'xlsx' ? 'sheets' : 'slides'}_skipped`);
    return { fg: null, fixes };
  }
  return { fg: out, fixes };
}

// ---- Protocolo de texto -------------------------------------------------------------

const FILE_FENCE_LANGS = new Set(['tasky-file', 'taskyfile', 'tasky', 'file', 'archivo']);
const FENCE_RE = /```([\w-]*)[^\n]*\n([\s\S]*?)\n?```/g;

function looksLikeFile(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const typed = VALID_TYPES.has(obj.type) || /\.(docx|xlsx|pptx)$/i.test(String(obj.filename ?? ''));
  return typed && ['data', 'sections', 'sheets', 'slides', 'markdown'].some((k) => k in obj);
}

function tidyText(text) {
  return String(text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extrae bloques de archivo del texto del modelo.
 * @returns {{text: string, files: object[], warnings: string[]}}
 */
export function extractFileBlocks(text) {
  const files = [];
  const warnings = [];
  let changed = false;
  let rest = String(text ?? '').replace(FENCE_RE, (whole, lang, body) => {
    const l = String(lang || '').toLowerCase();
    if (FILE_FENCE_LANGS.has(l)) {
      changed = true;
      const obj = parseLoose(body);
      if (obj && typeof obj === 'object') files.push(obj);
      else warnings.push('file_block_unparseable');
      return '';
    }
    if (l === 'json' || l === '') {
      const obj = parseLoose(body);
      if (looksLikeFile(obj)) {
        changed = true;
        files.push(obj);
        return '';
      }
    }
    return whole;
  });
  const open = rest.search(/```(?:tasky-file|taskyfile|tasky)\b/i);
  if (open !== -1) {
    changed = true;
    const body = rest.slice(open).replace(/^```[^\n]*\n?/, '');
    const obj = parseLoose(body);
    if (obj && typeof obj === 'object') files.push(obj);
    else warnings.push('file_block_truncated');
    rest = rest.slice(0, open);
  }
  return { text: changed ? tidyText(rest) : String(text ?? ''), files, warnings };
}

function parseLoose(body) {
  const s = String(body ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch { /* intentar recorte balanceado */ }
  const b = extractBalancedJson(s);
  if (!b) return null;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
}

/**
 * Respuesta completa de un modelo en modo texto → contenido visible + archivos.
 * @returns {{content: string, files: object[], warnings: string[]}}
 */
export function parseTextModeResponse(raw) {
  const text = String(raw ?? '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || /^```json/i.test(trimmed) || /<\|tool_call_begin\|>/.test(trimmed)) {
    const parsed = parseStructuredResponse(trimmed);
    if (!parsed.parseError || parsed.fileGenerated) {
      const blocks = extractFileBlocks(parsed.content || '');
      return {
        content: blocks.text,
        files: [parsed.fileGenerated, ...blocks.files].filter(Boolean),
        warnings: [...(parsed.parseWarnings ?? []), ...blocks.warnings],
      };
    }
  }
  const blocks = extractFileBlocks(text);
  return { content: blocks.text, files: blocks.files, warnings: blocks.warnings };
}
