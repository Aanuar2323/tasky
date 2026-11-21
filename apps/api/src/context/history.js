/**
 * context/history.js — Historial del chat (fuente de verdad: el .jsonl).
 *
 *  - Convierte entradas persistidas en mensajes para el modelo, con notas de
 *    archivos generados (ruta incluida, para que pueda leerlos/editarlos).
 *  - Recorta al presupuesto conservando lo más reciente, empezando en un
 *    mensaje del usuario y fusionando roles consecutivos (requisito de varios
 *    proveedores).
 *  - Resumen de compactación por chat para la parte que ya no entra.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from '../storage.js';
import { estimateMessagesTokens, truncateToTokens } from './budget.js';

export function chatLogRel(areaId, chatId) {
  return `chat/areas/${areaId}/${chatId}.jsonl`;
}

function summaryRel(areaId, chatId) {
  return `chat/areas/${areaId}/${chatId}.summary.json`;
}

export async function readChatLog(root, areaId, chatId) {
  let raw;
  try {
    raw = await fs.readFile(safeJoin(root, chatLogRel(areaId, chatId)), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* línea corrupta */ }
  }
  return out;
}

export async function appendChatEntry(root, areaId, chatId, entry) {
  const abs = safeJoin(root, chatLogRel(areaId, chatId));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function rewriteChatLog(root, areaId, chatId, entries) {
  const abs = safeJoin(root, chatLogRel(areaId, chatId));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  await fs.rename(tmp, abs);
}

/**
 * Descarta lo posterior al último mensaje del usuario (para regenerar).
 * @returns {Promise<{lastUser: object|null, removed: number}>}
 */
export async function truncateAfterLastUser(root, areaId, chatId) {
  const entries = await readChatLog(root, areaId, chatId);
  let idx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { lastUser: null, removed: 0 };
  const removed = entries.length - idx - 1;
  if (removed > 0) await rewriteChatLog(root, areaId, chatId, entries.slice(0, idx + 1));
  return { lastUser: entries[idx], removed };
}

export function entryFiles(entry) {
  const list = Array.isArray(entry?.files) && entry.files.length ? entry.files : (entry?.file ? [entry.file] : []);
  return list
    .map((f) => ({ name: f?.name ?? f?.filename ?? '', url: f?.url ?? f?.path ?? '', type: f?.type ?? '' }))
    .filter((f) => f.name && f.url);
}

/** Entradas del .jsonl → [{role, content, id, ts}] para el modelo. */
export function entriesToMessages(entries) {
  const out = [];
  for (const e of entries ?? []) {
    if (!e || typeof e !== 'object') continue;
    if (e.role === 'user') {
      let content = String(e.content ?? '');
      const names = (e.attachments ?? []).map((a) => a?.name).filter(Boolean);
      if (names.length) content += `\n\n[Adjuntos: ${names.join(', ')}]`;
      if (content.trim()) out.push({ role: 'user', content, id: e.id, ts: e.ts });
      continue;
    }
    const notes = entryFiles(e).map((f) => `[Archivo generado: ${f.name} (${f.type}) — ${f.url}]`);
    if (e.role === 'assistant') {
      const text = [String(e.content ?? '').trim(), ...notes].filter(Boolean).join('\n\n');
      if (text) out.push({ role: 'assistant', content: text, id: e.id, ts: e.ts });
    } else if (e.role === 'system' && notes.length) {
      out.push({ role: 'assistant', content: notes.join('\n'), id: e.id, ts: e.ts });
    }
  }
  return out;
}

/**
 * Mensajes más recientes que entran en `budgetTokens`.
 * @returns {{messages: object[], dropped: number}}
 */
export function fitHistory(messages, budgetTokens) {
  const kept = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessagesTokens([messages[i]]);
    if (used + cost > budgetTokens) {
      if (!kept.length && typeof messages[i].content === 'string') {
        kept.unshift({ ...messages[i], content: truncateToTokens(messages[i].content, Math.max(64, budgetTokens - 8)) });
      }
      break;
    }
    kept.unshift(messages[i]);
    used += cost;
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  const dropped = messages.length - kept.length;
  const merged = [];
  for (const m of kept) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') {
      merged[merged.length - 1] = { ...last, content: `${last.content}\n\n${m.content}` };
    } else {
      merged.push({ ...m });
    }
  }
  return { messages: merged, dropped };
}

export async function loadSummary(root, areaId, chatId) {
  try {
    const obj = JSON.parse(await fs.readFile(safeJoin(root, summaryRel(areaId, chatId)), 'utf8'));
    return obj && typeof obj.text === 'string' ? obj : null;
  } catch {
    return null;
  }
}

export async function saveSummary(root, areaId, chatId, { uptoTs, text }) {
  const abs = safeJoin(root, summaryRel(areaId, chatId));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify({ uptoTs, text, updatedAt: new Date().toISOString() }), 'utf8');
}
