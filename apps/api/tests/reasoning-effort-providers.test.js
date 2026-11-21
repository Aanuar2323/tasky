import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm, sseText } from './helpers/mock-llm.js';

// Nivel de razonamiento de extremo a extremo para OpenRouter y NVIDIA contra servidores
// simulados (sin credenciales ni red reales; el storage es un directorio temporal).

const PORT = 9895;
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const orEntry = (id, supported_parameters) => ({
  id, name: id, context_length: 32000, pricing: { prompt: '1', completion: '1' },
  top_provider: { context_length: 32000, max_completion_tokens: 8000 }, supported_parameters,
});
const OR_CATALOG = {
  data: [
    orEntry('or/adjustable', ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning']),
    orEntry('or/output-only', ['max_tokens', 'temperature', 'tools', 'include_reasoning']),
    orEntry('or/plain', ['max_tokens', 'temperature', 'tools']),
  ],
};
const NV_CATALOG = {
  data: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'nvidia/nemotron-3-super-120b-a12b', 'meta/muse-glimmer-30b', 'meta/llama-3.3-70b-instruct']
    .map((id) => ({ id, object: 'model' })),
};

function parseSse(text) {
  return text.split('\n\n').map((block) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return data ? { event, data: JSON.parse(data) } : null;
  }).filter(Boolean);
}

describe('nivel de razonamiento: OpenRouter y NVIDIA (simulados)', () => {
  let orMock;
  let nvMock;
  let server;
  let tmpDir;
  let projectId;
  let chatCount = 0;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-reasoning-prov-'));
    const handler = (catalog) => (body, n, req) => (req.url.endsWith('/models') ? { json: catalog } : { sse: sseText('ok') });
    orMock = await startMockLlm(handler(OR_CATALOG));
    nvMock = await startMockLlm(handler(NV_CATALOG));
    Object.assign(process.env, {
      STORAGE_ROOT: tmpDir,
      PORT: String(PORT),
      OPENROUTER_API_KEY: 'sk-or-test-1234567890',
      OPENROUTER_BASE_URL: orMock.url,
      NVIDIA_API_KEY: 'nvapi-test-1234567890',
      NVIDIA_BASE_URL: nvMock.url,
      TASKY_RETRY_BASE_MS: '1',
      TASKY_DISABLE_COMPACTION: '1',
      TASKY_IN_DOCKER: '1',
    });
    const mod = await import('../src/index.js');
    server = mod.server;
    projectId = (await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'RP' }) })).json()).id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await orMock.close();
    await nvMock.close();
    for (const k of ['STORAGE_ROOT', 'PORT', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'NVIDIA_API_KEY', 'NVIDIA_BASE_URL', 'TASKY_RETRY_BASE_MS', 'TASKY_DISABLE_COMPACTION', 'TASKY_IN_DOCKER']) delete process.env[k];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    orMock.requests.length = 0;
    nvMock.requests.length = 0;
  });

  const api = (p, init = {}) => fetch(`${BASE}${p}`, init);
  const select = async (provider, model) => {
    const switched = await api('/api/provider', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ provider }) });
    assert.equal(switched.status, 200);
    // `setActiveProvider` guarda sin esperar y comparte archivo temporal con el PATCH siguiente.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const res = await api('/api/model', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ provider, model }) });
    assert.equal(res.status, 200);
  };
  const caps = async () => (await (await api('/api/status')).json()).capabilities;
  const efforts = (c) => c.reasoningLevels.map((l) => l.effort);

  async function chat(extra = {}) {
    chatCount += 1;
    const chatId = `rp${chatCount}`;
    const cfg = await (await api(`/api/projects/${projectId}/areas`)).json();
    cfg.areas[0].chats.push({ id: chatId, name: chatId });
    await api(`/api/projects/${projectId}/areas`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(cfg) });
    const res = await api(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Accept: 'text/event-stream' },
      body: JSON.stringify({ areaId: 'a1', chatId, message: 'hola', ...extra }),
    });
    return res.headers.get('content-type')?.includes('text/event-stream')
      ? { status: res.status, events: parseSse(await res.text()) }
      : { status: res.status, json: await res.json() };
  }

  it('OpenRouter: /api/status (arranque en frío) y /api/models exponen low/medium/high solo si el modelo anuncia reasoning', async () => {
    await select('openrouter', 'or/adjustable');
    assert.deepEqual(efforts(await caps()), ['low', 'medium', 'high']);
    assert.equal((await caps()).defaultReasoningLevel, null);
    const { models } = await (await api('/api/models?provider=openrouter')).json();
    const by = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.deepEqual(by['or/adjustable'].reasoningLevels.map((l) => l.effort), ['low', 'medium', 'high']);
    assert.deepEqual(by['or/output-only'].reasoningLevels, []);
    assert.deepEqual(by['or/plain'].reasoningLevels, []);
    await select('openrouter', 'or/output-only');
    assert.deepEqual((await caps()).reasoningLevels, []);
  });

  it('OpenRouter: la elección viaja como reasoning.effort; sin elección se conserva el default previo', async () => {
    await select('openrouter', 'or/adjustable');
    const picked = await chat({ reasoningEffort: 'medium' });
    assert.equal(picked.status, 200);
    assert.deepEqual(orMock.completions()[0].body.reasoning, { effort: 'medium' });
    assert.equal(orMock.completions()[0].body.reasoning_effort, undefined);
    const auto = await chat();
    assert.equal(auto.status, 200);
    // Comportamiento previo sin override (modelo que razona → low), no una elección del usuario.
    assert.deepEqual(orMock.completions()[1].body.reasoning, { effort: 'low' });
  });

  it('OpenRouter: nivel no anunciado o modelo sin reasoning → 400 invalid_reasoning sin llamar al proveedor', async () => {
    await select('openrouter', 'or/adjustable');
    const xhigh = await chat({ reasoningEffort: 'xhigh' });
    assert.equal(xhigh.status, 400);
    assert.equal(xhigh.json.kind, 'invalid_reasoning');
    assert.deepEqual(xhigh.json.allowed, ['low', 'medium', 'high']);
    await select('openrouter', 'or/output-only');
    const outputOnly = await chat({ reasoningEffort: 'low' });
    assert.equal(outputOnly.status, 400);
    assert.equal(outputOnly.json.kind, 'invalid_reasoning');
    assert.equal(orMock.completions().length, 0);
  });

  it('NVIDIA: niveles y default propios de cada modelo documentado, y cambian al cambiar de modelo', async () => {
    const expected = {
      'openai/gpt-oss-120b': [['low', 'medium', 'high'], 'medium'],
      'nvidia/nemotron-3-super-120b-a12b': [['none', 'low', 'high'], 'high'],
      'meta/muse-glimmer-30b': [['none', 'minimal', 'low', 'medium', 'high', 'max'], 'high'],
      'meta/llama-3.3-70b-instruct': [[], null],
    };
    for (const [model, [levels, def]] of Object.entries(expected)) {
      await select('nvidia', model);
      const c = await caps();
      assert.deepEqual(efforts(c), levels, model);
      assert.equal(c.defaultReasoningLevel, def, model);
    }
    const { models } = await (await api('/api/models?provider=nvidia')).json();
    const by = Object.fromEntries(models.map((m) => [m.id, m]));
    for (const [model, [levels, def]] of Object.entries(expected)) {
      assert.deepEqual(by[model].reasoningLevels.map((l) => l.effort), levels, model);
      assert.equal(by[model].defaultReasoningLevel, def, model);
    }
  });

  it('NVIDIA: reasoning_effort exacto en el cuerpo solo con elección; automático no lo envía', async () => {
    await select('nvidia', 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal((await chat({ reasoningEffort: 'none' })).status, 200);
    assert.equal((await chat()).status, 200);
    await select('nvidia', 'openai/gpt-oss-120b');
    assert.equal((await chat({ reasoningEffort: 'medium' })).status, 200);
    const [none, auto, medium] = nvMock.completions().map((c) => c.body);
    assert.equal(none.model, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(none.reasoning_effort, 'none');
    assert.equal(none.reasoning, undefined);
    assert.equal('reasoning_effort' in auto, false);
    assert.equal('reasoning' in auto, false);
    assert.equal(medium.model, 'openai/gpt-oss-120b');
    assert.equal(medium.reasoning_effort, 'medium');
    assert.equal(orMock.completions().length, 0);
  });

  it('NVIDIA: nivel que otro modelo sí admite, o modelo sin niveles → 400 sin llamar al proveedor', async () => {
    await select('nvidia', 'nvidia/nemotron-3-super-120b-a12b');
    const medium = await chat({ reasoningEffort: 'medium' });
    assert.equal(medium.status, 400);
    assert.equal(medium.json.kind, 'invalid_reasoning');
    assert.deepEqual(medium.json.allowed, ['none', 'low', 'high']);
    await select('nvidia', 'meta/llama-3.3-70b-instruct');
    const unknown = await chat({ reasoningEffort: 'low' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.kind, 'invalid_reasoning');
    assert.equal(nvMock.completions().length, 0);
  });

  it('cambio de proveedor: los niveles siguen al modelo activo y una elección vieja ya no vale', async () => {
    await select('nvidia', 'meta/muse-glimmer-30b');
    assert.ok(efforts(await caps()).includes('max'));
    await select('openrouter', 'or/adjustable');
    assert.deepEqual(efforts(await caps()), ['low', 'medium', 'high']);
    const stale = await chat({ reasoningEffort: 'max' });
    assert.equal(stale.status, 400);
    assert.equal(stale.json.kind, 'invalid_reasoning');
    assert.equal(orMock.completions().length, 0);
    assert.equal(nvMock.completions().length, 0);
  });
});
