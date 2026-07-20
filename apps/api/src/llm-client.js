/**
 * llm-client.js — Cliente LLM unificado (OpenRouter / NVIDIA NIM)
 *
 * Encapsula toda la comunicación con el endpoint de chat completions
 * (formato OpenAI-compatible) para ambos proveedores.
 *
 * Detección inicial (al cargar el módulo):
 *   1. Si hay API key de OpenRouter (env o user-config) → disponible
 *   2. Si hay API key de NVIDIA    (env o user-config) → disponible
 *   3. Provider activo = getProvider() de user-config, o 'openrouter' por defecto
 *
 * Variables de entorno:
 *   MODEL               — Modelo por defecto
 *   OPENROUTER_BASE_URL — URL base OpenRouter (default: https://openrouter.ai/api/v1)
 *   OPENROUTER_API_KEY  — Clave OpenRouter (env, fallback a user-config)
 *   NVIDIA_BASE_URL     — URL base NVIDIA NIM (default: https://integrate.api.nvidia.com/v1)
 *   NVIDIA_API_KEY      — Clave NVIDIA NIM  (env, fallback a user-config)
 *   APP_URL             — URL de la app para attribution en OpenRouter (opcional)
 */

import 'dotenv/config';
import {
  getApiKey,
  getNvidiaApiKey,
  getModel,
  getProvider,
  saveUserConfig,
} from './config.js';

/* ==========================================================
   Utilidades
   ========================================================== */

function isRealKey(key) {
  return key && !/your_.*_key_here/i.test(key);
}

/* ==========================================================
   Configuración de proveedores
   ========================================================== */

const DEFAULT_MODELS = {
  openrouter: 'openai/gpt-oss-120b:free',
  nvidia: 'meta/llama-3.1-405b-instruct',
};

const envOpenRouterKey = isRealKey(process.env.OPENROUTER_API_KEY) ? process.env.OPENROUTER_API_KEY : null;
const envNvidiaKey = isRealKey(process.env.NVIDIA_API_KEY) ? process.env.NVIDIA_API_KEY : null;

const userOpenRouterKey = getApiKey();
const userNvidiaKey = getNvidiaApiKey();
const userModel = getModel();
const userProviderPref = getProvider();

const CONFIG = {
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    apiKey: userOpenRouterKey || envOpenRouterKey || null,
    model: userModel ?? process.env.MODEL ?? DEFAULT_MODELS.openrouter,
    label: 'OpenRouter',
  },
  nvidia: {
    baseUrl: process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    apiKey: userNvidiaKey || envNvidiaKey || null,
    model: userModel ?? process.env.MODEL ?? DEFAULT_MODELS.nvidia,
    label: 'NVIDIA NIM',
  },
};

let PROVIDER =
  (userProviderPref === 'nvidia' && CONFIG.nvidia.apiKey) ? 'nvidia'
  : (userProviderPref === 'openrouter' && CONFIG.openrouter.apiKey) ? 'openrouter'
  : CONFIG.openrouter.apiKey ? 'openrouter'
  : CONFIG.nvidia.apiKey ? 'nvidia'
  : 'none';

// Configuración activa — actualizable dinámicamente
let BASE_URL = CONFIG[PROVIDER]?.baseUrl ?? '';
let API_KEY = CONFIG[PROVIDER]?.apiKey ?? '';
let MODEL = CONFIG[PROVIDER]?.model ?? '';
let LABEL = CONFIG[PROVIDER]?.label ?? 'Sin proveedor';

function syncExports() {
  const active = CONFIG[PROVIDER] ?? {};
  BASE_URL = active.baseUrl ?? '';
  API_KEY = active.apiKey ?? '';
  MODEL = active.model ?? '';
  LABEL = active.label ?? 'Sin proveedor';
}

export function getActiveConfig() {
  return {
    BASE_URL,
    API_KEY,
    MODEL,
    LABEL,
    PROVIDER,
  };
}

export { BASE_URL, API_KEY, MODEL, LABEL };

/* ==========================================================
   Cambio de proveedor / modelo / API keys
   ========================================================== */

/**
 * Cambia el proveedor activo y lo persiste en user-config.
 * Si el provider no tiene API key configurada, no cambia.
 * @param {'openrouter'|'nvidia'} provider
 * @returns {boolean} true si cambió, false si no disponible
 */
export const setProvider = (provider) => {
  if (!(provider in CONFIG) || provider === 'none') return false;
  if (!CONFIG[provider].apiKey) return false;
  PROVIDER = provider;
  syncExports();
  // Persistir preferencia (best-effort, sin bloquear el event loop en calls HTTP)
  saveUserConfig({ provider }).catch((e) => {
    console.warn(`[LLM] No se pudo persistir provider=${provider}: ${e?.message ?? e}`);
  });
  console.log(`[LLM] Proveedor actualizado: ${LABEL} (${MODEL})`);
  return true;
};

/**
 * Actualiza API key y/o modelo de un proveedor concreo.
 * No fuerza cambio de provider activo (lo hace solo si era el provider recibido).
 *
 * @param {Object} opts
 * @param {string} [opts.apiKey]    — nueva API key para el provider
 * @param {string} [opts.model]      — nuevo modelo para el provider
 * @param {'openrouter'|'nvidia'} [opts.provider] — provider a actualizar (default: activo)
 */
export async function updateApiConfig({ apiKey, model, provider } = {}) {
  let target = provider ?? PROVIDER;
  // Si el provider activo es 'none' pero recibimos apiKey, asumimos setup
  // inicial del provider por defecto (openrouter), manteniendo retrocompat.
  if (target === 'none' && apiKey) target = 'openrouter';
  if (!(target in CONFIG) || target === 'none') {
    throw new Error(`Provider inválido: ${target}`);
  }

  if (apiKey) CONFIG[target].apiKey = apiKey;
  if (model) CONFIG[target].model = model;

  // Persistir solo el campo correspondiente; saveUserConfig hace merge
  const partial = {};
  if (apiKey) partial[target === 'openrouter' ? 'openrouterApiKey' : 'nvidiaApiKey'] = apiKey;
  if (model) partial.model = model;
  // Si el provider activo era 'none', ahora pasa a ser el target configurado
  if (PROVIDER === 'none' && CONFIG[target].apiKey) {
    PROVIDER = target;
    partial.provider = target;
  }
  await saveUserConfig(partial);

  // Si el provider actualizado es el activo, sincroniza exports
  if (target === PROVIDER) syncExports();

  console.log(`[LLM] Config actualizada: provider=${target} model=${CONFIG[target].model}`);
}

/* ==========================================================
   Estado y disponibilidad
   ========================================================== */

export function getAvailableProviders() {
  const result = {};
  for (const [key, cfg] of Object.entries(CONFIG)) {
    if (key === 'none') continue;
    result[key] = {
      label: cfg.label,
      model: cfg.model,
      configured: !!cfg.apiKey,
    };
  }
  return result;
}

/** Devuelve el provider activo actual. */
export function getActiveProvider() {
  return PROVIDER;
}

/** Devuelve si hay al menos un proveedor con API key válida. */
export function isConfigured() {
  return PROVIDER !== 'none' && !!API_KEY && !/your_.*_key_here/i.test(API_KEY);
}

// Log informativo al iniciar
console.log(
  `[LLM] Proveedor: ${LABEL} | Modelo: ${MODEL} | Base URL: ${BASE_URL} | ` +
  `OR=${CONFIG.openrouter.apiKey ? 'ok' : '-'} NIM=${CONFIG.nvidia.apiKey ? 'ok' : '-'}`
);

/* ==========================================================
   Listado de modelos por proveedor
   ========================================================== */

/**
 * Obtiene los modelos disponibles de un proveedor concreto.
 *
 * @param {'openrouter'|'nvidia'} provider
 * @returns {Promise<{ models: Array<{id: string, name: string, isFree: boolean}> }>}
 */
export async function getModelsForProvider(provider) {
  const cfg = CONFIG[provider];
  if (!cfg || !cfg.apiKey) {
    const err = new Error(`Provider ${provider} no configurado`);
    err.kind = 'unauthorized';
    throw err;
  }

  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL ?? 'http://localhost:5173';
    headers['X-OpenRouter-Title'] = 'Task App';
  }

  const res = await fetch(`${cfg.baseUrl}/models`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`[${res.status}] ${text.slice(0, 400)}`);
    err.status = res.status;
    err.kind = classifyError(res.status, text);
    throw err;
  }

  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : [];

  const models = list.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    isFree:
      provider === 'openrouter'
        ? m.id.endsWith(':free') ||
          (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
        : false, // NIM no tiene sufijo :free
  }));

  if (provider === 'openrouter') {
    models.sort((a, b) => {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  } else {
    models.sort((a, b) => a.id.localeCompare(b.id));
  }

  return { models };
}

/* ==========================================================
   Schema de respuesta estructurada (response_format)
   ========================================================== */

/**
 * Schema JSON estricto para todas las respuestas del LLM.
 * Elimina el parsing frágil de "TASK_APP_META:".
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      description: 'Markdown visible para el usuario. NUNCA vacío.',
    },
    meta: {
      type: 'object',
      properties: {
        complete: { type: 'boolean', description: 'true si la tarea está resuelta' },
        taskPath: { type: ['string', 'null'], description: 'Ruta de la tarea activa' },
        summary: { type: 'string', description: 'Resumen breve de la respuesta' },
      },
      required: ['complete'],
      additionalProperties: false,
    },
    fileGenerated: {
      type: 'object',
      description: 'Opcional. Si la IA debe generar/editar un archivo, incluye este objeto',
      properties: {
        type: { type: 'string', enum: ['xlsx', 'docx', 'pptx', 'png', 'pdf'] },
        data: { type: 'object', additionalProperties: true },
        filename: { type: 'string' },
        editPath: { type: 'string' },
        editChanges: { type: 'object', additionalProperties: true },
      },
      required: ['type'],
      additionalProperties: true,
    },
  },
  required: ['content', 'meta'],
  additionalProperties: false,
};

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'task_response',
    strict: true,
    schema: RESPONSE_SCHEMA,
  },
};

/* ==========================================================
   Construcción de headers
   ========================================================== */

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
  if (PROVIDER === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL ?? 'http://localhost:5173';
    headers['X-OpenRouter-Title'] = 'Task App';
  }
  return headers;
}

/* ==========================================================
   Clasificación de errores y extracción de provider
   ========================================================== */

/**
 * Clasifica un error HTTP en una categoría semántica.
 * @param {number} status
 * @param {string} bodyText
 * @returns {string}
 */
function classifyError(status, bodyText) {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'forbidden';
  if (status === 408) return 'timeout';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'unprocessable';
  if (status === 502) return 'bad_gateway';
  if (status === 503) return 'unavailable';
  if (status === 500 || status === 504) return 'server_error';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  return 'unknown';
}

/**
 * Lee metadata.provider_name del cuerpo JSON de error de OpenRouter.
 * @param {string} bodyText
 * @returns {string|null}
 */
function extractProvider(bodyText) {
  if (!bodyText) return null;
  try {
    const j = JSON.parse(bodyText);
    return j?.error?.metadata?.provider_name ?? j?.metadata?.provider_name ?? null;
  } catch {
    return null;
  }
}

/**
 * Lee headers X-RateLimit-* de OpenRouter y los devuelve como objeto numérico.
 */
function readRateLimitHeaders(headers) {
  const num = (k) => {
    const v = headers.get(k);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    reset: num('x-ratelimit-reset'),
  };
}

/* ==========================================================
   Funciones de fetch
   ========================================================== */

/**
 * Realiza una petición POST a /chat/completions con los parámetros dados.
 */
async function fetchCompletion(bodyParams) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(bodyParams),
  });

  const generationId = res.headers.get('x-generation-id');
  const rateLimit = readRateLimitHeaders(res.headers);
  const retryAfter = res.headers.get('retry-after');

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const kind = classifyError(res.status, text);
    const err = new Error(`[${res.status}] ${text.slice(0, 600)}`);
    err.status = res.status;
    err.body = text;
    err.kind = kind;
    err.retriable =
      kind === 'rate_limited' || kind === 'unavailable' || kind === 'bad_gateway' || kind === 'server_error';
    err.retryAfter = retryAfter ? Number(retryAfter) : null;
    err.generationId = generationId;
    err.rateLimit = rateLimit;
    err.provider = extractProvider(text);
    throw err;
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  const usage = data?.usage ?? null;
  const cost = usage?.cost ?? usage?.total_cost ?? null;

  return { data, message, usage, cost, generationId, rateLimit };
}

/**
 * Indica si el cuerpo de error menciona que response_format/json_schema no soportado.
 */
function isSchemaUnsupportedError(err) {
  const body = (err?.body ?? '').toLowerCase();
  return (
    (err?.status === 400 || err?.status === 422) &&
    (body.includes('response_format') ||
      body.includes('json_schema') ||
      body.includes('json mode') ||
      body.includes('structured output'))
  );
}

/**
 * Indica si el error es porque el modelo no soporta tools/function calling.
 */
function isToolsUnsupportedError(err) {
  const body = (err?.body ?? '').toLowerCase();
  return (
    err?.status === 400 &&
    (body.includes('tool') || body.includes('function') || body.includes('not supported'))
  );
}

/**
 * Intenta enviar con tools + response_format.
 * Reintentos automáticos:
 *  1. Si tools no soportado → reintenta sin tools
 *  2. Si response_format no soportado → reintenta sin response_format
 * (manteniendo el resto de parámetros)
 */
async function fetchWithFallbacks(baseParams, tools) {
  const paramsWithExtras = {
    ...baseParams,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  };

  try {
    return await fetchCompletion(paramsWithExtras);
  } catch (err) {
    // Reintento 1: quitar tools si no soportados
    if (isToolsUnsupportedError(err) && tools?.length) {
      console.warn(`[${LABEL}] ${MODEL} no soporta tools. Reintentando sin tools...`);
      try {
        return await fetchCompletion(baseParams);
      } catch (err2) {
        // Reintento 2: si tampoco soporta response_format, reintenta sin schema
        if (isSchemaUnsupportedError(err2)) {
          console.warn(`[${LABEL}] ${MODEL} no soporta response_format. Reintentando sin schema...`);
          const { response_format, ...rest } = baseParams;
          return await fetchCompletion(rest);
        }
        throw err2;
      }
    }
    // Reintento 2 directo: si solo response_format no soportado (tools vacío)
    if (isSchemaUnsupportedError(err)) {
      console.warn(`[${LABEL}] ${MODEL} no soporta response_format. Reintentando sin schema...`);
      const { response_format, ...rest } = baseParams;
      return await fetchCompletion(rest);
    }
    throw err;
  }
}

/* ==========================================================
   Función principal exportada
   ========================================================== */

/**
 * Envía mensajes al modelo LLM y devuelve la respuesta.
 * Reintenta 1 vez ante 429/503 (respetando retry-after).
 *
 * Diferencias por provider:
 *  - openrouter: incluye reasoning: {effort: 'low'} y response_format json_schema
 *  - nvidia:     omite reasoning (no soportado). response_format se intenta y se
 *                quita en runtime si el modelo responde 400/422 (fetchWithFallbacks).
 */
export async function llmChat({ messages, temperature = 0.2, tools = undefined }) {
  if (!isConfigured()) {
    throw new Error(
      'API key no configurada. Configurala desde la pantalla de inicio o edita apps/api/.env con tu OPENROUTER_API_KEY o NVIDIA_API_KEY.'
    );
  }

  const baseParams = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: 4096,
    ...(PROVIDER === 'openrouter' && { reasoning: { effort: 'low' } }),
    response_format: RESPONSE_FORMAT,
  };

  const maxRetries = 1;
  let attempt = 0;

  while (true) {
    try {
      const result = await fetchWithFallbacks(baseParams, tools);

      const usage = result.usage;
      const promptTokens = usage?.prompt_tokens ?? '?';
      const compTokens = usage?.completion_tokens ?? '?';
      const costStr = result.cost != null ? result.cost.toFixed(6) : '?';
      const rlRem = result.rateLimit?.remaining;
      const rlStr = rlRem != null ? ` rlRem=${rlRem}` : '';
      const genStr = result.generationId ? ` genId=${result.generationId}` : '';
      console.log(
        `[LLM] ok model=${MODEL} prompt=${promptTokens} comp=${compTokens} cost=${costStr}${rlStr}${genStr}`
      );

      return {
        raw: result.data,
        message: result.message,
        usage: result.usage,
        cost: result.cost,
        generationId: result.generationId,
      };
    } catch (err) {
      const status = err.status;
      const code = err?.cause?.code;

      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        const e = new Error(`No se pudo conectar con ${LABEL} (${code}) — verifica tu conexión a internet`);
        e.kind = 'network';
        e.retriable = true;
        throw e;
      }

      if ((status === 429 || status === 503) && err.retriable && attempt < maxRetries) {
        const retryAfter = Number(err.retryAfter);
        const baseDelayMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * Math.pow(2, attempt);
        const jitterMs = Math.floor(Math.random() * 200);
        const delayMs = baseDelayMs + jitterMs;

        const rlStr = err.rateLimit?.remaining != null ? ` rlRem=${err.rateLimit.remaining}` : '';
        const provStr = err.provider ? ` provider=${err.provider}` : '';
        console.warn(
          `[LLM] retry model=${MODEL} kind=${err.kind} status=${status} delayMs=${delayMs}${provStr}${rlStr}`
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
        continue;
      }

      if (err.kind) {
        const provStr = err.provider ? ` provider=${err.provider}` : '';
        const rlStr = err.rateLimit?.remaining != null ? ` rlRem=${err.rateLimit.remaining}` : '';
        const genStr = err.generationId ? ` genId=${err.generationId}` : '';
        console.warn(
          `[LLM] err model=${MODEL} kind=${err.kind} status=${status ?? '-'}${provStr}${rlStr}${genStr} body=${(err.body ?? '').slice(0, 200)}`
        );
        throw err;
      }

      const e = new Error(`${LABEL} error ${status ?? ''} con ${MODEL}: ${err.body?.slice(0, 300) ?? err.message}`);
      e.kind = 'unknown';
      throw e;
    }
  }
}

// Alias de compatibilidad con el nombre original
export { llmChat as nvidiaChat };
