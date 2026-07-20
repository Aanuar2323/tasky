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
 *     provider:          'openrouter' | 'nvidia' | null,
 *     model:             string | null   // modelo activo del provider seleccionado
 *   }
 *
 * `saveUserConfig(partial)` hace merge shallow con la config existente:
 * nunca pisa claves del otro provider al guardar solo uno.
 */

let userConfig = null;

const DEFAULT_CONFIG = {
  openrouterApiKey: null,
  nvidiaApiKey: null,
  provider: null,
  model: null,
};

function configFilePath() {
  return path.join(getStorageRoot(), 'user-config.json');
}

export function loadUserConfigSync() {
  const filePath = configFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    userConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    userConfig = { ...DEFAULT_CONFIG };
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
 * Guarda la config con merge shallow sobre la existente.
 * @param {Partial<typeof DEFAULT_CONFIG>} partial
 */
export async function saveUserConfig(partial) {
  const current = getUserConfig();
  userConfig = {
    ...current,
    ...partial,
    // nunca permitir nulls explícitos que eliminen defaults de merge posteriores
    openrouterApiKey: 'openrouterApiKey' in partial ? partial.openrouterApiKey : current.openrouterApiKey,
    nvidiaApiKey: 'nvidiaApiKey' in partial ? partial.nvidiaApiKey : current.nvidiaApiKey,
    provider: 'provider' in partial ? partial.provider : current.provider,
    model: 'model' in partial ? partial.model : current.model,
  };
  const filePath = configFilePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(userConfig, null, 2), 'utf8');
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

/** Provider preferido por el usuario ('openrouter' | 'nvidia' | null). */
export function getProvider() {
  return getUserConfig()?.provider || null;
}
