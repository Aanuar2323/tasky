import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FAKE_TOKENS, seedChatgptCredentials } from './helpers/chatgpt-creds.js';

describe('llm/providers con ChatGPT (regresión de OpenRouter / NVIDIA)', () => {
  let tmpDir;
  let providers;
  let capabilities;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-chatgpt-providers-'));
    process.env.STORAGE_ROOT = tmpDir;
    process.env.OPENROUTER_API_KEY = 'sk-or-test-1234567890';
    delete process.env.NVIDIA_API_KEY;
    delete process.env.MODEL;
    providers = await import('../src/llm/providers.js');
    capabilities = await import('../src/llm/capabilities.js');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    delete process.env.OPENROUTER_API_KEY;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('expone chatgpt como proveedor sin romper los anteriores', () => {
    assert.deepEqual(providers.PROVIDER_IDS, ['openrouter', 'nvidia', 'chatgpt']);
    assert.deepEqual(providers.KEY_PROVIDER_IDS, ['openrouter', 'nvidia']);
    const all = providers.getAvailableProviders();
    assert.equal(all.openrouter.configured, true);
    assert.equal(all.nvidia.configured, false);
    assert.equal(all.chatgpt.configured, false);
    assert.equal(all.chatgpt.label, 'ChatGPT');
    assert.equal(providers.getActive().provider, 'openrouter');
  });

  it('sin sesión no se puede activar chatgpt y el activo no cambia', () => {
    assert.equal(providers.setActiveProvider('chatgpt'), false);
    assert.equal(providers.getActive().provider, 'openrouter');
  });

  it('chatgpt no acepta API key', async () => {
    await assert.rejects(providers.updateProviderConfig({ provider: 'chatgpt', apiKey: 'sk-xxxxxxxxxxxx' }), /no usa API key/);
  });

  it('con sesión y permiso de plan queda configurado, sin exponer tokens', async () => {
    await seedChatgptCredentials(tmpDir);
    const all = providers.getAvailableProviders();
    assert.equal(all.chatgpt.configured, true);
    const text = JSON.stringify(all) + JSON.stringify(providers.getActive()) + JSON.stringify(providers.providerConfig('chatgpt'));
    for (const secret of Object.values(FAKE_TOKENS)) assert.ok(!text.includes(secret));
    // OpenRouter sigue siendo el activo por defecto: iniciar sesión no cambia nada solo.
    assert.equal(providers.getActive().provider, 'openrouter');
  });

  it('activa chatgpt y recuerda su modelo por separado', async () => {
    await providers.updateProviderConfig({ provider: 'chatgpt', model: 'gpt-test-model' });
    await providers.updateProviderConfig({ provider: 'openrouter', model: 'a/b:free' });
    assert.equal(providers.setActiveProvider('chatgpt'), true);
    const active = providers.getActive();
    assert.equal(active.provider, 'chatgpt');
    assert.equal(active.model, 'gpt-test-model');
    assert.equal(active.baseUrl, 'https://api.openai.com/v1');
    assert.ok(!active.apiKey, 'el token no pasa por getActive()');
    assert.equal(providers.isConfigured(), true);
    assert.equal(providers.providerConfig('openrouter').model, 'a/b:free');
    await new Promise((r) => setTimeout(r, 30));
    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'user-config.json'), 'utf8'));
    assert.equal(saved.models.chatgpt, 'gpt-test-model');
    assert.equal(saved.models.openrouter, 'a/b:free');
    assert.equal(saved.provider, 'chatgpt');
    assert.ok(!JSON.stringify(saved).includes(FAKE_TOKENS.access));
  });

  it('perfil de capacidades de chatgpt: herramientas sí, temperature no', async () => {
    const p = await capabilities.getModelProfile('chatgpt', 'gpt-test-model');
    assert.equal(p.tools, true);
    assert.equal(p.temperature, false);
    assert.ok(p.contextLength > 0 && p.maxOutput > 0);
  });

  it('sin permiso de plan deja de estar configurado', async () => {
    await seedChatgptCredentials(tmpDir, { scopes: ['openid', 'email'] });
    assert.equal(providers.getAvailableProviders().chatgpt.configured, false);
    assert.equal(providers.isConfigured(), false);
    await seedChatgptCredentials(tmpDir);
  });

  it('al cerrar sesión pasa al primer proveedor configurado', async () => {
    await seedChatgptCredentials(tmpDir, { signedIn: false });
    assert.equal(providers.isConfigured(), false);
    assert.equal(providers.reconcileActiveProvider(), 'openrouter');
    assert.equal(providers.getActive().provider, 'openrouter');
    assert.equal(providers.isConfigured(), true);
    // La preferencia guardada no se pierde: volver a iniciar sesión permite reactivarlo.
    await seedChatgptCredentials(tmpDir);
    assert.equal(providers.setActiveProvider('chatgpt'), true);
  });
});
