/**
 * llm-client.js — Cliente LLM unificado (OpenRouter / NVIDIA NIM)
 *
 * Este módulo detecta automáticamente el proveedor de IA disponible
 * a partir de las variables de entorno y encapsula toda la comunicación
 * con el endpoint de chat completions (formato OpenAI-compatible).
 *
 * Prioridad de detección:
 *   1. Si OPENROUTER_API_KEY existe → usa OpenRouter
 *   2. Si NVIDIA_API_KEY existe    → usa NVIDIA NIM
 *
 * Variables de entorno:
 *   MODEL               — Nombre del modelo a usar
 *   OPENROUTER_BASE_URL — URL base de OpenRouter (default: https://openrouter.ai/api/v1)
 *   OPENROUTER_API_KEY  — Clave de autenticación de OpenRouter
 *   NVIDIA_BASE_URL     — URL base de NVIDIA NIM (default: https://integrate.api.nvidia.com/v1)
 *   NVIDIA_API_KEY      — Clave de autenticación de NVIDIA
 *   APP_URL             — URL de la app para attribution en OpenRouter (opcional)
 */

import 'dotenv/config';

/* ==========================================================
   Detección automática del proveedor
   ========================================================== */

let PROVIDER = process.env.OPENROUTER_API_KEY
  ? 'openrouter'
  : process.env.NVIDIA_API_KEY
    ? 'nvidia'
    : 'none';

const CONFIG = {
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.MODEL ?? 'openai/gpt-oss-120b:free',
    label: 'OpenRouter',
  },
  nvidia: {
    baseUrl: process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY,
    model: process.env.MODEL ?? 'z-ai/glm-5.1',
    label: 'NVIDIA NIM',
  },
  none: {
    baseUrl: '',
    apiKey: '',
    model: process.env.MODEL ?? '',
    label: 'Sin proveedor',
  },
};

export function getActiveConfig() {
  const active = CONFIG[PROVIDER];
  return {
    BASE_URL: active.baseUrl,
    API_KEY: active.apiKey,
    MODEL: active.model,
    LABEL: active.label,
  };
}

// Configuración activa actualizada
export const { BASE_URL, API_KEY, MODEL, LABEL } = getActiveConfig();

// Exportar función para cambiar el proveedor desde el frontend
export const setProvider = (provider) => {
  if (provider in CONFIG) {
    PROVIDER = provider;
    const active = CONFIG[PROVIDER];
    console.log(`[LLM] Proveedor actualizado: ${active.label} (${active.model})`);
    // Actualizar configuración activa
    Object.assign(exports, getActiveConfig());
  }
};

// Log informativo al iniciar
console.log(`[LLM] Proveedor: ${LABEL} | Modelo: ${MODEL} | Base URL: ${BASE_URL}`);

// Exportar configuración disponible para el frontend
export function getAvailableProviders() {
  return Object.entries(CONFIG).reduce((acc, [key, config]) => {
    if (key !== 'none' && config.apiKey) {
      acc[key] = { label: config.label, model: config.model };
    }
    return acc;
  }, {});
}

/* ==========================================================
   Schema de respuesta estructurada (response_format)
   ========================================================== */

/**
 * Schema JSON estricto para todas las respuestas del LLM.
 * Garantiza que el backend reciba un JSON parseable con content no vacío
 * y meta estructurado, eliminando el parsing frágil de "TASK_APP_META:".
 *
 * Top-level: strict (additionalProperties: false).
 * fileGenerated: additionalProperties: true (el LLM necesita libertad
 * para describir sheets/sections/slides/etc. según el tipo de archivo).
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
        type: { type: 'string', enum: ['xlsx', 'docx', 'pptx', 'png'] },
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

  // Headers opcionales recomendados por OpenRouter para app attribution
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
 * Clasifica un error HTTP de OpenRouter en una categoría semántica
 * para que el frontend pueda mostrar mensajes contextuales.
 *
 * @param {number} status   — HTTP status
 * @param {string} bodyText — Cuerpo crudo de la respuesta
 * @returns {string} kind — 'unauthorized' | 'payment_required' | 'forbidden'
 *  | 'rate_limited' | 'payload_too_large' | 'bad_request' | 'timeout'
 *  | 'unprocessable' | 'bad_gateway' | 'unavailable' | 'server_error' | 'unknown'
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

  if (status === 429) {
    const lower = (bodyText ?? '').toLowerCase();
    if (
      lower.includes('rate-limited') ||
      lower.includes('ratelimit') ||
      lower.includes('isratelimit') ||
      lower.includes('temporarily rate-limited') ||
      lower.includes('quota')
    ) {
      return 'rate_limited';
    }
    return 'rate_limited';
  }

  if (status === 400) return 'bad_request';
  return 'unknown';
}

/**
 * Lee metadata.provider_name del cuerpo JSON de error de OpenRouter.
 * OpenRouter envuelve el error en { error: { metadata: { provider_name } } },
 * pero también tolera el formato plano { metadata: { provider_name } }.
 *
 * @param {string} bodyText
 * @returns {string|null}
 */
function extractProvider(bodyText) {
  if (!bodyText) return null;
  try {
    const j = JSON.parse(bodyText);
    return j?.error?.metadata?.provider_name
      ?? j?.metadata?.provider_name
      ?? null;
  } catch {
    return null;
  }
}

/**
 * Lee headers X-RateLimit-* de OpenRouter y los devuelve como objeto numérico.
 * @param {Headers} headers
 * @returns {{limit: number|null, remaining: number|null, reset: number|null}}
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
 * Enriquecido con:
 *  - Clasificación semántica del error (err.kind)
 *  - Telemetría: X-Generation-Id, usage, cost
 *  - Rate limit headers (X-RateLimit-*)
 *  - Indicador de retriabilidad (err.retriable)
 *
 * @param {Object} bodyParams — Parámetros del body (model, messages, etc.)
 * @returns {{data: Object, message: Object, usage: Object|null, cost: number|null, generationId: string|null}}
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
    err.retriable = kind === 'rate_limited' || kind === 'unavailable' || kind === 'bad_gateway' || kind === 'server_error';
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
 * Intenta enviar con tools. Si el modelo no los soporta (400),
 * reintenta automáticamente sin tools.
 */
async function fetchWithToolsFallback(baseParams, tools) {
  const paramsWithTools = tools?.length
    ? { ...baseParams, tools, tool_choice: 'auto' }
    : baseParams;

  try {
    return await fetchCompletion(paramsWithTools);
  } catch (err) {
    if (
      err.status === 400 &&
      tools?.length &&
      (err.body?.includes('tool') || err.body?.includes('function') || err.body?.includes('not supported'))
    ) {
      console.warn(`[${LABEL}] ${MODEL} no soporta tools. Reintentando sin tools...`);
      return await fetchCompletion(baseParams);
    }
    throw err;
  }
}

/* ==========================================================
   Función principal exportada
   ========================================================== */

/**
 * Envía mensajes al modelo LLM y devuelve la respuesta.
 * Reintenta 1 vez ante 429/503 (respetando retry-after). Errores con
 * `err.kind` ya clasificado se propagan tal cual al llamador.
 *
 * @param {Object} params
 * @param {Array} params.messages      — Historial de mensajes (formato OpenAI)
 * @param {number} [params.temperature] — Temperatura de generación (default: 0.2)
 * @param {Array}  [params.tools]       — Schema de tools/funciones (opcional)
 * @returns {{raw: Object, message: Object, usage: Object|null, cost: number|null, generationId: string|null}}
 */
export async function llmChat({ messages, temperature = 0.2, tools = undefined }) {
  if (PROVIDER === 'none' || !API_KEY || /your_.*_key_here/i.test(API_KEY)) {
    throw new Error(
      'API key no configurada o sigue siendo el placeholder de .env.example. ' +
      'Edita apps/api/.env y define OPENROUTER_API_KEY (o NVIDIA_API_KEY) con una clave real.'
    );
  }

  const baseParams = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: 4096,
    reasoning: { effort: 'low' },
    response_format: RESPONSE_FORMAT,
  };

  const maxRetries = 1;
  let attempt = 0;

  while (true) {
    try {
      const result = await fetchWithToolsFallback(baseParams, tools);

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
        const baseDelayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 600 * Math.pow(2, attempt);
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
