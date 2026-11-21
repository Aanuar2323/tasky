/**
 * context/project.js — Contexto del proyecto y del área para el prompt.
 *
 *  - Reglas: solo las activas (`### nombre / - desc / \`enabled|disabled\``),
 *    renderizadas como lista limpia. Plantillas sin editar = sin reglas.
 *  - Resúmenes e instrucciones de capas: se ignoran si siguen siendo la
 *    plantilla por defecto (no aportan y gastan tokens).
 *  - Archivos generados del área: sidecars `.tasky/*.json` + referencias en
 *    los chats del área (cubre archivos anteriores a los sidecars).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readTextFile,
  safeJoin,
  AREA_RULES_FILE,
  AREA_SUMMARY_FILE,
  DEFAULT_GLOBAL_RULES,
  DEFAULT_LAYER1,
  DEFAULT_LAYER2_SUMMARY,
  DEFAULT_LAYER3,
} from '../storage.js';
import { CONTEXT_EXTS } from './extract.js';
import { LEGACY_TEMPLATES } from './legacy-templates.js';

const TEMPLATE_MARKER = /\*\*Instrucciones:\*\*/;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const KNOWN_DEFAULTS = new Set(
  [DEFAULT_GLOBAL_RULES, DEFAULT_LAYER1, DEFAULT_LAYER2_SUMMARY, DEFAULT_LAYER3, ...LEGACY_TEMPLATES].map(norm)
);
const SIDECAR_DIR = '.tasky';

/** Mismo formato que apps/web/app/lib/rules-parser.ts. */
export function parseRules(markdown) {
  if (!markdown) return [];
  const rules = [];
  let current = null;
  for (const line of String(markdown).split('\n')) {
    const heading = line.match(/^###\s+(.+)/);
    const desc = line.match(/^-\s+(.+)/);
    const tag = line.match(/^`([^`]+)`$/);
    if (heading) {
      if (current) rules.push(current);
      current = { name: heading[1].trim(), desc: '', tags: [], enabled: true };
      continue;
    }
    if (!current) continue;
    if (desc) {
      current.desc = desc[1].trim();
    } else if (tag) {
      const t = tag[1].trim();
      if (t === 'disabled') current.enabled = false;
      else if (t !== 'enabled') current.tags.push(t);
    }
  }
  if (current) rules.push(current);
  return rules;
}

export function isTemplateText(markdown) {
  return TEMPLATE_MARKER.test(String(markdown ?? ''));
}

export function isDefaultContent(markdown) {
  return KNOWN_DEFAULTS.has(norm(markdown));
}

/** Reglas activas como lista; texto libre tal cual; plantilla o vacío → ''. */
export function renderActiveRules(markdown) {
  const text = String(markdown ?? '').trim();
  if (!text) return '';
  const rules = parseRules(text);
  if (rules.length) {
    return rules
      .filter((r) => r.enabled)
      .map((r) => (r.desc && r.desc !== 'Sin descripcion' ? `- ${r.name}: ${r.desc}` : `- ${r.name}`))
      .join('\n');
  }
  if (isTemplateText(text) || isDefaultContent(text)) return '';
  return text;
}

export function cleanSummary(markdown) {
  const text = String(markdown ?? '').trim();
  if (!text || isTemplateText(text) || isDefaultContent(text)) return '';
  return text;
}

async function readOptional(root, rel) {
  try {
    return await readTextFile(root, rel);
  } catch {
    return '';
  }
}

/**
 * @returns {Promise<{projectName:string, areaName:string, summary:string, areaSummary:string,
 *   rules:string, customInstructions:string}>}
 */
export async function loadProjectContext(root, areaId, areas) {
  const area = (areas ?? []).find((a) => a?.id === areaId);
  const [name, summary, areaSummary, areaRules, globalRules, layer1, layer3] = await Promise.all([
    readOptional(root, 'info/name.txt'),
    readOptional(root, 'ai/layer2/summary.md'),
    readOptional(root, `ai/layer2/areas/${areaId}/${AREA_SUMMARY_FILE}`),
    readOptional(root, `ai/layer2/areas/${areaId}/${AREA_RULES_FILE}`),
    readOptional(root, 'rules.md'),
    readOptional(root, 'ai/layer1/00-role-and-flow.md'),
    readOptional(root, 'ai/layer3/qa.md'),
  ]);
  return {
    projectName: name.trim(),
    areaName: area?.name ?? areaId,
    summary: cleanSummary(summary),
    areaSummary: cleanSummary(areaSummary),
    rules: renderActiveRules(areaRules) || renderActiveRules(globalRules),
    customInstructions: [layer1, layer3].map(cleanSummary).filter(Boolean).join('\n\n'),
  };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Archivos generados del área, más recientes primero.
 * @returns {Promise<Array<{path:string, filename:string, type:string, summary:string|null, createdAt:string|null, chatId:string|null}>>}
 */
export async function listGeneratedFiles(root, { areaId, limit = 40 } = {}) {
  const found = new Map();
  const genDir = path.join(root, 'files', 'generated');

  try {
    const sideDir = path.join(genDir, SIDECAR_DIR);
    for (const name of await fs.readdir(sideDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const side = JSON.parse(await fs.readFile(path.join(sideDir, name), 'utf8'));
        if (!side?.filename || side.areaId !== areaId) continue;
        const rel = `files/generated/${side.filename}`;
        if (!(await exists(path.join(genDir, side.filename)))) continue;
        found.set(rel, {
          path: rel,
          filename: side.filename,
          type: side.type ?? path.extname(side.filename).slice(1),
          summary: side.summary ?? null,
          createdAt: side.createdAt ?? null,
          chatId: side.chatId ?? null,
        });
      } catch { /* sidecar corrupto */ }
    }
  } catch { /* sin sidecars todavía */ }

  try {
    const chatDir = safeJoin(root, `chat/areas/${areaId}`);
    for (const name of await fs.readdir(chatDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const raw = await fs.readFile(path.join(chatDir, name), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.includes('"file')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const list = Array.isArray(entry?.files) && entry.files.length ? entry.files : (entry?.file ? [entry.file] : []);
        for (const f of list) {
          const rel = String(f?.url ?? f?.path ?? '');
          const filename = f?.name ?? f?.filename ?? path.posix.basename(rel);
          if (!rel.startsWith('files/') || found.has(rel)) continue;
          let abs;
          try { abs = safeJoin(root, rel); } catch { continue; }
          if (!(await exists(abs))) continue;
          found.set(rel, {
            path: rel,
            filename,
            type: f?.type ?? path.extname(filename).slice(1),
            summary: f?.summary ?? null,
            createdAt: entry.ts ? new Date(entry.ts).toISOString() : null,
            chatId: name.replace(/\.jsonl$/, ''),
          });
        }
      }
    }
  } catch { /* área sin chats */ }

  return [...found.values()]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, limit);
}

async function listDirFiles(root, relDir) {
  try {
    const entries = await fs.readdir(safeJoin(root, relDir), { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (e.name === AREA_RULES_FILE || e.name === AREA_SUMMARY_FILE || !CONTEXT_EXTS.test(e.name)) continue;
      const rel = path.posix.join(relDir, e.name);
      const st = await fs.stat(safeJoin(root, rel));
      out.push({ path: rel, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  } catch {
    return [];
  }
}

/** Archivos de contexto del área (carpeta del área + un nivel de subcarpetas). */
export async function listAreaContextFiles(root, areaId) {
  const areaDir = `ai/layer2/areas/${areaId}`;
  const files = await listDirFiles(root, areaDir);
  try {
    const entries = await fs.readdir(safeJoin(root, areaDir), { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) files.push(...(await listDirFiles(root, `${areaDir}/${e.name}`)));
    }
  } catch { /* área sin carpeta */ }
  return files;
}

/** Adjuntos persistidos del chat. */
export async function listChatUploads(root, areaId, chatId) {
  return listDirFiles(root, `files/uploads/${areaId}/${chatId}`);
}
