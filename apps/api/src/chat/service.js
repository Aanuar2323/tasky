/**
 * chat/service.js — Orquestación de un turno de chat.
 *
 *   1. Persiste el mensaje del usuario (y sus adjuntos) o prepara la regeneración.
 *   2. Arma el contexto dentro del presupuesto del modelo: reglas activas,
 *      índice de archivos, fragmentos relevantes (BM25), archivos generados,
 *      adjuntos del mensaje (texto o imágenes para modelos con visión) e historial.
 *   3. Loop agente (máx. 5 pasos): stream del modelo → herramientas → resultados.
 *      Modelos sin tools usan el protocolo de texto (```tasky-file```).
 *   4. Persiste la respuesta (texto, archivos, uso) y, si el historial ya no
 *      entra, compacta en segundo plano.
 *
 * Eventos emitidos: start, status, reasoning, delta, file, done, error.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { safeJoin, saveUploadedFile } from '../storage.js';
import { getActive, isConfigured } from '../llm/providers.js';
import { getModelProfile, resolveReasoningEffort } from '../llm/capabilities.js';
import { chatCompletion } from '../llm/client.js';
import { humanizeError, llmError } from '../llm/errors.js';
import { createMarkerFilter, extractTextToolCalls, parseToolArguments } from '../llm/normalize.js';
import { extractText, kindOf } from '../context/extract.js';
import { buildIndex, search } from '../context/retrieval.js';
import { estimateMessagesTokens, estimateTokens, planBudget, truncateToTokens } from '../context/budget.js';
import { listAreaContextFiles, listChatUploads, listGeneratedFiles, loadProjectContext } from '../context/project.js';
import {
  appendChatEntry,
  entriesToMessages,
  fitHistory,
  loadSummary,
  readChatLog,
  saveSummary,
  truncateAfterLastUser,
} from '../context/history.js';
import { buildSystemPrompt } from './prompt.js';
import { TOOL_DEFS, TOOL_NAMES, compactToolCallForReplay, executeTool } from './tools.js';
import { parseTextModeResponse } from './protocol.js';

const MAX_STEPS = 5;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_INDEXED_FILES = 80;

const TOOL_LABELS = {
  generate_file: 'Generando archivo',
  edit_file: 'Editando archivo',
  read_file: 'Leyendo archivos',
};

const KIND_LABELS = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', text: 'Texto', image: 'Imagen', binary: 'Archivo' };

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function formatSize(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addUsage(total, usage) {
  if (!usage) return;
  total.prompt_tokens += Number(usage.prompt_tokens) || 0;
  total.completion_tokens += Number(usage.completion_tokens) || 0;
}

function synthesizeFilesMessage(files) {
  if (files.length === 1) {
    const f = files[0];
    return `Listo: generé **${f.name}**${f.summary ? ` — ${f.summary}` : ''}.`;
  }
  return `Listo: generé ${files.length} archivos:\n${files.map((f) => `- **${f.name}**${f.summary ? ` — ${f.summary}` : ''}`).join('\n')}`;
}

/** Stream visible al usuario: oculta marcado de herramientas y separa pasos. */
function createPipeline(emit, state) {
  let started = false;
  const marker = createMarkerFilter({
    onHidden: (name) => emit('status', name === 'tasky-file'
      ? { phase: 'generating', label: 'Preparando archivo' }
      : { phase: 'generating', label: 'Usando herramientas' }),
  });
  const push = (text) => {
    if (!text) return;
    let out = text;
    if (!started && state.visible && !state.visible.endsWith('\n\n')) out = `\n\n${out.replace(/^\n+/, '')}`;
    started = true;
    state.visible += out;
    emit('delta', { text: out });
  };
  return {
    onEvent(e) {
      if (e.type === 'delta') push(marker.push(e.text));
      else if (e.type === 'reasoning') emit('reasoning', { text: e.text });
      else if (e.type === 'tool_call') emit('status', { phase: e.name === 'read_file' ? 'reading' : 'generating', label: TOOL_LABELS[e.name] ?? 'Trabajando' });
    },
    flush() {
      const rest = marker.flush();
      if (rest && !rest.trimStart().startsWith('{')) push(rest);
    },
  };
}

async function buildUserContent(text, attachments, profile, budgetTokens) {
  const blocks = [];
  const images = [];
  const textual = attachments.filter((a) => kindOf(a.name) !== 'image');
  const perFile = textual.length ? Math.floor(budgetTokens / textual.length) : 0;
  for (const a of attachments) {
    if (kindOf(a.name) === 'image') {
      if (profile.vision && a.size <= IMAGE_MAX_BYTES) {
        try {
          const buf = await fs.readFile(a.abs);
          const mime = a.type?.startsWith('image/') ? a.type : (MIME_BY_EXT[path.extname(a.name).toLowerCase()] ?? 'image/png');
          images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
          blocks.push(`<adjunto nombre="${a.name}">(imagen incluida)</adjunto>`);
          continue;
        } catch { /* se informa abajo */ }
      }
      blocks.push(`<adjunto nombre="${a.name}">(imagen: este modelo no puede verla; pedí al usuario que la describa o elegí un modelo con visión)</adjunto>`);
      continue;
    }
    const content = await extractText(a.abs);
    if (!content.trim()) {
      blocks.push(`<adjunto nombre="${a.name}">(sin texto legible: puede ser un escaneo o un formato no soportado)</adjunto>`);
      continue;
    }
    blocks.push(`<adjunto nombre="${a.name}">\n${truncateToTokens(content, perFile)}\n</adjunto>`);
  }
  const full = blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text;
  return images.length ? [{ type: 'text', text: full }, ...images] : full;
}

async function buildContext({ root, areaId, chatId, areas, profile, now, query, attachments, historyEntries, userText }) {
  const project = await loadProjectContext(root, areaId, areas);
  const compact = profile.contextLength < 12_000;
  const skeleton = buildSystemPrompt({ mode: 'tools', now, project: { projectName: project.projectName, areaName: project.areaName }, sections: {}, compact });
  const budget = planBudget({ contextLength: profile.contextLength, maxOutput: profile.maxOutput, coreTokens: estimateTokens(skeleton) });
  const S = budget.sections;

  project.rules = truncateToTokens(project.rules, Math.floor(S.rules / 2));
  project.customInstructions = truncateToTokens(project.customInstructions, Math.floor(S.rules / 4));
  project.summary = truncateToTokens(project.summary, Math.floor(S.rules / 8));
  project.areaSummary = truncateToTokens(project.areaSummary, Math.floor(S.rules / 8));

  const generatedList = await listGeneratedFiles(root, { areaId, limit: 25 });
  const generated = truncateToTokens(
    generatedList.map((f) => `- ${f.path} — ${f.summary || f.type.toUpperCase()}${f.createdAt ? ` (${shortDate(f.createdAt)})` : ''}`).join('\n'),
    S.generated
  );

  const currentPaths = new Set(attachments.map((a) => a.path));
  const areaFiles = await listAreaContextFiles(root, areaId);
  const uploads = (await listChatUploads(root, areaId, chatId)).filter((f) => !currentPaths.has(f.path));
  const indexed = [
    ...areaFiles.map((f) => ({ ...f, label: KIND_LABELS[kindOf(f.name)], boost: 1 })),
    ...uploads.map((f) => ({ ...f, label: `${KIND_LABELS[kindOf(f.name)]}, adjunto anterior`, boost: 1.3 })),
  ];
  let fileIndex = indexed.slice(0, 60).map((f) => `- ${f.path} (${f.label}, ${formatSize(f.size)})`).join('\n');
  if (indexed.length > 60) fileIndex += `\n- … y ${indexed.length - 60} archivos más`;

  let snippets = '';
  if (indexed.length && S.retrieval > 150) {
    const docs = [];
    for (const f of indexed.slice(0, MAX_INDEXED_FILES)) {
      const text = await extractText(safeJoin(root, f.path));
      if (text.trim()) docs.push({ id: f.path, path: f.path, text, boost: f.boost });
    }
    const total = docs.reduce((acc, d) => acc + estimateTokens(d.text), 0);
    const pieces = total <= S.retrieval * 0.9
      ? docs.map((d) => ({ path: d.path, text: d.text }))
      : search(buildIndex(docs), query, { limit: 16, perDocLimit: 4 });
    const out = [];
    let used = 0;
    for (const piece of pieces) {
      const blockText = `<fragmento archivo="${piece.path}">\n${piece.text}\n</fragmento>`;
      const cost = estimateTokens(blockText);
      if (used + cost > S.retrieval) {
        if (!out.length) out.push(truncateToTokens(blockText, S.retrieval));
        break;
      }
      out.push(blockText);
      used += cost;
    }
    snippets = out.join('\n\n');
  }

  const userContent = await buildUserContent(userText, attachments, profile, S.attachments);
  const summary = await loadSummary(root, areaId, chatId);
  const allHistory = entriesToMessages(historyEntries);

  const sectionsBase = { fileIndex, snippets, generated };
  const systemWithSummary = (mode, withSummary) => buildSystemPrompt({
    mode,
    now,
    project,
    compact,
    sections: { ...sectionsBase, conversationSummary: withSummary && summary ? truncateToTokens(summary.text, 800) : '' },
  });

  const reserve = estimateMessagesTokens([{ role: 'user', content: userContent }]) + 64;
  let historyBudget = budget.input - estimateTokens(systemWithSummary('tools', true)) - reserve;
  let fitted = fitHistory(allHistory, Math.max(0, historyBudget));
  const useSummary = fitted.dropped > 0 && !!summary;
  if (!useSummary) {
    historyBudget = budget.input - estimateTokens(systemWithSummary('tools', false)) - reserve;
    fitted = fitHistory(allHistory, Math.max(0, historyBudget));
  }

  return {
    budget,
    summary,
    dropped: fitted.dropped,
    droppedMessages: allHistory.slice(0, fitted.dropped),
    history: fitted.messages.map(({ role, content }) => ({ role, content })),
    userContent,
    systemFor: (mode) => systemWithSummary(mode, useSummary),
  };
}

async function compactHistory({ root, areaId, chatId, messages, previous }) {
  const transcript = messages.map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`).join('\n\n');
  const r = await chatCompletion({
    stream: false,
    maxTokens: 700,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'Resumí la conversación para que un asistente pueda continuarla sin leerla. Conservá decisiones, datos concretos (cifras, fechas, nombres), archivos generados con su ruta y pedidos pendientes. Máximo 12 viñetas, en español.',
      },
      { role: 'user', content: `${previous ? `Resumen previo:\n${previous}\n\n` : ''}Conversación a resumir:\n${truncateToTokens(transcript, 12_000)}` },
    ],
  });
  const text = r.content.trim();
  if (text) await saveSummary(root, areaId, chatId, { uptoTs: messages.at(-1)?.ts ?? Date.now(), text });
}

/**
 * Ejecuta un turno completo.
 * @param {{root:string, areaId:string, chatId:string, areas:object[], userText?:string,
 *   uploads?:Array<{originalname:string, buffer:Buffer, mimetype?:string}>, regenerate?:boolean,
 *   reasoningEffort?:string (nivel elegido; se valida contra el modelo activo y vale para todos los pasos del turno),
 *   signal?:AbortSignal, emit?:(event:string, data:object)=>void, now?:Date}} p
 * @returns {Promise<object>} registro del asistente persistido
 */
export async function runChat({ root, areaId, chatId, areas, userText = '', uploads = [], regenerate = false, reasoningEffort, signal, emit = () => {}, now = new Date() }) {
  if (!isConfigured()) throw llmError('not_configured', 'Falta configurar la IA', { retriable: false });
  const target = getActive();
  // Antes de guardar nada: un nivel inválido para este modelo se rechaza, no se ignora.
  const effort = await resolveReasoningEffort(target.provider, target.model, reasoningEffort);
  const messageId = nanoid(12);

  let userEntry;
  if (regenerate) {
    const { lastUser } = await truncateAfterLastUser(root, areaId, chatId);
    if (!lastUser) throw llmError('bad_request', 'No hay un mensaje para regenerar', { retriable: false });
    userEntry = lastUser;
  } else {
    const saved = [];
    for (const f of uploads) {
      saved.push(await saveUploadedFile(root, `files/uploads/${areaId}/${chatId}`, f.originalname ?? f.name, f.buffer, f.mimetype));
    }
    userEntry = { id: nanoid(12), ts: Date.now(), role: 'user', content: userText, ...(saved.length ? { attachments: saved } : {}) };
    await appendChatEntry(root, areaId, chatId, userEntry);
  }

  const entries = await readChatLog(root, areaId, chatId);
  let userIdx = entries.length - 1;
  while (userIdx >= 0 && entries[userIdx].role !== 'user') userIdx -= 1;
  const historyEntries = entries.slice(0, Math.max(0, userIdx));
  const attachments = (userEntry.attachments ?? [])
    .filter((a) => a?.path)
    .map((a) => ({ ...a, abs: safeJoin(root, a.path) }));

  const profile = await getModelProfile(target.provider, target.model);
  let mode = profile.tools === false ? 'text' : 'tools';
  const recent = entriesToMessages(historyEntries).filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
  const query = [...recent, userEntry.content, userEntry.content].join('\n');

  emit('start', { messageId, userMessageId: userEntry.id, provider: target.provider, model: target.model, mode });
  emit('status', { phase: 'thinking', label: 'Preparando contexto' });

  const state = { visible: '' };
  const parts = [];
  const files = [];
  const warnings = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let reasoning = '';
  let ctx;

  const toolCtx = {
    root,
    areaId,
    chatId,
    emit: ({ type, ...data }) => emit(type, data),
  };

  try {
    ctx = await buildContext({ root, areaId, chatId, areas, profile, now, query, attachments, historyEntries, userText: userEntry.content });
    let convo = [{ role: 'system', content: ctx.systemFor(mode) }, ...ctx.history, { role: 'user', content: ctx.userContent }];
    let switched = false;
    let nudged = false;

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const last = step === MAX_STEPS - 1;
      const pipe = createPipeline(emit, state);
      emit('status', { phase: 'thinking', label: step === 0 ? 'Pensando' : 'Revisando resultados' });
      let res;
      try {
        res = await chatCompletion({
          messages: convo,
          tools: mode === 'tools' ? TOOL_DEFS : undefined,
          toolChoice: last ? 'none' : 'auto',
          stream: true,
          signal,
          onEvent: pipe.onEvent,
          profile,
          maxTokens: ctx.budget.output,
          target,
          reasoningEffort: effort,
        });
      } catch (err) {
        if (err.kind === 'tools_unsupported' && mode === 'tools' && !switched) {
          switched = true;
          mode = 'text';
          warnings.push('switched_to_text_mode');
          convo = [{ role: 'system', content: ctx.systemFor('text') }, ...ctx.history, { role: 'user', content: ctx.userContent }];
          emit('status', { phase: 'retrying', label: 'Adaptando al modelo' });
          step -= 1;
          continue;
        }
        throw err;
      }
      pipe.flush();
      addUsage(usage, res.usage);
      if (res.reasoning) reasoning += res.reasoning;

      let text = res.content ?? '';
      let calls = res.toolCalls ?? [];
      if (!calls.length) {
        const ex = extractTextToolCalls(text, TOOL_NAMES);
        if (ex.calls.length) {
          calls = ex.calls;
          text = ex.text;
          warnings.push('text_tool_calls');
        }
      }

      if (mode === 'text') {
        const parsed = parseTextModeResponse(text);
        warnings.push(...parsed.warnings);
        const payloads = [
          ...parsed.files,
          ...calls.filter((c) => c.name === 'generate_file').map((c) => parseToolArguments(c.arguments)).filter(Boolean),
        ];
        const failures = [];
        for (const payload of payloads) {
          const r = await executeTool({ id: nanoid(8), name: 'generate_file', arguments: JSON.stringify(payload) }, toolCtx);
          if (r.file) {
            files.push(r.file);
            emit('file', { file: r.file });
          } else {
            failures.push(r.content);
          }
        }
        if (parsed.content.trim()) parts.push(parsed.content.trim());
        if (failures.length) {
          warnings.push('file_generation_failed');
          parts.push('No pude crear el archivo porque su contenido llegó con errores de formato. Probá de nuevo o elegí un modelo con herramientas en el selector.');
        }
        break;
      }

      if (!calls.length) {
        if (!text.trim() && !nudged && !last) {
          nudged = true;
          warnings.push('empty_answer_nudged');
          convo.push({ role: 'user', content: 'Escribí ahora tu respuesta final para el usuario.' });
          continue;
        }
        if (text.trim()) parts.push(text.trim());
        break;
      }

      if (text.trim()) parts.push(text.trim());
      convo.push({ role: 'assistant', content: text || '', tool_calls: calls.map(compactToolCallForReplay) });
      let followUp = false;
      let fatal = false;
      for (const call of calls) {
        const r = await executeTool(call, toolCtx);
        if (r.file) {
          files.push(r.file);
          emit('file', { file: r.file });
        }
        if (!r.ok || call.name === 'read_file') followUp = true;
        if (r.fatal) fatal = true;
        convo.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: r.content });
      }
      if (fatal || !followUp) break;
    }

    let content = parts.join('\n\n').trim();
    if (!content && files.length) content = synthesizeFilesMessage(files);
    if (!content) {
      if (reasoning.trim()) {
        content = reasoning.trim();
        warnings.push('content_from_reasoning');
      } else {
        throw llmError('empty_response', 'El modelo no devolvió texto', { retriable: true });
      }
    }

    const record = {
      id: messageId,
      ts: Date.now(),
      role: 'assistant',
      content,
      meta: { complete: files.length > 0, taskPath: null, summary: files[0]?.summary ?? null },
      file: files[0] ?? null,
      files,
      provider: target.provider,
      model: target.model,
      mode,
      usage,
      ...(warnings.length ? { warnings } : {}),
    };
    await appendChatEntry(root, areaId, chatId, record);
    emit('done', { message: record });

    const lastDropped = ctx.droppedMessages.at(-1);
    if (ctx.dropped > 0 && process.env.TASKY_DISABLE_COMPACTION !== '1'
        && (!ctx.summary || (ctx.summary.uptoTs ?? 0) < (lastDropped?.ts ?? 0))) {
      const pending = ctx.droppedMessages.filter((m) => (m.ts ?? 0) > (ctx.summary?.uptoTs ?? 0));
      compactHistory({ root, areaId, chatId, messages: pending.length ? pending : ctx.droppedMessages, previous: ctx.summary?.text })
        .catch((e) => console.warn(`[CHAT] compactación fallida: ${e?.message ?? e}`));
    }
    return record;
  } catch (err) {
    const partial = state.visible.trim() || parts.join('\n\n').trim();
    const base = { id: messageId, ts: Date.now(), role: 'assistant', provider: target.provider, model: target.model, ...(files.length ? { file: files[0], files } : {}) };
    if (err?.kind === 'aborted') {
      if (partial || files.length) {
        const record = { ...base, content: partial, stopped: true };
        await appendChatEntry(root, areaId, chatId, record).catch(() => {});
        emit('done', { message: record });
        return record;
      }
      throw err;
    }
    const human = humanizeError(err);
    const record = { ...base, content: partial, error: human };
    await appendChatEntry(root, areaId, chatId, record).catch(() => {});
    console.warn(`[CHAT] error kind=${err?.kind ?? 'unknown'} status=${err?.status ?? '-'} ${String(err?.message ?? err).slice(0, 200)}`);
    emit('error', { error: human, kind: err?.kind ?? 'unknown', retriable: human.retriable, message: record });
    throw err;
  }
}
