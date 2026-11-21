import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('llm/providers (config por proveedor)', () => {
  let tmpDir;
  let providers;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-providers-'));
    process.env.STORAGE_ROOT = tmpDir;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.MODEL;
    // config legacy: un solo `model` compartido que pertenece al proveedor guardado
    await fs.writeFile(
      path.join(tmpDir, 'user-config.json'),
      JSON.stringify({ openrouterApiKey: null, nvidiaApiKey: null, provider: 'openrouter', model: 'legacy/model:free' })
    );
    providers = await import('../src/llm/providers.js');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('sin keys no está configurado', () => {
    assert.equal(providers.isConfigured(), false);
    assert.equal(providers.getAvailableProviders().openrouter.configured, false);
  });

  it('migra el modelo legacy solo al proveedor al que pertenecía', () => {
    assert.equal(providers.providerConfig('openrouter').model, 'legacy/model:free');
    assert.notEqual(providers.providerConfig('nvidia').model, 'legacy/model:free');
  });

  it('cada proveedor recuerda su propio modelo', async () => {
    await providers.updateProviderConfig({ provider: 'openrouter', apiKey: 'sk-or-v1-aaaaaaaaaaaa', model: 'a/b:free' });
    await providers.updateProviderConfig({ provider: 'nvidia', apiKey: 'nvapi-bbbbbbbbbbbb', model: 'meta/llama-3.3-70b-instruct' });
    assert.equal(providers.setActiveProvider('nvidia'), true);
    assert.equal(providers.getActive().model, 'meta/llama-3.3-70b-instruct');
    assert.equal(providers.getActive().provider, 'nvidia');
    assert.equal(providers.setActiveProvider('openrouter'), true);
    assert.equal(providers.getActive().model, 'a/b:free');
    assert.equal(providers.isConfigured(), true);
  });

  it('persiste modelos por proveedor en user-config.json', async () => {
    await new Promise((r) => setTimeout(r, 30));
    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'user-config.json'), 'utf8'));
    assert.equal(saved.models.openrouter, 'a/b:free');
    assert.equal(saved.models.nvidia, 'meta/llama-3.3-70b-instruct');
    assert.equal(saved.provider, 'openrouter');
  });

  it('no activa un proveedor sin key', async () => {
    const before = providers.getActive().provider;
    assert.equal(providers.setActiveProvider('inexistente'), false);
    assert.equal(providers.getActive().provider, before);
  });

  it('las keys nunca se exponen en getAvailableProviders', () => {
    const json = JSON.stringify(providers.getAvailableProviders());
    assert.ok(!json.includes('sk-or-v1-aaaaaaaaaaaa'));
    assert.ok(!json.includes('nvapi-bbbbbbbbbbbb'));
  });
});

describe('llm/errors', () => {
  let errors;
  before(async () => {
    errors = await import('../src/llm/errors.js');
  });

  it('clasifica 404 de OpenRouter por causa', () => {
    const { classifyStatus } = errors;
    assert.equal(classifyStatus(404, '{"error":{"message":"No endpoints found that support tool use. To learn more..."}}'), 'tools_unsupported');
    assert.equal(classifyStatus(404, '{"error":{"message":"No endpoints found matching your data policy (Free model training)"}}'), 'data_policy');
    assert.equal(classifyStatus(404, '{"error":{"message":"No endpoints found for foo/bar."}}'), 'model_not_found');
    assert.equal(classifyStatus(404, '{"error":{"message":"The model `x` does not exist"}}'), 'model_not_found');
    assert.equal(classifyStatus(404, 'Not Found'), 'not_found');
  });

  it('clasifica 400 por causa', () => {
    const { classifyStatus } = errors;
    assert.equal(classifyStatus(400, 'This model does not support function calling (tools)'), 'tools_unsupported');
    assert.equal(classifyStatus(400, "This model's maximum context length is 8192 tokens"), 'context_length');
    assert.equal(classifyStatus(400, 'Unsupported parameter: temperature'), 'bad_request');
    assert.equal(classifyStatus(429, ''), 'rate_limited');
    assert.equal(classifyStatus(401, ''), 'unauthorized');
    assert.equal(classifyStatus(402, ''), 'payment_required');
    assert.equal(classifyStatus(503, ''), 'unavailable');
  });

  it('humaniza con pista accionable y códigos', () => {
    const h = errors.humanizeError({ kind: 'data_policy', status: 404 });
    assert.match(h.hint, /openrouter\.ai\/settings\/privacy/);
    assert.deepEqual(h.codes, [404]);
    assert.equal(h.retriable, false);
    const r = errors.humanizeError({ kind: 'rate_limited', status: 429, retriable: true });
    assert.equal(r.retriable, true);
    const u = errors.humanizeError(new Error('boom'));
    assert.equal(u.title, 'Error inesperado');
  });

  it('mapea kind a status HTTP de respuesta', () => {
    assert.equal(errors.httpStatusFor('unauthorized'), 401);
    assert.equal(errors.httpStatusFor('rate_limited'), 429);
    assert.equal(errors.httpStatusFor('model_not_found'), 404);
    assert.equal(errors.httpStatusFor('network'), 504);
    assert.equal(errors.httpStatusFor('whatever'), 502);
  });
});
