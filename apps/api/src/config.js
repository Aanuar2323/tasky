import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getStorageRoot } from './storage.js';

let userConfig = null;

function configFilePath() {
  return path.join(getStorageRoot(), 'user-config.json');
}

export function loadUserConfigSync() {
  const filePath = configFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    userConfig = JSON.parse(raw);
  } catch {
    userConfig = null;
  }
  return userConfig;
}

export function getUserConfig() {
  if (userConfig === null) {
    loadUserConfigSync();
  }
  return userConfig;
}

export async function saveUserConfig(config) {
  userConfig = config;
  const filePath = configFilePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
}

export function getApiKey() {
  const cfg = getUserConfig();
  return cfg?.openrouterApiKey || null;
}

export function getModel() {
  const cfg = getUserConfig();
  return cfg?.model || null;
}
