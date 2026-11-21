/**
 * Siembra credenciales de ChatGPT FALSAS en un storage temporal de pruebas
 * (mismo formato que chatgpt-auth.js). Nunca se usa el storage real.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const FAKE_TOKENS = {
  access: 'fake-access-token-AAAA',
  refresh: 'fake-refresh-token-BBBB',
  id: 'fake.id.token',
};

export async function seedChatgptCredentials(storageRoot, {
  clientId = 'oaiapp_seed',
  email = 'seed@example.com',
  scopes = ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'],
  signedIn = true,
} = {}) {
  const dir = path.join(storageRoot, 'credentials', 'chatgpt');
  const accounts = path.join(dir, 'accounts');
  await fs.mkdir(accounts, { recursive: true, mode: 0o700 });
  const record = {
    email,
    issuer: 'https://auth.openai.com',
    subject: 'seed-subject',
    client_id: clientId,
    ext_agent_host_id: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    id_token: signedIn ? FAKE_TOKENS.id : null,
    access_token: signedIn ? FAKE_TOKENS.access : null,
    refresh_token: signedIn ? FAKE_TOKENS.refresh : null,
    token_type: 'Bearer',
    expires_in: 3600,
    scopes,
    saved_at: new Date().toISOString(),
  };
  const file = path.join(accounts, `${crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 32)}.json`);
  await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'active.json'), JSON.stringify({ client_id: clientId }), { mode: 0o600 });
  return { dir, file, record };
}
