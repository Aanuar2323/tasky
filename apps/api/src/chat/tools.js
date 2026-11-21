/**
 * chat/tools.js — Herramientas que el modelo puede llamar durante el chat.
 *
 *   generate_file  crea un .docx/.xlsx/.pptx con el docengine Python
 *   edit_file      modifica un archivo existente (reemplazos, celdas, anexos)
 *   read_file      lee texto de archivos del área (y la fuente de los generados)
 *
 * Los esquemas usan JSON Schema simple (sin oneOf/strict) para que los acepten
 * todos los proveedores compatibles con OpenAI.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, AREA_RULES_FILE, AREA_SUMMARY_FILE } from '../storage.js';
import { generateFile, editFile, readSourceSidecar, detectFileType } from '../generators/docengine.js';
import { extractText, kindOf } from '../context/extract.js';
import { parseToolArguments } from '../llm/normalize.js';
import { normalizeFileGenerated } from './protocol.js';

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'generate_file',
      description:
        'Crea un archivo Word (.docx), Excel (.xlsx) o PowerPoint (.pptx) con contenido real y completo. ' +
        'Usala cuando el usuario pida un archivo, documento, planilla o presentación. ' +
        'Todo el contenido va dentro de `data`, con la forma descrita en las instrucciones.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['docx', 'xlsx', 'pptx'], description: 'Formato del archivo' },
          filename: { type: 'string', description: 'Nombre descriptivo con extensión y sin rutas, p. ej. informe_ventas_q3.docx' },
          summary: { type: 'string', description: 'Una línea que describe qué contiene el archivo' },
          data: {
            type: 'object',
            description: 'Contenido completo. docx: {title, subtitle?, cover?, sections[] o markdown}. xlsx: {sheets[]}. pptx: {title?, slides[]}.',
          },
        },
        required: ['type', 'filename', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Modifica un archivo existente del proyecto sin rehacerlo: reemplazar texto o plantillas {{clave}}, ' +
        'actualizar celdas o agregar filas/hojas en Excel, o agregar contenido al final de un Word. ' +
        'Para cambios grandes en un archivo generado, leé su fuente con read_file y volvé a llamar generate_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo tal como figura en el contexto, p. ej. files/generated/informe.docx' },
          changes: {
            type: 'object',
            description:
              'docx/pptx: {replace:[{find,replace}], template:{clave:valor}, append_markdown:"texto" (solo docx)}. ' +
              'xlsx: {sheets:[{name, create?, update_cells:[{cell,value}], add_rows:[[...]], rename?}], replace:[{find,replace}]}.',
          },
          filename: { type: 'string', description: 'Nombre del archivo resultante (opcional)' },
        },
        required: ['path', 'changes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Lee el texto de un archivo del área (contexto, adjuntos o archivos generados). ' +
        'En archivos generados también devuelve su fuente JSON para regenerarlos con cambios.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta exacta según el índice de archivos del contexto' },
          offset: { type: 'integer', description: 'Carácter desde el cual continuar leyendo un archivo largo' },
        },
        required: ['path'],
      },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.function.name);

// ---- Ejecución ------------------------------------------------------------------------

const READ_CHUNK = 12_000;
const SOURCE_MAX = 20_000;

const TYPE_HINT = {
  docx: '`data` debe tener `sections` (lista de secciones con texto) o `markdown` con el cuerpo del documento',
  xlsx: '`data` debe tener `sheets` con al menos una hoja con `headers` y `rows`',
  pptx: '`data` debe tener `slides` con al menos una diapositiva con título y contenido',
};

/** Rutas que el modelo puede leer/editar dentro del proyecto. */
export function isReadablePath(rel, areaId) {
  const raw = String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!raw) return false;
  const p = path.posix.normalize(raw);
  if (p.startsWith('..') || path.posix.isAbsolute(p)) return false;
  if (p.split('/').some((seg) => seg.startsWith('.'))) return false;
  const base = path.posix.basename(p);
  if (base === AREA_RULES_FILE || base === AREA_SUMMARY_FILE) return false;
  return p.startsWith(`ai/layer2/areas/${areaId}/`) || p.startsWith('files/') || p.startsWith(`history/areas/${areaId}/`);
}

function cleanRel(rel) {
  return path.posix.normalize(String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, ''));
}

async function fileInfo(root, rel, type, summary) {
  let size = 0;
  try {
    size = (await fs.stat(safeJoin(root, rel))).size;
  } catch { /* se informa 0 */ }
  const name = path.posix.basename(rel);
  return { name, url: rel, type, meta: type.toUpperCase(), summary: summary || null, size };
}

function kb(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function runGenerate(args, ctx) {
  const { fg, fixes } = normalizeFileGenerated(args);
  if (!fg) {
    const type = args?.type && TYPE_HINT[args.type] ? args.type : null;
    return {
      ok: false,
      content: `ERROR: el archivo no tiene contenido utilizable (${fixes.join(', ') || 'sin data'}). ` +
        `Todo el contenido va dentro de "data": ${type ? TYPE_HINT[type] : Object.values(TYPE_HINT).join('; ')}. ` +
        'Volvé a llamar generate_file con el contenido completo.',
    };
  }
  if (fg.editPath && fg.editChanges) {
    return runEdit({ path: fg.editPath, changes: fg.editChanges, filename: fg.filename }, ctx);
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 300) : '';
  ctx.emit?.({ type: 'status', phase: 'generating', label: `Generando ${fg.filename}`, file: fg.filename });
  const outputDir = path.join(ctx.root, 'files', 'generated');
  try {
    const res = await generateFile({
      type: fg.type,
      outputDir,
      data: fg.data,
      filename: fg.filename,
      source: { summary, areaId: ctx.areaId, chatId: ctx.chatId },
    });
    const rel = `files/generated/${res.filename}`;
    const file = await fileInfo(ctx.root, rel, fg.type, summary);
    const notes = [...fixes, ...(res.fixes ?? [])];
    return {
      ok: true,
      file,
      content:
        `OK: archivo creado "${res.filename}" (${fg.type.toUpperCase()}, ${kb(file.size)}) en ${rel}.` +
        (notes.length ? ` Correcciones automáticas aplicadas: ${notes.join(', ')}.` : '') +
        ' El usuario ya ve el archivo con botón de descarga: no pegues su contenido ni enlaces; resumí en 1 a 3 frases qué incluye.',
    };
  } catch (err) {
    if (err.kind === 'schema_error' || err.kind === 'edit_error') {
      return {
        ok: false,
        content: `ERROR: el contenido no es válido para ${fg.type.toUpperCase()}: ${err.detail || err.message}. ` +
          'Corregí esos campos y volvé a llamar generate_file con el payload completo.',
      };
    }
    return {
      ok: false,
      fatal: err.kind === 'python_missing',
      content: `ERROR: no se pudo generar el archivo (${err.kind ?? 'error'}: ${String(err.detail ?? err.message).slice(0, 300)}). ` +
        'Contale al usuario qué pasó y ofrecé el contenido en el chat.',
    };
  }
}

async function runEdit(args, ctx) {
  const rel = cleanRel(args?.path);
  if (!isReadablePath(rel, ctx.areaId)) {
    return { ok: false, content: `ERROR: no se puede editar "${args?.path ?? ''}". Usá una ruta del índice de archivos o de los archivos generados.` };
  }
  const type = detectFileType(rel);
  if (!type) return { ok: false, content: 'ERROR: edit_file solo modifica archivos .docx, .xlsx o .pptx.' };
  const changes = args?.changes && typeof args.changes === 'object' ? args.changes : null;
  if (!changes || !Object.keys(changes).length) {
    return { ok: false, content: 'ERROR: `changes` está vacío. Indicá replace, template, append_markdown (docx) o sheets (xlsx).' };
  }
  let abs;
  try {
    abs = safeJoin(ctx.root, rel);
    await fs.access(abs);
  } catch {
    return { ok: false, content: `ERROR: el archivo "${rel}" no existe.` };
  }
  ctx.emit?.({ type: 'status', phase: 'generating', label: `Editando ${path.posix.basename(rel)}`, file: path.posix.basename(rel) });
  try {
    const res = await editFile({
      type,
      inputPath: abs,
      outputDir: path.join(ctx.root, 'files', 'generated'),
      changes,
      filename: args.filename || path.posix.basename(rel),
    });
    const s = res.stats ?? {};
    const changed = (s.replacements ?? 0) + (s.appended_blocks ?? 0) + (s.cells_updated ?? 0) + (s.rows_added ?? 0) + (s.sheets_created ?? 0);
    if (!changed && Object.keys(s).length) {
      await fs.rm(res.filePath, { force: true });
      return {
        ok: false,
        content: 'ERROR: no se encontró ninguno de los textos a reemplazar, así que el archivo quedaría igual. ' +
          'Leé el archivo con read_file y reintentá con el texto exacto.',
      };
    }
    const outRel = `files/generated/${res.filename}`;
    const file = await fileInfo(ctx.root, outRel, type, `Edición de ${path.posix.basename(rel)}`);
    const parts = Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
    return {
      ok: true,
      file,
      content: `OK: se creó "${res.filename}" (${parts || 'cambios aplicados'}) en ${outRel}; el original no se modificó. ` +
        'Resumí en 1 a 2 frases qué cambió.',
    };
  } catch (err) {
    return { ok: false, content: `ERROR: no se pudo editar el archivo: ${String(err.detail ?? err.message).slice(0, 300)}` };
  }
}

async function runRead(args, ctx) {
  const rel = cleanRel(args?.path);
  if (!isReadablePath(rel, ctx.areaId)) {
    return { ok: false, content: `ERROR: no tenés acceso a "${args?.path ?? ''}". Usá una ruta del índice de archivos o de los archivos generados.` };
  }
  let abs;
  try {
    abs = safeJoin(ctx.root, rel);
    await fs.access(abs);
  } catch {
    return { ok: false, content: `ERROR: el archivo "${rel}" no existe.` };
  }
  const name = path.posix.basename(rel);
  ctx.emit?.({ type: 'status', phase: 'reading', label: `Leyendo ${name}`, file: name });
  const kind = kindOf(name);
  const text = await extractText(abs);
  if (!text) {
    return {
      ok: false,
      content: kind === 'image'
        ? `"${name}" es una imagen: no se puede leer como texto.`
        : `"${name}" no tiene texto legible (archivo vacío, escaneado o binario).`,
    };
  }
  const offset = Math.max(0, Math.min(Number.parseInt(args?.offset, 10) || 0, text.length));
  const end = Math.min(text.length, offset + READ_CHUNK);
  let content = `Contenido de ${rel} (caracteres ${offset + 1}-${end} de ${text.length}):\n${text.slice(offset, end)}`;
  if (end < text.length) content += `\n[Continúa: llamá read_file con offset=${end}]`;
  if (rel.startsWith('files/generated/')) {
    const side = await readSourceSidecar(path.join(ctx.root, 'files', 'generated'), name);
    if (side?.data) {
      let json = JSON.stringify(side.data);
      const truncated = json.length > SOURCE_MAX;
      if (truncated) json = json.slice(0, SOURCE_MAX);
      content += `\n\nFuente para regenerar (data de generate_file, type=${side.type}${truncated ? ', recortada' : ''}):\n\`\`\`json\n${json}\n\`\`\``;
    }
  }
  return { ok: true, content };
}

/**
 * Ejecuta una tool call del modelo.
 * @param {{id:string, name:string, arguments:string|object}} call
 * @param {{root:string, areaId:string, chatId:string, emit?:Function}} ctx
 * @returns {Promise<{ok:boolean, content:string, file?:object, fatal?:boolean}>}
 */
export async function executeTool(call, ctx) {
  const args = parseToolArguments(call?.arguments ?? '{}');
  if (!args) {
    return {
      ok: false,
      content: `ERROR: los argumentos de ${call?.name} no son un JSON válido (probablemente se cortó por largo). ` +
        'Volvé a llamar la herramienta con un JSON válido y completo; si el documento es muy extenso, hacelo más compacto.',
    };
  }
  switch (call?.name) {
    case 'generate_file':
      return runGenerate(args, ctx);
    case 'edit_file':
      return runEdit(args, ctx);
    case 'read_file':
      return runRead(args, ctx);
    default:
      return { ok: false, content: `ERROR: la herramienta "${call?.name}" no existe. Disponibles: ${TOOL_NAMES.join(', ')}.` };
  }
}

/** Tool call para reenviar al modelo sin repetir el contenido completo del archivo. */
export function compactToolCallForReplay(call) {
  let args = parseToolArguments(call.arguments) ?? {};
  if (call.name === 'generate_file' && args.data !== undefined) {
    const size = JSON.stringify(args.data).length;
    args = { ...args, data: `[contenido omitido: ${size} caracteres]` };
  }
  return { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(args) } };
}
