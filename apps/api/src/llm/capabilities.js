/**
 * llm/capabilities.js — Perfil de capacidades de cada modelo.
 *
 * Fuentes, de menor a mayor prioridad:
 *   1. Heurística por familia (NVIDIA NIM no publica metadata; fallback general).
 *   2. Catálogo de OpenRouter (`/models`: context_length, max_completion_tokens,
 *      supported_parameters, input_modalities), cacheado 1 h.
 *   3. Lo aprendido en caliente (errores 400/404 del proveedor), persistido en
 *      `storage/model-capabilities.json`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getStorageRoot } from '../storage.js';
import { providerConfig } from './providers.js';
import { classifyStatus, llmError } from './errors.js';
import { cachedChatgptCatalog, listChatgptModels, modelInfo } from './responses.js';

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_FAIL_TTL_MS = 2 * 60 * 1000;
const MAX_OUTPUT_CAP = 16384;
const NVIDIA_MAX_OUTPUT = 8192;

const catalogCache = new Map();
let learned = null;

// ---- Heurísticas por familia -------------------------------------------------------

const CONTEXT_RULES = [
  [/128k|131k/, 128000],
  [/32k/, 32768],
  [/\b8k\b/, 8192],
  [/gemma-3|llama-3\.[1-3]|llama3\.[1-3]|llama-4|nemotron|mistral-(large|medium|small|nemo)|mixtral-8x22|codestral|ministral|magistral|pixtral|deepseek|kimi|moonshot|glm-4|glm-5|gpt-oss|command-r|jamba|phi-3\.5|granite-3|minimax/, 128000],
  [/mixtral-8x7b|qwen|qwq/, 32768],
  [/gemma|llama-2|llama2|codellama|phi-3|starcoder|falcon/, 8192],
];
const TOOLS_YES = /llama-3\.[1-3]|llama3\.[1-3]|llama-4|nemotron|mistral|mixtral-8x22|ministral|magistral|codestral|qwen2\.5|qwen3|qwq|deepseek-v3|deepseek-chat|kimi|glm-4\.[5-9]|glm-5|gpt-oss|granite-3|command-r|hermes|minimax/;
const TOOLS_NO = /gemma-2|gemma-7b|gemma-2b|phi-3(?!\.5)|codellama|llama-2|llama2|starcoder|embed|rerank|guard|reward|paligemma/;
const VISION = /vision|[-_/]vl[-_]|[-_]vl$|-vl\b|llava|pixtral|gemma-3|llama-4|phi-4-multimodal|kosmos|neva|vila|internvl|molmo/;
const REASONING = /(^|[-/_])r1([-_.]|$)|reason|think|qwq|magistral|gpt-oss|deepseek-v3\.[1-9]|nemotron.*(super|ultra)/;
const NO_TEMPERATURE = /(^|\/)(o1|o3|o4)(-|$)|gpt-5/;
const NON_CHAT = /embed|rerank|reward|guard|nv-clip|parse|ocr|asr|tts|whisper|riva|detector|safety|retriever|sdxl|stable-diffusion|flux|cosmos|deplot/;

/**
 * Niveles de `reasoning_effort` documentados para los endpoints alojados de NVIDIA
 * (docs.api.nvidia.com/nim/reference/<modelo>-infer). Varían por modelo, así que solo
 * se reconocen IDs exactos: nunca por familia ni por nombre. Un modelo ausente no
 * ofrece selector. `minimaxai/minimax-m3.1-flash` queda fuera hasta confirmar que el
 * endpoint alojado (no solo la guía de autoalojado) acepta `reasoning_effort`.
 */
const NVIDIA_REASONING = new Map([
  ['openai/gpt-oss-20b', { levels: ['low', 'medium', 'high'], default: 'medium' }],
  ['openai/gpt-oss-120b', { levels: ['low', 'medium', 'high'], default: 'medium' }],
  ['nvidia/nemotron-3-super-120b-a12b', { levels: ['none', 'low', 'high'], default: 'high' }],
  ['nvidia/nemotron-3.5-super-vl-120b-a12b', { levels: ['none', 'low', 'high'], default: 'high' }],
  ['meta/muse-glimmer-30b', { levels: ['none', 'minimal', 'low', 'medium', 'high', 'max'], default: 'high' }],
]);

/** Niveles estándar de OpenRouter (`reasoning.effort`) que se ofrecen: el común conservador. */
const OPENROUTER_EFFORTS = ['low', 'medium', 'high'];

function heuristicContext(id) {
  for (const [re, ctx] of CONTEXT_RULES) {
    if (re.test(id)) return ctx;
  }
  return 32768;
}

function heuristicProfile(provider, model) {
  const id = String(model || '').toLowerCase();
  const contextLength = heuristicContext(id);
  const cap = provider === 'nvidia' ? NVIDIA_MAX_OUTPUT : MAX_OUTPUT_CAP;
  const documented = provider === 'nvidia' ? NVIDIA_REASONING.get(model) : undefined;
  return {
    id: model,
    provider,
    name: model,
    contextLength,
    maxOutput: Math.min(cap, Math.floor(contextLength / 4)),
    tools: TOOLS_NO.test(id) ? false : TOOLS_YES.test(id) ? true : null,
    temperature: !NO_TEMPERATURE.test(id),
    reasoning: REASONING.test(id) || !!documented,
    vision: VISION.test(id),
    // Solo los IDs de NVIDIA con niveles documentados; el resto, ninguno.
    reasoningLevels: (documented?.levels ?? []).map((effort) => ({ effort })),
    defaultReasoningLevel: documented?.default ?? null,
    isFree: id.endsWith(':free'),
    source: 'heuristic',
  };
}

/**
 * ChatGPT: el catálogo de la cuenta (`GET /v1/models`) puede declarar ventana de contexto
 * y modalidades; sin ese dato se usan valores conservadores. `max_output_tokens` no se
 * envía en este flujo, así que `maxOutput` solo reserva presupuesto de contexto.
 */
function chatgptProfile(model) {
  const entry = cachedChatgptCatalog().find((m) => m.slug === model);
  const info = entry ? modelInfo(entry) : null;
  const contextLength = info?.contextLength ?? 128000;
  return {
    id: model,
    provider: 'chatgpt',
    name: info?.name ?? model,
    contextLength,
    maxOutput: Math.min(MAX_OUTPUT_CAP, Math.floor(contextLength / 4)),
    tools: true,
    temperature: false,
    reasoning: info?.reasoning ?? false,
    reasoningLevels: info?.reasoningLevels ?? [],
    defaultReasoningLevel: info?.defaultReasoningLevel ?? null,
    vision: info?.vision ?? false,
    isFree: false,
    source: entry ? 'catalog' : 'heuristic',
  };
}

function profileFromCatalog(provider, entry) {
  const params = new Set(entry.supported_parameters ?? []);
  const known = params.size > 0;
  const contextLength = entry.top_provider?.context_length || entry.context_length || 32768;
  const maxCompletion = entry.top_provider?.max_completion_tokens;
  const maxOutput = Math.min(maxCompletion && maxCompletion > 0 ? maxCompletion : Math.floor(contextLength / 4), MAX_OUTPUT_CAP);
  const prompt = Number(entry.pricing?.prompt);
  const completion = Number(entry.pricing?.completion);
  return {
    id: entry.id,
    provider,
    name: entry.name || entry.id,
    contextLength,
    maxOutput,
    tools: known ? params.has('tools') : null,
    temperature: known ? params.has('temperature') : true,
    reasoning: params.has('reasoning') || params.has('include_reasoning') || !!entry.reasoning?.mandatory,
    vision: (entry.architecture?.input_modalities ?? []).includes('image'),
    // Selector solo si el modelo anuncia `reasoning`/`reasoning_effort` (no basta
    // `include_reasoning`, que solo controla si se devuelve el razonamiento). El catálogo
    // no lista niveles por modelo: se ofrecen los estándar comunes; un modelo que rechace
    // uno devuelve el error del proveedor. Sin default conocido → automático.
    reasoningLevels: params.has('reasoning') || params.has('reasoning_effort')
      ? OPENROUTER_EFFORTS.map((effort) => ({ effort }))
      : [],
    defaultReasoningLevel: null,
    isFree: entry.id.endsWith(':free') || (prompt === 0 && completion === 0),
    source: 'catalog',
  };
}

// ---- Catálogo --------------------------------------------------------------------

async function fetchCatalog(provider, { baseUrl, apiKey, fetchImpl }) {
  const key = `${provider}|${baseUrl}`;
  const hit = catalogCache.get(key);
  if (hit) {
    const ttl = hit.error ? CATALOG_FAIL_TTL_MS : CATALOG_TTL_MS;
    if (Date.now() - hit.at < ttl) {
      if (hit.error) throw hit.error;
      return hit.data;
    }
  }
  const doFetch = fetchImpl ?? fetch;
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await doFetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw llmError(classifyStatus(res.status, text), `[${res.status}] ${text.slice(0, 300)}`, { status: res.status });
    }
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    catalogCache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    const e = err?.kind ? err : llmError('network', `No se pudo obtener el catálogo de modelos: ${err?.message ?? err}`);
    catalogCache.set(key, { at: Date.now(), error: e });
    throw e;
  }
}

// ---- Aprendizaje -------------------------------------------------------------------

function learnedPath() {
  return path.join(getStorageRoot(), 'model-capabilities.json');
}

async function loadLearned() {
  if (learned) return learned;
  try {
    learned = JSON.parse(await fs.readFile(learnedPath(), 'utf8')) ?? {};
  } catch {
    learned = {};
  }
  return learned;
}

function applyLearned(profile, all) {
  const entry = all[`${profile.provider}::${profile.id}`];
  if (!entry) return profile;
  const { updatedAt: _ignored, ...patch } = entry;
  return { ...profile, ...patch, learned: true };
}

/**
 * Registra una capacidad aprendida (p. ej. `{ tools: false }`) y la persiste.
 */
export async function learnCapability(provider, model, patch) {
  const all = await loadLearned();
  const key = `${provider}::${model}`;
  all[key] = { ...(all[key] ?? {}), ...patch, updatedAt: new Date().toISOString() };
  try {
    await fs.mkdir(path.dirname(learnedPath()), { recursive: true });
    await fs.writeFile(learnedPath(), JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[LLM] No se pudo persistir capacidad aprendida: ${e?.message ?? e}`);
  }
}

/** Limpia cachés en memoria (el aprendido en disco se conserva). */
export function clearCapabilityCache({ keepLearned = true } = {}) {
  catalogCache.clear();
  if (!keepLearned) learned = null;
}

// ---- API pública ----------------------------------------------------------------------

function resolveTarget(provider, opts) {
  const cfg = providerConfig(provider) ?? {};
  return { baseUrl: opts.baseUrl ?? cfg.baseUrl, apiKey: opts.apiKey ?? cfg.apiKey, fetchImpl: opts.fetchImpl };
}

/**
 * Perfil del modelo: { id, provider, name, contextLength, maxOutput, tools, temperature,
 * reasoning, reasoningLevels, defaultReasoningLevel, vision, isFree, source }.
 * Nunca lanza: sin catálogo usa heurística.
 */
export async function getModelProfile(provider, model, opts = {}) {
  let profile = null;
  if (provider === 'chatgpt') profile = chatgptProfile(model);
  if (provider === 'openrouter') {
    try {
      const list = await fetchCatalog(provider, resolveTarget(provider, opts));
      const entry = list.find((m) => m.id === model);
      if (entry) profile = profileFromCatalog(provider, entry);
    } catch { /* heurística */ }
  }
  if (!profile) profile = heuristicProfile(provider, model);
  return applyLearned(profile, await loadLearned());
}

/**
 * Modelos disponibles con capacidades. Lanza error tipado si el proveedor falla.
 */
export async function listModels(provider, opts = {}) {
  if (provider === 'chatgpt') {
    // Orden del servidor, solo modelos con visibility "list".
    const all = await loadLearned();
    return (await listChatgptModels(opts)).map((m) => {
      const { id, name, isFree, contextLength, tools, vision, reasoning, reasoningLevels, defaultReasoningLevel } = applyLearned({ ...m, provider: 'chatgpt' }, all);
      return { id, name, isFree, contextLength, tools, vision, reasoning, reasoningLevels, defaultReasoningLevel };
    });
  }
  const target = resolveTarget(provider, opts);
  if (!target.apiKey) {
    throw llmError('unauthorized', `Provider ${provider} no configurado`, { status: 401 });
  }
  const all = await loadLearned();
  const list = await fetchCatalog(provider, target);
  let models;
  if (provider === 'openrouter') {
    models = list.map((entry) => profileFromCatalog(provider, entry));
  } else {
    models = list
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' && !NON_CHAT.test(id.toLowerCase()))
      .map((id) => heuristicProfile(provider, id));
  }
  return models
    .map((p) => applyLearned(p, all))
    .map(({ id, name, isFree, contextLength, maxOutput, tools, vision, reasoning, reasoningLevels, defaultReasoningLevel }) => ({
      id, name, isFree, contextLength, maxOutput, tools, vision, reasoning, reasoningLevels, defaultReasoningLevel,
    }))
    .sort((a, b) => (a.isFree !== b.isFree ? (a.isFree ? -1 : 1) : a.id.localeCompare(b.id)));
}

// ---- Nivel de razonamiento elegido por el usuario -------------------------------------------

const EFFORT_RE = /^[\w-]{1,32}$/;

/**
 * Valida el nivel de razonamiento pedido contra el modelo activo.
 * - `undefined`/`null` → `undefined` (automático: no se envía override).
 * - Valor inválido, modelo sin niveles o nivel que el modelo no declara → error
 *   `invalid_reasoning` (nunca se ignora ni se reemplaza por otro nivel).
 * ChatGPT: los niveles salen del catálogo de la cuenta; si el modelo aún no está en
 * memoria se consulta el catálogo antes de decidir.
 * @returns {Promise<string|undefined>}
 */
export async function resolveReasoningEffort(provider, model, effort, opts = {}) {
  if (effort === undefined || effort === null) return undefined;
  if (typeof effort !== 'string' || !EFFORT_RE.test(effort)) {
    throw llmError('invalid_reasoning', 'Nivel de razonamiento inválido', { status: 400, retriable: false });
  }
  let profile = await getModelProfile(provider, model, opts);
  if (provider === 'chatgpt' && profile.source !== 'catalog') {
    await listChatgptModels(opts.chatgpt ?? {});
    profile = await getModelProfile(provider, model, opts);
  }
  const allowed = (profile.reasoningLevels ?? []).map((l) => l.effort);
  if (!allowed.length) {
    throw llmError('invalid_reasoning', `El modelo ${model} no permite elegir el nivel de razonamiento`, { status: 400, retriable: false, allowed });
  }
  if (!allowed.includes(effort)) {
    throw llmError('invalid_reasoning', `El modelo ${model} no admite el nivel "${effort}". Disponibles: ${allowed.join(', ')}`, { status: 400, retriable: false, allowed });
  }
  return effort;
}
