/**
 * llm/normalize.js — Normaliza salidas de modelos heterogéneos.
 *
 *  - Razonamiento embebido: `<think>…</think>` (también `<thinking>`, `<reasoning>`),
 *    incluido el caso R1-distill que omite la etiqueta de apertura.
 *  - Tool calls escritas como texto por modelos servidos sin parser de
 *    herramientas: Hermes/Qwen (`<tool_call>`), Mistral (`[TOOL_CALLS]`),
 *    DeepSeek (tokens ASCII y full-width), Llama (`<|python_tag|>`,
 *    `<function=…>`) y JSON suelto `{"name", "arguments"|"parameters"}`.
 *  - Filtro de streaming que oculta ese marcado (y los bloques ```tasky-file```)
 *    mientras se transmite al usuario.
 */

const THINK_OPEN = ['<think>', '<thinking>', '<reasoning>'];
const THINK_CLOSE = { '<think>': '</think>', '<thinking>': '</thinking>', '<reasoning>': '</reasoning>' };

/** Largo del sufijo más largo de `s` que es prefijo propio de alguna etiqueta. */
function partialTail(s, tags) {
  let best = 0;
  for (const tag of tags) {
    for (let k = Math.min(tag.length - 1, s.length); k > best; k -= 1) {
      if (tag.startsWith(s.slice(-k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}

/**
 * Filtro incremental: separa contenido visible de razonamiento.
 * push(chunk) → {content, reasoning}; flush() → resto.
 */
export function createThinkFilter() {
  let buf = '';
  let closeTag = null;

  function run(final) {
    let content = '';
    let reasoning = '';
    while (buf) {
      if (!closeTag) {
        let idx = -1;
        let tag = null;
        for (const t of THINK_OPEN) {
          const i = buf.indexOf(t);
          if (i !== -1 && (idx === -1 || i < idx)) {
            idx = i;
            tag = t;
          }
        }
        if (idx === -1) {
          const keep = final ? 0 : partialTail(buf, THINK_OPEN);
          content += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        content += buf.slice(0, idx);
        buf = buf.slice(idx + tag.length);
        closeTag = THINK_CLOSE[tag];
      } else {
        const i = buf.indexOf(closeTag);
        if (i === -1) {
          const keep = final ? 0 : partialTail(buf, [closeTag]);
          reasoning += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        reasoning += buf.slice(0, i);
        buf = buf.slice(i + closeTag.length);
        closeTag = null;
      }
    }
    return { content, reasoning };
  }

  return {
    push(text) {
      buf += text || '';
      return run(false);
    },
    flush() {
      return run(true);
    },
  };
}

/** Versión no incremental (texto completo). */
export function stripThink(text) {
  const s = String(text ?? '');
  const closeIdx = s.search(/<\/(think|thinking|reasoning)>/);
  const openIdx = s.search(/<(think|thinking|reasoning)>/);
  if (closeIdx !== -1 && (openIdx === -1 || openIdx > closeIdx)) {
    const tag = s.slice(closeIdx).match(/^<\/(think|thinking|reasoning)>/)[0];
    const inner = stripThink(s.slice(closeIdx + tag.length));
    const reasoning = [s.slice(0, closeIdx).trim(), inner.reasoning].filter(Boolean).join('\n');
    return { content: inner.content, reasoning };
  }
  const f = createThinkFilter();
  const a = f.push(s);
  const b = f.flush();
  return { content: (a.content + b.content).replace(/^\s+/, ''), reasoning: (a.reasoning + b.reasoning).trim() };
}

// ---- JSON tolerante --------------------------------------------------------------

/** JSON balanceado ({…} o […]) que empieza en `start`, respetando strings. */
export function balancedJsonAt(s, start) {
  const open = s[start];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Argumentos de tool call → objeto. Acepta objeto, string JSON, fences,
 * doble codificación, comas colgantes y JSON rodeado de texto. null si no se puede.
 */
export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  let v = tryParse(s);
  if (typeof v === 'string') {
    const inner = tryParse(v.trim());
    if (inner && typeof inner === 'object') return inner;
  }
  if (v && typeof v === 'object') return v;
  v = tryParse(s.replace(/,\s*([}\]])/g, '$1'));
  if (v && typeof v === 'object') return v;
  const start = s.search(/[{[]/);
  if (start !== -1) {
    const b = balancedJsonAt(s, start);
    if (b) {
      v = tryParse(b) ?? tryParse(b.replace(/,\s*([}\]])/g, '$1'));
      if (v && typeof v === 'object') return v;
    }
  }
  return null;
}

// ---- Tool calls en texto ----------------------------------------------------------

let callCounter = 0;
function makeCallId() {
  callCounter += 1;
  return `call_txt_${Date.now().toString(36)}${callCounter}`;
}

function toCall(obj, toolNames) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
  const name = obj.name ?? fn?.name ?? obj.tool ?? obj.tool_name;
  if (typeof name !== 'string' || !name) return null;
  if (toolNames?.length && !toolNames.includes(name)) return null;
  const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? fn?.arguments ?? fn?.parameters;
  if (rawArgs === undefined) return { id: makeCallId(), name, arguments: '{}' };
  const parsed = parseToolArguments(rawArgs);
  return {
    id: makeCallId(),
    name,
    arguments: parsed ? JSON.stringify(parsed) : (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)),
  };
}

function callsFromJson(value, toolNames) {
  const items = Array.isArray(value) ? value : [value];
  return items.map((it) => toCall(it, toolNames)).filter(Boolean);
}

const DS_CALL_BEGIN = '<[｜|]tool[▁_]call[▁_]begin[｜|]>';
const DS_SEP = '<[｜|]tool[▁_]sep[｜|]>';
const DS_CALL_END = '<[｜|]tool[▁_]call[▁_]end[｜|]>';
const DS_CALLS_BEGIN = '<[｜|]tool[▁_]calls[▁_]begin[｜|]>';
const DS_CALLS_END = '<[｜|]tool[▁_]calls[▁_]end[｜|]>';

/**
 * Extrae tool calls escritas como texto.
 * @param {string} text
 * @param {string[]} toolNames nombres válidos (se ignoran otros)
 * @returns {{calls: Array<{id:string,name:string,arguments:string}>, text:string}}
 */
export function extractTextToolCalls(text, toolNames = []) {
  let rest = String(text ?? '');
  const calls = [];

  // Hermes / Qwen
  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (_m, inner) => {
    const parsed = parseToolArguments(inner);
    if (parsed) calls.push(...callsFromJson(parsed, toolNames));
    return '';
  });

  // DeepSeek (V3: function<sep>name\n```json…```, V3.1: name<sep>{…})
  const dsCall = new RegExp(`${DS_CALL_BEGIN}([\\s\\S]*?)${DS_SEP}([\\s\\S]*?)(?=${DS_CALL_END}|${DS_CALL_BEGIN}|${DS_CALLS_END}|$)`, 'g');
  for (const m of rest.matchAll(dsCall)) {
    const head = m[1].trim();
    let tail = m[2].trim();
    let name = head;
    if (!head || head === 'function') {
      const nl = tail.indexOf('\n');
      name = (nl === -1 ? tail : tail.slice(0, nl)).trim();
      tail = nl === -1 ? '' : tail.slice(nl + 1);
    }
    const call = toCall({ name, arguments: tail || '{}' }, toolNames);
    if (call) calls.push(call);
  }
  rest = rest
    .replace(new RegExp(`${DS_CALLS_BEGIN}[\\s\\S]*?(?:${DS_CALLS_END}|$)`, 'g'), '')
    .replace(new RegExp(`${DS_CALL_BEGIN}[\\s\\S]*?(?:${DS_CALL_END}|$)`, 'g'), '');

  // Mistral
  rest = rest.replace(/\[TOOL_CALLS\]([\s\S]*)$/, (_m, body) => {
    const b = body.trim();
    if (b.startsWith('[') || b.startsWith('{')) {
      const parsed = parseToolArguments(b);
      if (parsed) calls.push(...callsFromJson(parsed, toolNames));
    } else {
      const re = /([A-Za-z0-9_.-]+)\[ARGS\]/g;
      let m;
      while ((m = re.exec(b)) !== null) {
        const start = b.indexOf('{', m.index + m[0].length);
        const json = start === -1 ? null : balancedJsonAt(b, start);
        const call = toCall({ name: m[1], arguments: json ?? '{}' }, toolNames);
        if (call) calls.push(call);
      }
    }
    return '';
  });

  // Llama 3.x
  rest = rest.replace(/<\|python_tag\|>([\s\S]*)$/, (_m, body) => {
    let i = body.indexOf('{');
    while (i !== -1) {
      const json = balancedJsonAt(body, i);
      if (!json) break;
      const parsed = parseToolArguments(json);
      if (parsed) calls.push(...callsFromJson(parsed, toolNames));
      i = body.indexOf('{', i + json.length);
    }
    return '';
  });
  rest = rest.replace(/<function=([A-Za-z0-9_.-]+)>([\s\S]*?)(?:<\/function>|$)/g, (_m, name, body) => {
    const call = toCall({ name, arguments: body.trim() || '{}' }, toolNames);
    if (call) calls.push(call);
    return '';
  });

  // JSON suelto con forma de tool call (objeto o lista), incluso al final de un párrafo
  const candidate = /\[\s*\{\s*"(?:name|type|function|tool)"|\{\s*"(?:name|type|function|tool)"/g;
  let m;
  const removals = [];
  while ((m = candidate.exec(rest)) !== null) {
    const json = balancedJsonAt(rest, m.index);
    if (!json) continue;
    const parsed = tryParse(json);
    const found = parsed ? callsFromJson(parsed, toolNames) : [];
    if (found.length) {
      calls.push(...found);
      removals.push([m.index, m.index + json.length]);
      candidate.lastIndex = m.index + json.length;
    }
  }
  for (const [a, b] of removals.reverse()) {
    rest = rest.slice(0, a) + rest.slice(b);
  }

  if (!calls.length) return { calls, text: String(text ?? '') };
  rest = rest.replace(/```(?:json)?\s*```/g, '').trim();
  return { calls, text: rest };
}

// ---- Filtro de marcado para streaming ------------------------------------------------

const MARKERS = [
  { start: '```tasky-file', end: '\n```', name: 'tasky-file' },
  { start: '<tool_call>', end: '</tool_call>', name: 'tool_call' },
  { start: '<｜tool▁calls▁begin｜>', end: '<｜tool▁calls▁end｜>', name: 'tool_call' },
  { start: '<｜tool▁call▁begin｜>', end: '<｜tool▁call▁end｜>', name: 'tool_call' },
  { start: '<|tool_calls_begin|>', end: '<|tool_calls_end|>', name: 'tool_call' },
  { start: '<|tool_call_begin|>', end: '<|tool_call_end|>', name: 'tool_call' },
  { start: '[TOOL_CALLS]', end: null, name: 'tool_call' },
  { start: '<|python_tag|>', end: null, name: 'tool_call' },
  { start: '<function=', end: '</function>', name: 'tool_call' },
];
const MARKER_STARTS = MARKERS.map((m) => m.start);

/**
 * Filtro incremental que oculta marcado de herramientas y bloques de archivo.
 * Si la respuesta empieza con `{` (JSON crudo) retiene todo hasta flush().
 * @param {{onHidden?: (name: string) => void}} [opts]
 */
export function createMarkerFilter({ onHidden } = {}) {
  let buf = '';
  let active = null; // marcador abierto
  let decided = false; // ya vimos el primer carácter no blanco
  let holdAll = false;

  function run(final) {
    let out = '';
    while (buf) {
      if (active) {
        if (active.end === null) {
          buf = '';
          break;
        }
        const i = buf.indexOf(active.end);
        if (i === -1) {
          const keep = final ? 0 : partialTail(buf, [active.end]);
          buf = buf.slice(buf.length - keep);
          if (final) buf = '';
          break;
        }
        buf = buf.slice(i + active.end.length);
        active = null;
        continue;
      }
      let idx = -1;
      let marker = null;
      for (const mk of MARKERS) {
        const i = buf.indexOf(mk.start);
        if (i !== -1 && (idx === -1 || i < idx)) {
          idx = i;
          marker = mk;
        }
      }
      if (idx === -1) {
        const keep = final ? 0 : partialTail(buf, MARKER_STARTS);
        out += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        break;
      }
      out += buf.slice(0, idx);
      buf = buf.slice(idx + marker.start.length);
      active = marker;
      onHidden?.(marker.name);
    }
    return out;
  }

  return {
    push(text) {
      buf += text || '';
      if (!decided) {
        const first = buf.search(/\S/);
        if (first === -1) return '';
        decided = true;
        holdAll = buf[first] === '{';
      }
      if (holdAll) return '';
      return run(false);
    },
    flush() {
      holdAll = false;
      return run(true);
    },
  };
}
