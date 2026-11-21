/**
 * context/html-md.js — HTML de mammoth → Markdown (GFM) para la vista previa de DOCX.
 *
 * mammoth.convertToMarkdown no soporta tablas: las aplana en párrafos sueltos.
 * Su HTML sí las conserva y es chico y predecible (p, h1-h6, strong, em, a, br,
 * ul/ol/li, table/tr/th/td, img), así que alcanza con este conversor.
 */

import { decodeXmlEntities } from './xml.js';

const VOID = new Set(['br', 'img', 'hr', 'col', 'wbr']);
const NUMERIC = /^[-−+]?(?:(?:US)?\$|€|£)?\s?[-−+]?\d[\d.,]*\s?%?$/;

function parse(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, closing, rawTag, rawAttrs, selfClosing, text] = m;
    const parent = stack[stack.length - 1];
    if (text !== undefined) {
      parent.children.push({ text: decodeXmlEntities(text) });
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing) {
      const idx = stack.map((n) => n.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1].toLowerCase()] = decodeXmlEntities(a[2]);
    const node = { tag, attrs, children: [] };
    parent.children.push(node);
    if (!selfClosing && !VOID.has(tag)) stack.push(node);
  }
  return root;
}

function escapeText(s) {
  return s.replace(/([\\`*_[\]<])/g, '\\$1');
}

function wrap(marker, inner) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : inner;
}

function inline(node) {
  if (node.text !== undefined) return escapeText(node.text.replace(/\s+/g, ' '));
  const inner = () => node.children.map(inline).join('');
  switch (node.tag) {
    case 'br':
      return '  \n';
    case 'img':
      return '';
    case 'strong':
    case 'b':
      return wrap('**', inner());
    case 'em':
    case 'i':
      return wrap('*', inner());
    case 's':
    case 'del':
      return wrap('~~', inner());
    case 'code':
      return `\`${node.children.map((c) => c.text ?? '').join('')}\``;
    case 'a': {
      const href = node.attrs.href ?? '';
      const text = inner();
      return href && !href.startsWith('#') && /^(https?:|mailto:)/i.test(href) ? `[${text}](${href})` : text;
    }
    default:
      return inner();
  }
}

function cellText(cell) {
  return cell.children
    .map((c) => (c.text !== undefined ? inline(c) : ['p', 'div'].includes(c.tag) ? c.children.map(inline).join('') : inline(c)))
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

function table(node) {
  const rows = [];
  const collect = (n) => {
    for (const c of n.children) {
      if (c.tag === 'tr') rows.push(c.children.filter((x) => x.tag === 'td' || x.tag === 'th').map(cellText));
      else if (c.tag && ['thead', 'tbody', 'tfoot'].includes(c.tag)) collect(c);
    }
  };
  collect(node);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const [rawHeader, ...body] = rows.map(pad);
  const header = rawHeader.map(unbold);
  const unescape = (s) => s.replace(/\\(.)/g, '$1');
  const align = header.map((_, j) => {
    const vals = body.map((r) => unescape(r[j])).filter(Boolean);
    return vals.length && vals.every((v) => NUMERIC.test(v)) ? '---:' : '---';
  });
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(align), ...body.map(line)].join('\n');
}

function list(node, depth) {
  const ordered = node.tag === 'ol';
  const indent = '   '.repeat(depth);
  const lines = [];
  let i = 0;
  for (const li of node.children.filter((c) => c.tag === 'li')) {
    i += 1;
    const text = li.children
      .filter((c) => !(c.tag === 'ul' || c.tag === 'ol'))
      .map((c) => (c.text !== undefined ? inline(c) : ['p', 'div'].includes(c.tag) ? c.children.map(inline).join('') : inline(c)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    lines.push(`${indent}${ordered ? `${i}.` : '-'} ${text}`);
    for (const sub of li.children.filter((c) => c.tag === 'ul' || c.tag === 'ol')) lines.push(list(sub, depth + 1));
  }
  return lines.join('\n');
}

/** Encabezados y títulos ya se ven en negrita: sin marcas redundantes. */
function unbold(text) {
  return text.replace(/^\*\*([\s\S]*)\*\*$/, '$1');
}

/** Evita que un párrafo que empieza como sintaxis de markdown cambie de tipo. */
function guardStart(text) {
  if (/^\d+[.)]\s/.test(text)) return text.replace(/^(\d+)([.)])/, '$1\\$2');
  return /^(#|>|[-+*]\s)/.test(text) ? `\\${text}` : text;
}

function blocks(node) {
  const out = [];
  let buffer = '';
  const flush = () => {
    const t = buffer.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(guardStart(t));
    buffer = '';
  };
  for (const c of node.children) {
    if (c.text !== undefined || !['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'hr', 'div'].includes(c.tag)) {
      buffer += inline(c);
      continue;
    }
    flush();
    if (c.tag === 'p') {
      const t = c.children.map(inline).join('').replace(/[ \t]+/g, ' ').trim();
      if (t) out.push(guardStart(t));
    } else if (/^h[1-6]$/.test(c.tag)) {
      const t = unbold(c.children.map(inline).join('').replace(/\s+/g, ' ').trim());
      if (t) out.push(`${'#'.repeat(Number(c.tag[1]))} ${t}`);
    } else if (c.tag === 'ul' || c.tag === 'ol') {
      const t = list(c, 0);
      if (t) out.push(t);
    } else if (c.tag === 'table') {
      const t = table(c);
      if (t) out.push(t);
    } else if (c.tag === 'blockquote') {
      const t = blocks(c);
      if (t) out.push(t.split('\n').map((l) => `> ${l}`).join('\n'));
    } else if (c.tag === 'hr') {
      out.push('---');
    } else {
      const t = blocks(c);
      if (t) out.push(t);
    }
  }
  flush();
  return out.join('\n\n');
}

export function htmlToMarkdown(html) {
  return blocks(parse(String(html ?? '')));
}

