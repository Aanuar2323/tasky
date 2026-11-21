import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getStorageRoot } from './storage.js';

/**
 * config.js — Persistencia de configuración del usuario.
 *
 * Schema user-config.json:
 *   {
 *     openrouterApiKey: string | null,
 *     nvidiaApiKey:      string | null,
 *     provider:          'openrouter' | 'nvidia' | 'chatgpt' | null,
 *     models:            { openrouter?: string, nvidia?: string, chatgpt?: string }   // modelo recordado por proveedor
 *                        (ChatGPT no guarda tokens acá: ver llm/chatgpt-auth.js)
 *     model:             string | null   // legacy: modelo único (pertenece a `provider`)
 *   }
 *
 * `saveUserConfig(partial)` hace merge shallow con la config existente (y merge
 * profundo de `models`): nunca pisa claves del otro proveedor al guardar solo uno.
 */

let userConfig = null;

const DEFAULT_CONFIG = {
  openrouterApiKey: null,
  nvidiaApiKey: null,
  provider: null,
  model: null,
  models: {},
};

function configFilePath() {
  return path.join(getStorageRoot(), 'user-config.json');
}

export function loadUserConfigSync() {
  const filePath = configFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    userConfig = { ...DEFAULT_CONFIG, ...parsed, models: { ...(parsed?.models ?? {}) } };
  } catch {
    userConfig = { ...DEFAULT_CONFIG, models: {} };
  }
  return userConfig;
}

export function getUserConfig() {
  if (userConfig === null) {
    loadUserConfigSync();
  }
  return userConfig;
}

/**
 * Guarda la config con merge sobre la existente.
 * @param {Partial<typeof DEFAULT_CONFIG>} partial
 */
export async function saveUserConfig(partial) {
  const current = getUserConfig();
  userConfig = {
    ...current,
    ...partial,
    openrouterApiKey: 'openrouterApiKey' in partial ? partial.openrouterApiKey : current.openrouterApiKey,
    nvidiaApiKey: 'nvidiaApiKey' in partial ? partial.nvidiaApiKey : current.nvidiaApiKey,
    provider: 'provider' in partial ? partial.provider : current.provider,
    model: 'model' in partial ? partial.model : current.model,
    models: { ...(current.models ?? {}), ...(partial.models ?? {}) },
  };
  const filePath = configFilePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(userConfig, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

/** API key de OpenRouter (retrocompat). */
export function getApiKey() {
  return getUserConfig()?.openrouterApiKey || null;
}

/** API key de NVIDIA NIM. */
export function getNvidiaApiKey() {
  return getUserConfig()?.nvidiaApiKey || null;
}

/** Modelo guardado (retrocompat). */
export function getModel() {
  return getUserConfig()?.model || null;
}

/**
 * Modelo recordado para un proveedor. El `model` legacy pertenece solo al
 * proveedor guardado en `provider` (o a OpenRouter si no hay ninguno).
 * @param {'openrouter'|'nvidia'} provider
 */
export function getModelFor(provider) {
  const cfg = getUserConfig();
  if (cfg?.models?.[provider]) return cfg.models[provider];
  const owner = cfg?.provider || 'openrouter';
  if (cfg?.model && owner === provider) return cfg.model;
  return null;
}

/** Provider preferido por el usuario ('openrouter' | 'nvidia' | null). */
export function getProvider() {
  return getUserConfig()?.provider || null;
}
