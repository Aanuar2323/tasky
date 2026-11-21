/**
 * llm/providers.js — Proveedores (OpenRouter / NVIDIA NIM / ChatGPT): keys, modelo
 * recordado por proveedor y proveedor activo.
 *
 * ChatGPT no usa API key: está "configurado" cuando hay una sesión OAuth con permiso
 * de uso del plan (ver chatgpt-auth.js). Su token nunca pasa por este módulo.
 *
 * Precedencia de key: user-config.json > variable de entorno.
 * Modelo: user-config (`models[provider]`) > OPENROUTER_MODEL / NVIDIA_MODEL >
 *         MODEL (solo para el proveedor activo por defecto) > default.
 */

import 'dotenv/config';
import { getUserConfig, getModelFor, saveUserConfig } from '../config.js';
import { chatgptAuth } from './chatgpt-auth.js';

export const PROVIDER_IDS = ['openrouter', 'nvidia', 'chatgpt'];
/** Proveedores que se configuran con API key. */
export const KEY_PROVIDER_IDS = ['openrouter', 'nvidia'];

const DEFAULT_MODELS = {
  openrouter: 'openai/gpt-oss-120b:free',
  nvidia: 'meta/llama-3.3-70b-instruct',
  chatgpt: '', // el catálogo depende de la cuenta: se elige desde el selector
};

const LABELS = {
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA NIM',
  chatgpt: 'ChatGPT',
};

function isRealKey(key) {
  return typeof key === 'string' && key.trim().length > 0 && !/your_.*_key_here/i.test(key);
}

function envKey(provider) {
  const value = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.NVIDIA_API_KEY;
  return isRealKey(value) ? value : null;
}

function baseUrlFor(provider) {
  if (provider === 'chatgpt') return 'https://api.openai.com/v1';
  return provider === 'openrouter'
    ? (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1')
    : (process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1');
}

/** ¿Puede usarse el proveedor ahora? (ChatGPT: sesión con permiso de plan) */
function isProviderConfigured(provider) {
  if (provider === 'chatgpt') return chatgptAuth.isReady();
  return !!state.providers[provider]?.apiKey;
}

function envModel(provider) {
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL;
  if (provider === 'nvidia') return process.env.NVIDIA_MODEL;
  return undefined;
}

const state = {
  active: 'none',
  providers: {},
};

function init() {
  const cfg = getUserConfig();
  for (const p of PROVIDER_IDS) {
    const userKey = p === 'openrouter' ? cfg.openrouterApiKey : cfg.nvidiaApiKey;
    state.providers[p] = {
      baseUrl: baseUrlFor(p),
      apiKey: p === 'chatgpt' ? null : (isRealKey(userKey) ? userKey : envKey(p)),
      model: getModelFor(p) || envModel(p) || null,
      label: LABELS[p],
    };
  }
  const pref = cfg.provider;
  state.active = pref && state.providers[pref] && isProviderConfigured(pref)
    ? pref
    : (PROVIDER_IDS.find((p) => isProviderConfigured(p)) ?? 'none');
  for (const p of PROVIDER_IDS) {
    if (!state.providers[p].model) {
      state.providers[p].model = (p === state.active && process.env.MODEL) || DEFAULT_MODELS[p];
    }
  }
}

init();

/** Copia de la config de un proveedor. */
export function providerConfig(provider) {
  const cfg = state.providers[provider];
  return cfg ? { ...cfg } : null;
}

/** Proveedor activo con todo lo necesario para llamarlo. */
export function getActive() {
  const cfg = state.providers[state.active];
  if (!cfg) return { provider: 'none', baseUrl: '', apiKey: '', model: '', label: 'Sin proveedor' };
  return { provider: state.active, ...cfg };
}

export function getActiveProviderId() {
  return state.active;
}

/**
 * Cambia el proveedor activo (si tiene key) y lo persiste.
 * @returns {boolean}
 */
export function setActiveProvider(provider) {
  if (!PROVIDER_IDS.includes(provider)) return false;
  if (!isProviderConfigured(provider)) return false;
  state.active = provider;
  saveUserConfig({ provider }).catch((e) => {
    console.warn(`[LLM] No se pudo persistir provider=${provider}: ${e?.message ?? e}`);
  });
  console.log(`[LLM] Proveedor activo: ${LABELS[provider]} (${state.providers[provider].model})`);
  return true;
}

/**
 * Actualiza key y/o modelo de un proveedor. Si no había proveedor activo y ahora
 * este tiene key, pasa a ser el activo.
 */
export async function updateProviderConfig({ provider, apiKey, model } = {}) {
  let target = provider ?? state.active;
  if (target === 'none' && apiKey) target = 'openrouter';
  if (!PROVIDER_IDS.includes(target)) {
    throw new Error(`Provider inválido: ${target}`);
  }
  if (target === 'chatgpt' && apiKey) throw new Error('ChatGPT no usa API key: iniciá sesión desde el selector de modelos');
  const partial = {};
  if (apiKey) {
    state.providers[target].apiKey = apiKey;
    partial[target === 'openrouter' ? 'openrouterApiKey' : 'nvidiaApiKey'] = apiKey;
  }
  if (model) {
    state.providers[target].model = model;
    partial.models = { [target]: model };
  }
  if (state.active === 'none' && isProviderConfigured(target)) {
    state.active = target;
    partial.provider = target;
  }
  await saveUserConfig(partial);
  console.log(`[LLM] Config actualizada: provider=${target} model=${state.providers[target].model}`);
}

/** Estado público (sin keys). */
export function getAvailableProviders() {
  const result = {};
  for (const p of PROVIDER_IDS) {
    const cfg = state.providers[p];
    result[p] = { label: cfg.label, model: cfg.model, configured: isProviderConfigured(p) };
  }
  return result;
}

export function isConfigured() {
  const cfg = state.providers[state.active];
  if (!cfg) return false;
  return state.active === 'chatgpt' ? chatgptAuth.isReady() : isRealKey(cfg.apiKey);
}

/**
 * Si el proveedor activo dejó de estar disponible (p. ej. cerraste sesión en ChatGPT),
 * pasa al primero configurado. Solo en memoria: la preferencia guardada no cambia.
 */
export function reconcileActiveProvider() {
  if (state.active !== 'none' && isProviderConfigured(state.active)) return state.active;
  state.active = PROVIDER_IDS.find((p) => isProviderConfigured(p)) ?? 'none';
  return state.active;
}
