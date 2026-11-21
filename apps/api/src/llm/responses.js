/**
 * llm/responses.js — Cliente de la Responses API para ChatGPT (plan de suscripción).
 *
 * Convierte el formato interno (mensajes estilo Chat Completions + tool calls) a
 * `POST https://api.openai.com/v1/responses` y devuelve el mismo resultado que
 * `chatCompletion` ({content, reasoning, toolCalls, usage, …}), de modo que
 * `chat/service.js` no cambia.
 *
 * Requisitos del flujo (preview-limitations / models-and-inference):
 *   - `store: false` y `stream: true` siempre; `input` es un array con todo el contexto.
 *   - Prompt de sistema → `instructions` (los items `role: "system"` se rechazan).
 *   - Se omiten: background, conversation, max_output_tokens, max_tool_calls, metadata,
 *     moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier,
 *     temperature, top_logprobs, top_p, truncation, user y previous_response_id.
 *   - Herramientas de función agrupadas en un namespace (nunca `tool_search`).
 *   - Éxito solo con `response.completed`; `response.failed`, `response.incomplete`,
 *     errores explícitos y cortes se tratan por separado.
 */

import crypto from 'node:crypto';
import { chatgptAuth, RESOURCE } from './chatgpt-auth.js';
import { classifyStatus, llmError } from './errors.js';

export const NAMESPACE = 'tasky';
const NAMESPACE_DESCRIPTION = 'Herramientas de Tasky para crear, editar y leer archivos del proyecto.';
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** URL base de la API. Solo se acepta otra URL si es loopback (pruebas locales). */
export function apiBaseUrl() {
  const override = process.env.TASKY_CHATGPT_API_BASE_URL;
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return override.replace(/\/+$/, '');
    } catch { /* se ignora */ }
  }
  return RESOURCE;
}

// ---- Conversión: mensajes → Responses `input` -------------------------------------------

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

function userContent(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : contentText(content);
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') parts.push({ type: 'input_text', text: p });
    else if (p?.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (typeof p?.text === 'string') parts.push({ type: 'input_text', text: p.text });
  }
  return parts;
}

/** call_id válido (≤64, [\w-]) y determinista: el mismo id de origen da el mismo resultado. */
function callId(id) {
  const raw = String(id ?? '');
  if (/^[\w-]{1,64}$/.test(raw)) return raw;
  return `call_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

/**
 * @param {object[]} messages mensajes internos (system/user/assistant+tool_calls/tool)
 * @param {string[]} toolNames nombres de las herramientas del namespace
 * @returns {{instructions: string|undefined, input: object[]}}
 */
export function toResponsesInput(messages, toolNames = []) {
  const names = new Set(toolNames);
  const instructions = [];
  const input = [];
  for (const m of messages ?? []) {
    switch (m?.role) {
      case 'system':
      case 'developer': {
        const text = contentText(m.content);
        if (!text) break;
        // Los system iniciales son `instructions`; los posteriores, mensajes developer.
        if (input.length === 0) instructions.push(text);
        else input.push({ role: 'developer', content: text });
        break;
      }
      case 'user':
        input.push({ role: 'user', content: userContent(m.content) });
        break;
      case 'assistant': {
        const text = contentText(m.content);
        if (text) input.push({ role: 'assistant', content: text });
        for (const tc of m.tool_calls ?? []) {
          const fn = tc.function ?? tc;
          if (!fn?.name) continue;
          const args = fn.arguments ?? '{}';
          input.push({
            type: 'function_call',
            call_id: callId(tc.id),
            ...(names.has(fn.name) ? { namespace: NAMESPACE } : {}),
            name: fn.name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          });
        }
        break;
      }
      case 'tool':
        input.push({ type: 'function_call_output', call_id: callId(m.tool_call_id), output: contentText(m.content) });
        break;
      default:
        break;
    }
  }
  return { instructions: instructions.length ? instructions.join('\n\n') : undefined, input };
}

/** Herramientas internas (`{type:'function', function:{…}}`) → un namespace de Responses. */
export function toResponsesTools(tools) {
  const list = (tools ?? [])
    .map((t) => t?.function ?? t)
    .filter((f) => f?.name)
    .map((f) => ({
      type: 'function',
      name: f.name,
      description: f.description ?? '',
      parameters: f.parameters ?? { type: 'object', properties: {} },
      // Responses usa strict=true por defecto; nuestros esquemas son JSON Schema abierto.
      strict: false,
    }));
  if (!list.length) return undefined;
  return [{ type: 'namespace', name: NAMESPACE, description: NAMESPACE_DESCRIPTION, tools: list }];
}

function toToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  const name = toolChoice.function?.name ?? toolChoice.name;
  return name ? { type: 'function', name, namespace: NAMESPACE } : undefined;
}

/** Arma el cuerpo de la solicitud: solo campos admitidos por el flujo. */
export function buildRequestBody({ model, messages, tools, toolChoice, reasoningEffort }) {
  const toolNames = (tools ?? []).map((t) => (t?.function ?? t)?.name).filter(Boolean);
  const { instructions, input } = toResponsesInput(messages, toolNames);
  const body = { model, input, store: false, stream: true };
  if (instructions) body.instructions = instructions;
  // Solo con elección explícita: sin ella, el modelo usa su nivel por defecto.
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  const rTools = toResponsesTools(tools);
  if (rTools) {
    body.tools = rTools;
    const choice = toToolChoice(toolChoice);
    if (choice) body.tool_choice = choice;
  }
  return body;
}

// ---- Errores -----------------------------------------------------------------------------

/** Código estructurado de Responses → kind interno (errors-and-recovery). */
const KIND_BY_CODE = {
  subscription_sharing_user_not_eligible: 'chatgpt_not_eligible',
  subscription_sharing_usage_limit_exceeded: 'chatgpt_usage_limit',
  subscription_sharing_usage_unavailable: 'unavailable',
  subscription_sharing_unsupported_capability: 'chatgpt_unsupported',
  subscription_sharing_route_not_supported: 'chatgpt_route',
  subscription_sharing_invalid_user: 'chatgpt_unauthorized',
  chatpass_v2_scope_not_authorized: 'chatgpt_denied',
  chatpass_v2_invalid_authorization_context: 'chatgpt_denied',
  subscription_sharing_user_unavailable: 'unavailable',
};

const STATUS_BY_CODE = {
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
  subscription_sharing_user_unavailable: 503,
};

function requestIdOf(headers) {
  return headers?.get?.('x-request-id') ?? headers?.get?.('openai-request-id') ?? null;
}

/**
 * Error de la API → Error tipado. Conserva status HTTP, código, param, request ID
 * y el cuerpo tal cual (puede ser `{error:{…}}` o `{detail}`).
 */
export function responsesError({ status, body, headers, errorObject, partialContent }) {
  let parsed = null;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* texto plano */ }
  const err = errorObject ?? parsed?.error ?? null;
  const code = typeof err === 'object' && err ? (err.code ?? null) : null;
  const param = typeof err === 'object' && err ? (err.param ?? null) : null;
  const detail = parsed?.detail;
  const message = (typeof err === 'object' && err?.message) || (typeof err === 'string' ? err : null)
    || (typeof detail === 'string' ? detail : null) || (typeof body === 'string' ? body : '') || 'Error de ChatGPT';
  const effectiveStatus = status ?? STATUS_BY_CODE[code] ?? 502;
  let kind = KIND_BY_CODE[code];
  if (!kind) {
    if (effectiveStatus === 401) kind = 'chatgpt_unauthorized';
    else if (effectiveStatus === 403) kind = 'chatgpt_forbidden';
    else kind = classifyStatus(effectiveStatus, `${typeof body === 'string' ? body : ''} ${message}`);
  }
  const retryAfter = headers?.get?.('retry-after');
  return llmError(kind, `[${effectiveStatus}] ${String(message).slice(0, 500)}`, {
    status: effectiveStatus,
    code,
    param,
    requestId: requestIdOf(headers),
    body: typeof body === 'string' ? body : JSON.stringify(body ?? null),
    retryAfter: retryAfter != null && retryAfter !== '' ? Number(retryAfter) : null,
    ...(partialContent ? { partialContent } : {}),
  });
}

// ---- Stream SSE ---------------------------------------------------------------------------

function resolveToolName(name, toolNames) {
  if (!name || !toolNames.length || toolNames.includes(name)) return name;
  for (const sep of [`${NAMESPACE}.`, `${NAMESPACE}__`, `${NAMESPACE}/`]) {
    if (name.startsWith(sep) && toolNames.includes(name.slice(sep.length))) return name.slice(sep.length);
  }
  return name;
}

async function readResponseStream(res, { onEvent, onActivity, state, toolNames, requestId }) {
  const decoder = new TextDecoder();
  const acc = { content: '', reasoning: '', refusal: '', usage: null, model: null };
  const calls = new Map(); // output_index → llamada
  let completed = false;
  let buffer = '';

  const emit = (event) => {
    if (event.type === 'delta' || event.type === 'reasoning' || event.type === 'tool_call') state.emitted = true;
    onEvent?.(event);
  };
  const callAt = (index, seed = {}) => {
    const key = Number.isInteger(index) ? index : calls.size;
    const prev = calls.get(key) ?? { id: '', name: '', arguments: '', itemId: null };
    const next = { ...prev, ...Object.fromEntries(Object.entries(seed).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
    calls.set(key, next);
    return [key, next];
  };
  const fail = (event) => {
    const r = event.response ?? {};
    throw responsesError({
      status: undefined,
      body: JSON.stringify({ error: r.error ?? event.error ?? { message: event.message, code: event.code, param: event.param } }),
      headers: { get: (h) => (h === 'x-request-id' ? requestId : null) },
      errorObject: r.error ?? event.error ?? { message: event.message, code: event.code, param: event.param },
      partialContent: acc.content,
    });
  };

  const handle = (ev) => {
    switch (ev.type) {
      case 'response.output_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) {
          acc.content += ev.delta;
          emit({ type: 'delta', text: ev.delta });
        }
        break;
      case 'response.refusal.delta':
        if (typeof ev.delta === 'string') acc.refusal += ev.delta;
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) {
          acc.reasoning += ev.delta;
          emit({ type: 'reasoning', text: ev.delta });
        }
        break;
      case 'response.output_item.added': {
        const item = ev.item;
        if (item?.type === 'function_call') {
          const name = resolveToolName(item.name, toolNames);
          const [key, call] = callAt(ev.output_index, { id: item.call_id, name, itemId: item.id, arguments: item.arguments });
          emit({ type: 'tool_call', index: key, name: call.name });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const key = [...calls.entries()].find(([k, c]) => (ev.output_index !== undefined ? k === ev.output_index : c.itemId === ev.item_id))?.[0];
        if (key !== undefined && typeof ev.delta === 'string') calls.get(key).arguments += ev.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const key = [...calls.entries()].find(([k, c]) => (ev.output_index !== undefined ? k === ev.output_index : c.itemId === ev.item_id))?.[0];
        if (key !== undefined && typeof ev.arguments === 'string') calls.get(key).arguments = ev.arguments;
        break;
      }
      case 'response.output_item.done': {
        const item = ev.item;
        if (item?.type === 'function_call') {
          const [, call] = callAt(ev.output_index, { id: item.call_id, name: resolveToolName(item.name, toolNames), itemId: item.id });
          if (typeof item.arguments === 'string') call.arguments = item.arguments;
        }
        break;
      }
      case 'response.completed': {
        completed = true;
        const r = ev.response ?? {};
        acc.model ||= r.model ?? null;
        if (r.usage) acc.usage = { prompt_tokens: r.usage.input_tokens ?? 0, completion_tokens: r.usage.output_tokens ?? 0, ...r.usage };
        // Reconciliación si el stream no trajo los items parciales.
        if (!calls.size) {
          (r.output ?? []).filter((o) => o?.type === 'function_call').forEach((o, i) => {
            callAt(i, { id: o.call_id, name: resolveToolName(o.name, toolNames), arguments: o.arguments ?? '{}', itemId: o.id });
          });
        }
        if (!acc.content) {
          const text = (r.output ?? [])
            .filter((o) => o?.type === 'message')
            .flatMap((o) => o.content ?? [])
            .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('');
          if (text) {
            acc.content = text;
            emit({ type: 'delta', text });
          }
        }
        break;
      }
      case 'response.failed':
      case 'error':
        fail(ev);
        break;
      case 'response.incomplete': {
        const reason = ev.response?.incomplete_details?.reason ?? 'unknown';
        throw llmError('chatgpt_incomplete', `[stream] respuesta incompleta (${reason})`, {
          code: String(reason),
          requestId,
          retriable: false,
          partialContent: acc.content,
        });
      }
      default:
        break;
    }
  };

  const feed = (block) => {
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data += `${data ? '\n' : ''}${line.slice(5).replace(/^ /, '')}`;
    }
    data = data.trim();
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev && typeof ev === 'object') handle(ev);
  };

  for await (const chunk of res.body) {
    onActivity();
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      feed(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) feed(buffer.replace(/\r\n/g, '\n'));

  if (!completed) {
    throw llmError('interrupted', 'La respuesta de ChatGPT terminó sin response.completed', { requestId, partialContent: acc.content });
  }
  if (!acc.content && acc.refusal) {
    acc.content = acc.refusal;
    emit({ type: 'delta', text: acc.refusal });
  }
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c], i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' }))
    .filter((c) => c.name);
  return { ...acc, toolCalls };
}

// ---- Solicitud ----------------------------------------------------------------------------

async function attemptOnce({ body, token, signal, onEvent, state, toolNames, fetchImpl }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw llmError('aborted', 'Solicitud cancelada', { retriable: false });
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const idleMs = Number(process.env.TASKY_LLM_IDLE_MS ?? 120_000);
  let idleTimer = null;
  let idleFired = false;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      controller.abort();
    }, idleMs);
  };
  touch();
  try {
    const res = await fetchImpl(`${apiBaseUrl()}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    const requestId = requestIdOf(res.headers);
    if (!res.ok) throw responsesError({ status: res.status, body: await res.text().catch(() => ''), headers: res.headers });
    const contentType = res.headers.get('content-type');
    if (contentType && !contentType.toLowerCase().includes('text/event-stream')) {
      throw llmError('bad_gateway', 'ChatGPT no respondió con un stream de eventos', { status: res.status, requestId });
    }
    const acc = await readResponseStream(res, { onEvent, onActivity: touch, state, toolNames, requestId });
    return { ...acc, requestId };
  } catch (e) {
    if (signal?.aborted) throw llmError('aborted', 'Solicitud cancelada', { retriable: false, partialContent: e?.partialContent });
    if (idleFired) throw llmError('timeout', 'El modelo dejó de responder', { retriable: !state.emitted });
    if (e?.kind) throw e;
    const code = e?.cause?.code ?? e?.code;
    throw llmError('network', `No se pudo conectar con ChatGPT (${code ?? e?.message ?? e})`, { retriable: true });
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function retryDelay(err, attempt) {
  const after = Number(err?.retryAfter);
  if (Number.isFinite(after) && after >= 0 && err?.retryAfter !== null) return Math.min(after * 1000, 20_000);
  const base = Number(process.env.TASKY_RETRY_BASE_MS ?? 800);
  return Math.min(base * 2 ** attempt + Math.floor(Math.random() * Math.min(250, base)), 8000);
}

/**
 * Inferencia con el plan de ChatGPT. Misma forma de resultado que `chatCompletion`.
 * @param {{messages: object[], tools?: object[], toolChoice?: string|object, signal?: AbortSignal,
 *   onEvent?: Function, target: {model: string}, reasoningEffort?: string}} opts
 * @param {{auth?: typeof chatgptAuth, fetchImpl?: typeof fetch}} [deps]
 */
export async function responsesCompletion({ messages, tools, toolChoice = 'auto', signal, onEvent, target, reasoningEffort }, deps = {}) {
  const auth = deps.auth ?? chatgptAuth;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!target?.model) {
    throw llmError('not_configured', 'Elegí un modelo de ChatGPT en el selector de modelos.', { retriable: false });
  }
  const body = buildRequestBody({ model: target.model, messages, tools, toolChoice, reasoningEffort });
  const toolNames = (tools ?? []).map((t) => (t?.function ?? t)?.name).filter(Boolean);
  const state = { emitted: false };
  let retries = 0;
  let refreshedAfter401 = false;
  let token = await auth.getAccessToken();

  for (;;) {
    try {
      const out = await attemptOnce({ body, token, signal, onEvent, state, toolNames, fetchImpl });
      console.log(
        `[LLM] ok provider=chatgpt model=${target.model} in=${out.usage?.prompt_tokens ?? '?'} out=${out.usage?.completion_tokens ?? '?'} `
        + `tools=${out.toolCalls.length}${out.requestId ? ` req=${out.requestId}` : ''}`
      );
      return {
        content: out.content,
        reasoning: out.reasoning,
        toolCalls: out.toolCalls,
        finishReason: out.toolCalls.length ? 'tool_calls' : 'stop',
        usage: out.usage,
        model: out.model,
        generationId: out.requestId,
      };
    } catch (err) {
      if (err.kind === 'aborted' || state.emitted) throw err;
      if (err.status === 401 && !refreshedAfter401 && err.kind !== 'chatgpt_reauth_required') {
        // El token pudo vencer antes de lo previsto: una renovación y un reintento.
        refreshedAfter401 = true;
        token = await auth.getAccessToken({ staleToken: token });
        continue;
      }
      if (err.retriable && retries < MAX_RETRIES) {
        const delay = retryDelay(err, retries);
        retries += 1;
        console.warn(`[LLM] retry ${retries}/${MAX_RETRIES} provider=chatgpt kind=${err.kind} status=${err.status ?? '-'} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.warn(`[LLM] err provider=chatgpt kind=${err.kind} status=${err.status ?? '-'} code=${err.code ?? '-'}${err.requestId ? ` req=${err.requestId}` : ''}`);
      throw err;
    }
  }
}

// ---- Catálogo de modelos ----------------------------------------------------------------------

let catalog = { key: null, at: 0, models: [] };

/** Entradas crudas del último catálogo (para derivar capacidades sin red). */
export function cachedChatgptCatalog() {
  return catalog.models;
}

export function clearChatgptCatalog() {
  catalog = { key: null, at: 0, models: [] };
}

/**
 * `GET /v1/models` con el token de la cuenta activa. Conserva el orden del servidor y
 * solo muestra `visibility: "list"`.
 * @returns {Promise<Array<{id:string,name:string,isFree:boolean,contextLength?:number,tools:boolean,vision:boolean,reasoning:boolean}>>}
 */
export async function listChatgptModels(deps = {}) {
  const auth = deps.auth ?? chatgptAuth;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let token = await auth.getAccessToken();
  let refreshed = false;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(`${apiBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch (e) {
      throw llmError('network', `No se pudo obtener los modelos de ChatGPT (${e?.cause?.code ?? e?.message ?? e})`, { retriable: true });
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await auth.getAccessToken({ staleToken: token });
      continue;
    }
    if (!res.ok) throw responsesError({ status: res.status, body: await res.text().catch(() => ''), headers: res.headers });
    let json;
    try { json = await res.json(); } catch { throw llmError('bad_gateway', 'Catálogo de modelos inválido'); }
    if (!Array.isArray(json?.models)) throw llmError('bad_gateway', 'Catálogo de modelos inválido');
    const entries = json.models.filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list');
    catalog = { key: auth.activeAccountKey?.() ?? null, at: Date.now(), models: entries };
    return entries.map(modelInfo);
  }
}

const EFFORT_RE = /^[\w-]{1,32}$/;

/**
 * `supported_reasoning_levels` del catálogo → `[{effort, description?}]` en el orden del
 * servidor. Acepta objetos `{effort, description}` o strings; descarta lo que no sea un
 * valor utilizable y los duplicados. Sin datos devuelve `[]` (no se inventan niveles).
 */
export function parseReasoningLevels(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const effort = typeof item === 'string' ? item : item?.effort;
    if (typeof effort !== 'string' || !EFFORT_RE.test(effort) || seen.has(effort)) continue;
    seen.add(effort);
    const description = typeof item === 'object' && typeof item?.description === 'string' ? item.description : undefined;
    out.push(description ? { effort, description } : { effort });
  }
  return out;
}

/** Capacidades declaradas por el catálogo cuando existen; si no, valores conservadores. */
export function modelInfo(m) {
  const modalities = Array.isArray(m.input_modalities) ? m.input_modalities : null;
  const ctx = Number(m.context_window ?? m.max_context_window);
  const reasoningLevels = parseReasoningLevels(m.supported_reasoning_levels);
  const def = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null;
  return {
    id: m.slug,
    name: m.display_name || m.slug,
    isFree: false,
    ...(Number.isFinite(ctx) && ctx > 0 ? { contextLength: ctx } : {}),
    tools: true,
    vision: !!modalities?.includes('image'),
    reasoning: reasoningLevels.length > 0,
    reasoningLevels,
    defaultReasoningLevel: def && reasoningLevels.some((l) => l.effort === def) ? def : null,
  };
}
