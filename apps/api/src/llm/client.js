/**
 * llm/client.js — Chat completions OpenAI-compatible (OpenRouter / NVIDIA NIM)
 * con streaming SSE, normalización de salidas y reintentos adaptativos.
 *
 * Adaptación en caliente (y aprendizaje persistido por modelo):
 *   - `temperature` no soportada          → se omite
 *   - `max_tokens` / contexto excedido    → se reduce según el mensaje del proveedor
 *   - 402 "can only afford N"              → se reintenta con menos tokens
 *   - tools no soportadas                  → error `tools_unsupported` (el caller
 *                                            cambia al protocolo de texto)
 *   - 429 / 5xx / red                      → hasta 2 reintentos con backoff
 * Una vez que se transmitió texto al cliente no se reintenta (evita duplicados).
 */

import { getActive } from './providers.js';
import { getModelProfile, learnCapability } from './capabilities.js';
import { classifyStatus, llmError } from './errors.js';
import { createThinkFilter, stripThink } from './normalize.js';
import { responsesCompletion } from './responses.js';

const MAX_RETRIES = 2;
const MAX_ATTEMPTS = 7;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(err, attempt) {
  const after = Number(err?.retryAfter);
  if (Number.isFinite(after) && after >= 0 && err?.retryAfter !== null) return Math.min(after * 1000, 20_000);
  const base = Number(process.env.TASKY_RETRY_BASE_MS ?? 800);
  return Math.min(base * 2 ** attempt + Math.floor(Math.random() * Math.min(250, base)), 8000);
}

function buildHeaders(target) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    Authorization: `Bearer ${target.apiKey}`,
  };
  if (target.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL ?? 'http://localhost:3000';
    headers['X-Title'] = 'Tasky';
  }
  return headers;
}

function errorFromBody(status, text, headers) {
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j?.error?.message ?? j?.message ?? j?.detail ?? text;
    const raw = j?.error?.metadata?.raw;
    if (raw && typeof raw === 'string') message += ` ${raw}`;
  } catch { /* texto plano */ }
  const kind = classifyStatus(status, `${text} ${message}`);
  let provider = null;
  try { provider = JSON.parse(text)?.error?.metadata?.provider_name ?? null; } catch { /* sin metadata */ }
  const retryAfter = headers?.get?.('retry-after');
  return llmError(kind, `[${status}] ${String(message).slice(0, 500)}`, {
    status,
    body: text,
    provider,
    retryAfter: retryAfter != null && retryAfter !== '' ? Number(retryAfter) : null,
    generationId: headers?.get?.('x-generation-id') ?? null,
  });
}

/** Límite de salida sugerido por el mensaje de error, o null. */
export function parseTokenLimit(text, current) {
  const body = String(text || '');
  const ctx = body.match(/maximum context length is (\d+)[\s\S]*?\((\d+) in the messages/i);
  if (ctx) return Math.max(0, Number(ctx[1]) - Number(ctx[2]) - 64);
  const direct = body.match(/max_(?:completion_)?tokens[^0-9]{0,80}?(?:<=|less than or equal to|at most|maximum(?: value)?(?: is| of)?|up to|cannot exceed|must be ≤)\s*(\d+)/i)
    ?? body.match(/(?:maximum|max) (?:output|completion) tokens?(?: is| of)?\s*(\d+)/i)
    ?? body.match(/supports? (?:at most|up to) (\d+) (?:output |completion )?tokens/i);
  if (direct) {
    const n = Number(direct[1]);
    if (n > 0 && (!current || n < current)) return n;
  }
  return null;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

function normalizeToolCalls(list) {
  return (list ?? [])
    .map((tc, i) => {
      const fn = tc.function ?? tc;
      const args = fn.arguments ?? fn.parameters ?? '{}';
      return {
        id: tc.id || `call_${i}`,
        name: fn.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      };
    })
    .filter((tc) => tc.name);
}

function fromMessage(data, onEvent) {
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const split = stripThink(contentText(msg.content));
  const reasoning = [msg.reasoning, msg.reasoning_content, split.reasoning].filter((x) => typeof x === 'string' && x).join('\n');
  const toolCalls = normalizeToolCalls(msg.tool_calls);
  if (!toolCalls.length && msg.function_call?.name) {
    toolCalls.push({ id: 'call_0', name: msg.function_call.name, arguments: msg.function_call.arguments ?? '{}' });
  }
  if (onEvent) {
    if (reasoning) onEvent({ type: 'reasoning', text: reasoning });
    for (const tc of toolCalls) onEvent({ type: 'tool_call', index: 0, name: tc.name });
    if (split.content) onEvent({ type: 'delta', text: split.content });
  }
  return {
    content: split.content,
    reasoning,
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    usage: data?.usage ?? null,
    model: data?.model ?? null,
    raw: data,
  };
}

async function readStream(res, { onEvent, onActivity, state }) {
  const decoder = new TextDecoder();
  const think = createThinkFilter();
  const acc = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, model: null };
  let buffer = '';

  const emit = (event) => {
    if (event.type === 'delta' || event.type === 'reasoning' || event.type === 'tool_call') state.emitted = true;
    onEvent?.(event);
  };
  const pushContent = (text) => {
    const out = think.push(text);
    if (out.reasoning) {
      acc.reasoning += out.reasoning;
      emit({ type: 'reasoning', text: out.reasoning });
    }
    if (out.content) {
      acc.content += out.content;
      emit({ type: 'delta', text: out.content });
    }
  };

  const handle = (json) => {
    if (json.error) {
      const code = Number(json.error.code);
      const status = Number.isInteger(code) && code >= 400 ? code : 502;
      throw llmError(classifyStatus(status, JSON.stringify(json.error)), `[stream] ${json.error.message ?? 'error'}`, {
        status,
        body: JSON.stringify(json.error),
        partialContent: acc.content,
      });
    }
    acc.model ||= json.model ?? null;
    if (json.usage) acc.usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? choice.message ?? {};
    for (const field of ['reasoning', 'reasoning_content']) {
      if (typeof delta[field] === 'string' && delta[field]) {
        acc.reasoning += delta[field];
        emit({ type: 'reasoning', text: delta[field] });
      }
    }
    const text = contentText(delta.content);
    if (text) pushContent(text);
    for (const tc of delta.tool_calls ?? []) {
      const idx = Number.isInteger(tc.index) ? tc.index : acc.toolCalls.length;
      const entry = acc.toolCalls[idx] ?? (acc.toolCalls[idx] = { id: '', name: '', arguments: '' });
      if (tc.id) entry.id = tc.id;
      const fn = tc.function ?? {};
      if (fn.name) {
        const isNew = !entry.name;
        entry.name = entry.name && entry.name !== fn.name ? entry.name + fn.name : fn.name;
        if (isNew) emit({ type: 'tool_call', index: idx, name: entry.name });
      }
      if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') entry.arguments = JSON.stringify(fn.arguments);
    }
    if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  };

  for await (const chunk of res.body) {
    onActivity();
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      handle(json);
    }
  }
  const rest = think.flush();
  if (rest.reasoning) {
    acc.reasoning += rest.reasoning;
    emit({ type: 'reasoning', text: rest.reasoning });
  }
  if (rest.content) {
    acc.content += rest.content;
    emit({ type: 'delta', text: rest.content });
  }
  acc.toolCalls = acc.toolCalls
    .filter((tc) => tc && tc.name)
    .map((tc, i) => ({ id: tc.id || `call_${i}`, name: tc.name, arguments: tc.arguments || '{}' }));
  return acc;
}

async function attemptOnce(target, body, { signal, onEvent, state }) {
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
    const res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(target),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw errorFromBody(res.status, text, res.headers);
    }
    const generationId = res.headers.get('x-generation-id');
    const type = res.headers.get('content-type') ?? '';
    if (body.stream && type.includes('text/event-stream')) {
      const acc = await readStream(res, { onEvent, onActivity: touch, state });
      return { ...acc, generationId };
    }
    const data = await res.json();
    if (data?.error && !data?.choices) {
      throw errorFromBody(Number(data.error.code) || 502, JSON.stringify(data), res.headers);
    }
    const out = fromMessage(data, body.stream ? (e) => { state.emitted = true; onEvent?.(e); } : null);
    return { ...out, generationId: generationId ?? data?.id ?? null };
  } catch (e) {
    if (signal?.aborted) throw llmError('aborted', 'Solicitud cancelada', { retriable: false, partialContent: e?.partialContent });
    if (idleFired) throw llmError('timeout', 'El modelo dejó de responder', { retriable: !state.emitted });
    if (e?.kind) throw e;
    const code = e?.cause?.code ?? e?.code;
    throw llmError('network', `No se pudo conectar con ${target.label ?? target.provider} (${code ?? e?.message ?? e})`, { retriable: true });
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {{
 *   messages: object[], tools?: object[], toolChoice?: string|object, stream?: boolean,
 *   signal?: AbortSignal, onEvent?: (e: {type: string, text?: string, name?: string}) => void,
 *   profile?: object, temperature?: number, maxTokens?: number, reasoningEffort?: string,
 *   target?: {provider: string, baseUrl: string, apiKey: string, model: string, label?: string}
 * }} opts
 * @returns {Promise<{content: string, reasoning: string, toolCalls: Array<{id:string,name:string,arguments:string}>,
 *   finishReason: string|null, usage: object|null, model: string|null, generationId: string|null}>}
 */
export async function chatCompletion({
  messages,
  tools,
  toolChoice = 'auto',
  stream = false,
  signal,
  onEvent,
  profile,
  temperature = 0.3,
  maxTokens,
  target,
  reasoningEffort,
} = {}) {
  const t = target ?? getActive();
  // ChatGPT usa la Responses API con OAuth (siempre stream, sin temperature/max tokens).
  if (t?.provider === 'chatgpt') return responsesCompletion({ messages, tools, toolChoice, signal, onEvent, target: t, reasoningEffort });
  if (!t?.apiKey || !t?.provider || t.provider === 'none') {
    throw llmError('not_configured', 'API key no configurada. Configurala desde el selector de modelos.', { retriable: false });
  }
  const prof = profile ?? await getModelProfile(t.provider, t.model);

  const body = {
    model: t.model,
    messages,
    max_tokens: Math.max(256, Math.floor(maxTokens ?? prof.maxOutput ?? 4096)),
    stream: !!stream,
  };
  if (prof.temperature !== false && typeof temperature === 'number') body.temperature = temperature;
  if (tools?.length && prof.tools !== false) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  // Elección explícita: solo con niveles declarados por el modelo y sin degradarla luego.
  const explicitEffort = reasoningEffort ?? null;
  if (explicitEffort !== null) {
    const allowed = (prof.reasoningLevels ?? []).map((l) => l.effort);
    if (!allowed.includes(explicitEffort)) {
      throw llmError('invalid_reasoning', `El modelo ${t.model} no admite el nivel de razonamiento "${explicitEffort}"`, { status: 400, retriable: false, allowed });
    }
    // OpenRouter: objeto `reasoning`; NVIDIA alojado: `reasoning_effort` de primer nivel.
    if (t.provider === 'openrouter') body.reasoning = { effort: explicitEffort };
    else body.reasoning_effort = explicitEffort;
  } else if (t.provider === 'openrouter' && prof.reasoning) {
    body.reasoning = { effort: 'low' };
  }
  if (stream) {
    if (t.provider === 'openrouter') body.usage = { include: true };
    else body.stream_options = { include_usage: true };
  }

  const state = { emitted: false };
  let retries = 0;
  let lastErr = null;
  const learn = (patch) => learnCapability(t.provider, t.model, patch).catch(() => {});

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const out = await attemptOnce(t, body, { signal, onEvent, state });
      const u = out.usage;
      console.log(
        `[LLM] ok provider=${t.provider} model=${t.model} stream=${body.stream} in=${u?.prompt_tokens ?? '?'} out=${u?.completion_tokens ?? '?'} ` +
        `finish=${out.finishReason ?? '-'} tools=${out.toolCalls.length}${out.generationId ? ` gen=${out.generationId}` : ''}`
      );
      return out;
    } catch (err) {
      lastErr = err;
      if (err.kind === 'aborted' || state.emitted) throw err;
      const text = `${err.body ?? ''} ${err.message ?? ''}`;

      if (body.tools && err.kind === 'tools_unsupported') {
        await learn({ tools: false });
        throw err;
      }
      if ('temperature' in body && [400, 422].includes(err.status) && /temperature/i.test(text)) {
        delete body.temperature;
        await learn({ temperature: false });
        continue;
      }
      if (explicitEffort === null && body.reasoning && [400, 422].includes(err.status) && /reasoning/i.test(text)) {
        delete body.reasoning;
        continue;
      }
      if ((body.stream_options || body.usage) && [400, 422].includes(err.status) && /stream_options|usage/i.test(text)) {
        delete body.stream_options;
        delete body.usage;
        continue;
      }
      if ([400, 413, 422].includes(err.status) && /max_tokens|max_completion_tokens|maximum.{0,20}tokens|context length|context window/i.test(text)) {
        const limit = parseTokenLimit(text, body.max_tokens);
        if (limit && limit >= 256 && limit < body.max_tokens) {
          body.max_tokens = limit;
          if (!/context length/i.test(text)) await learn({ maxOutput: limit });
          continue;
        }
        const half = Math.floor(body.max_tokens / 2);
        if (half >= 1024) {
          body.max_tokens = half;
          await learn({ maxOutput: half });
          continue;
        }
      }
      if (err.status === 402) {
        const m = /can only afford (\d+)/i.exec(text);
        const n = m ? Number(m[1]) - 32 : 0;
        if (n >= 512 && n < body.max_tokens) {
          body.max_tokens = n;
          continue;
        }
      }
      if (err.retriable && retries < MAX_RETRIES) {
        const delay = retryDelay(err, retries);
        retries += 1;
        console.warn(`[LLM] retry ${retries}/${MAX_RETRIES} model=${t.model} kind=${err.kind} status=${err.status ?? '-'} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.warn(`[LLM] err model=${t.model} kind=${err.kind} status=${err.status ?? '-'} ${String(err.message).slice(0, 200)}`);
      throw err;
    }
  }
  throw lastErr ?? llmError('unknown', 'No se obtuvo respuesta del modelo');
}
