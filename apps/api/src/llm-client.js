/**
 * llm-client.js — Fachada de compatibilidad sobre llm/.
 *
 * La lógica vive en:
 *   llm/providers.js     keys, modelo por proveedor, proveedor activo
 *   llm/capabilities.js  perfil de cada modelo (contexto, tools, visión…)
 *   llm/client.js        chat completions con streaming y reintentos adaptativos
 *   llm/normalize.js     razonamiento embebido y tool calls escritas como texto
 */

import {
  getActive,
  getActiveProviderId,
  getAvailableProviders,
  isConfigured,
  setActiveProvider,
  updateProviderConfig,
} from './llm/providers.js';
import { listModels, getModelProfile } from './llm/capabilities.js';
import { chatCompletion } from './llm/client.js';
import { TOOL_DEFS } from './chat/tools.js';

export { getAvailableProviders, isConfigured, getModelProfile, chatCompletion };

/** Config activa en el formato histórico. */
export function getActiveConfig() {
  const a = getActive();
  return { BASE_URL: a.baseUrl, API_KEY: a.apiKey, MODEL: a.model, LABEL: a.label, PROVIDER: a.provider };
}

export function getActiveProvider() {
  return getActiveProviderId();
}

export const setProvider = (provider) => setActiveProvider(provider);

export async function updateApiConfig({ apiKey, model, provider } = {}) {
  return updateProviderConfig({ apiKey, model, provider });
}

export async function getModelsForProvider(provider) {
  return { models: await listModels(provider) };
}

/**
 * Llamada simple no-stream (compatibilidad). Devuelve el mensaje en formato OpenAI.
 */
export async function llmChat({ messages, temperature = 0.3, tools } = {}) {
  const r = await chatCompletion({ messages, temperature, tools, stream: false });
  return {
    raw: r.raw ?? null,
    message: {
      role: 'assistant',
      content: r.content,
      tool_calls: r.toolCalls.length
        ? r.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
        : null,
    },
    usage: r.usage,
    cost: r.usage?.cost ?? null,
    generationId: r.generationId,
  };
}

export { llmChat as nvidiaChat };

/** Definiciones de herramientas del chat (function calling). */
export const TOOLS = TOOL_DEFS;

/**
 * response_format legacy (json_schema). Se conserva para integraciones externas;
 * el chat ya no lo usa: los modelos sin tools usan el protocolo de texto.
 */
export const LEGACY_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'task_response',
    strict: false,
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        meta: { type: 'object' },
        fileGenerated: { type: 'object' },
      },
      required: ['content'],
    },
  },
};
