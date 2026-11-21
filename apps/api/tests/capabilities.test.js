import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await fs.readFile(path.join(here, 'fixtures', 'openrouter-models.json'), 'utf8'));

function fixtureFetch() {
  let calls = 0;
  const fn = async (url) => {
    calls += 1;
    assert.match(String(url), /\/models$/);
    return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = () => calls;
  return fn;
}

async function failingFetch() {
  throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

describe('llm/capabilities', () => {
  let tmpDir;
  let caps;
  const OR = { baseUrl: 'http://mock/api/v1', apiKey: 'k' };

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-caps-'));
    process.env.STORAGE_ROOT = tmpDir;
    caps = await import('../src/llm/capabilities.js');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => caps.clearCapabilityCache({ keepLearned: false }));

  it('usa el catálogo de OpenRouter', async () => {
    const p = await caps.getModelProfile('openrouter', 'nvidia/nemotron-3.5-lightning:free', { ...OR, fetchImpl: fixtureFetch() });
    assert.equal(p.source, 'catalog');
    assert.equal(p.tools, true);
    assert.equal(p.reasoning, true);
    assert.equal(p.vision, false);
    assert.equal(p.temperature, true);
    assert.equal(p.contextLength, 1000000);
    assert.equal(p.maxOutput, 16384);
  });

  it('respeta el máximo de salida del proveedor cuando es menor', async () => {
    const p = await caps.getModelProfile('openrouter', 'google/gemma-3-27b-it:free', { ...OR, fetchImpl: fixtureFetch() });
    assert.equal(p.maxOutput, 8192);
    assert.equal(p.tools, false);
    assert.equal(p.vision, true);
  });

  it('sin max_completion_tokens usa una fracción del contexto', async () => {
    const p = await caps.getModelProfile('openrouter', 'mistralai/mistral-small-3.2-24b-instruct', { ...OR, fetchImpl: fixtureFetch() });
    assert.equal(p.maxOutput, 16384);
    assert.equal(p.contextLength, 131072);
  });

  it('temperature=false si el modelo no la soporta', async () => {
    const p = await caps.getModelProfile('openrouter', 'openai/o4-mini', { ...OR, fetchImpl: fixtureFetch() });
    assert.equal(p.temperature, false);
    assert.equal(p.reasoning, true);
  });

  it('cachea el catálogo entre llamadas', async () => {
    const f = fixtureFetch();
    await caps.getModelProfile('openrouter', 'openai/o4-mini', { ...OR, fetchImpl: f });
    await caps.getModelProfile('openrouter', 'google/gemma-3-27b-it:free', { ...OR, fetchImpl: f });
    assert.equal(f.calls(), 1);
  });

  it('modelo fuera del catálogo o catálogo caído → heurística', async () => {
    const p = await caps.getModelProfile('openrouter', 'meta-llama/llama-3.3-70b-instruct', { ...OR, fetchImpl: failingFetch });
    assert.equal(p.source, 'heuristic');
    assert.equal(p.contextLength, 128000);
    assert.equal(p.tools, true);
  });

  it('heurística para NVIDIA', async () => {
    const v = await caps.getModelProfile('nvidia', 'meta/llama-3.2-90b-vision-instruct', { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: failingFetch });
    assert.equal(v.vision, true);
    assert.equal(v.contextLength, 128000);
    assert.equal(v.source, 'heuristic');
    assert.ok(v.maxOutput <= 8192);
    const r = await caps.getModelProfile('nvidia', 'deepseek-ai/deepseek-r1', { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: failingFetch });
    assert.equal(r.reasoning, true);
    const g = await caps.getModelProfile('nvidia', 'google/gemma-2-9b-it', { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: failingFetch });
    assert.equal(g.contextLength, 8192);
    assert.equal(g.tools, false);
    const u = await caps.getModelProfile('nvidia', 'someone/unknown-model', { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: failingFetch });
    assert.equal(u.tools, null);
    assert.equal(u.contextLength, 32768);
  });

  it('lo aprendido pisa al catálogo y persiste en disco', async () => {
    await caps.learnCapability('openrouter', 'nvidia/nemotron-3.5-lightning:free', { tools: false, maxOutput: 4096 });
    caps.clearCapabilityCache({ keepLearned: false });
    const p = await caps.getModelProfile('openrouter', 'nvidia/nemotron-3.5-lightning:free', { ...OR, fetchImpl: fixtureFetch() });
    assert.equal(p.tools, false);
    assert.equal(p.maxOutput, 4096);
    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'model-capabilities.json'), 'utf8'));
    assert.equal(saved['openrouter::nvidia/nemotron-3.5-lightning:free'].tools, false);
  });

  it('listModels expone capacidades y ordena gratis primero', async () => {
    const models = await caps.listModels('openrouter', { ...OR, fetchImpl: fixtureFetch() });
    assert.equal(models.length, 4);
    assert.ok(models[0].isFree);
    const o4 = models.find((m) => m.id === 'openai/o4-mini');
    assert.deepEqual(
      { tools: o4.tools, vision: o4.vision, reasoning: o4.reasoning, contextLength: o4.contextLength, isFree: o4.isFree },
      { tools: true, vision: true, reasoning: true, contextLength: 200000, isFree: false }
    );
  });

  it('listModels de NVIDIA usa ids del endpoint + heurística', async () => {
    const nimFetch = async () => new Response(JSON.stringify({ data: [{ id: 'meta/llama-3.3-70b-instruct', object: 'model', owned_by: 'meta' }, { id: 'nvidia/embed-qa-4', object: 'model', owned_by: 'nvidia' }] }), { status: 200 });
    const models = await caps.listModels('nvidia', { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: nimFetch });
    assert.deepEqual(models.map((m) => m.id), ['meta/llama-3.3-70b-instruct']);
    assert.equal(models[0].tools, true);
  });

  describe('niveles de razonamiento ajustables', () => {
    const NIM = { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: failingFetch };
    const levels = (p) => p.reasoningLevels.map((l) => l.effort);
    const orCatalog = (entries) => async () => new Response(JSON.stringify({ data: entries }), { status: 200 });
    const entry = (id, supported_parameters) => ({ id, name: id, context_length: 32000, pricing: { prompt: '1', completion: '1' }, supported_parameters });

    it('OpenRouter: solo `reasoning` o `reasoning_effort` anuncian selector (low/medium/high, default automático)', async () => {
      const fetchImpl = orCatalog([
        entry('a/with-reasoning', ['reasoning', 'include_reasoning', 'tools']),
        entry('a/with-effort', ['reasoning_effort', 'tools']),
        entry('a/output-only', ['include_reasoning', 'tools']),
        entry('a/none', ['tools', 'temperature']),
        entry('a/unknown-params', undefined),
      ]);
      const get = (id) => caps.getModelProfile('openrouter', id, { ...OR, fetchImpl });
      for (const id of ['a/with-reasoning', 'a/with-effort']) {
        const p = await get(id);
        assert.deepEqual(levels(p), ['low', 'medium', 'high'], id);
        assert.equal(p.defaultReasoningLevel, null, id);
      }
      for (const id of ['a/output-only', 'a/none', 'a/unknown-params']) {
        const p = await get(id);
        assert.deepEqual(p.reasoningLevels, [], id);
        assert.equal(p.defaultReasoningLevel, null, id);
      }
      // include_reasoning sigue marcando que el modelo razona (comportamiento previo).
      assert.equal((await get('a/output-only')).reasoning, true);
    });

    it('OpenRouter: el nombre del modelo solo no habilita niveles', async () => {
      const p = await caps.getModelProfile('openrouter', 'openai/o4-mini', { ...OR, fetchImpl: orCatalog([entry('openai/o4-mini', ['tools'])]) });
      assert.deepEqual(p.reasoningLevels, []);
      const missing = await caps.getModelProfile('openrouter', 'openai/gpt-oss-120b', { ...OR, fetchImpl: failingFetch });
      assert.deepEqual(missing.reasoningLevels, []);
    });

    it('OpenRouter: listModels propaga los niveles', async () => {
      const models = await caps.listModels('openrouter', { ...OR, fetchImpl: orCatalog([entry('a/r', ['reasoning']), entry('a/p', ['tools'])]) });
      const by = Object.fromEntries(models.map((m) => [m.id, m]));
      assert.deepEqual(by['a/r'].reasoningLevels.map((l) => l.effort), ['low', 'medium', 'high']);
      assert.deepEqual(by['a/p'].reasoningLevels, []);
    });

    const NVIDIA_DOCUMENTED = [
      ['openai/gpt-oss-20b', ['low', 'medium', 'high'], 'medium'],
      ['openai/gpt-oss-120b', ['low', 'medium', 'high'], 'medium'],
      ['nvidia/nemotron-3-super-120b-a12b', ['none', 'low', 'high'], 'high'],
      ['nvidia/nemotron-3.5-super-vl-120b-a12b', ['none', 'low', 'high'], 'high'],
      ['meta/muse-glimmer-30b', ['none', 'minimal', 'low', 'medium', 'high', 'max'], 'high'],
    ];

    for (const [id, expected, def] of NVIDIA_DOCUMENTED) {
      it(`NVIDIA ${id}: niveles y default documentados, en perfil y en listModels`, async () => {
        const p = await caps.getModelProfile('nvidia', id, NIM);
        assert.deepEqual(levels(p), expected);
        assert.equal(p.defaultReasoningLevel, def);
        assert.equal(p.reasoning, true);
        const nimList = async () => new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
        const list = await caps.listModels('nvidia', { baseUrl: 'http://nim', apiKey: 'k', fetchImpl: nimList });
        assert.deepEqual(list[0].reasoningLevels.map((l) => l.effort), expected);
        assert.equal(list[0].defaultReasoningLevel, def);
      });
    }

    it('NVIDIA: modelos no documentados (incluido minimax sin confirmar) y variantes por nombre no ofrecen selector', async () => {
      for (const id of ['minimaxai/minimax-m3.1-flash', 'openai/gpt-oss-20b-v2', 'OPENAI/GPT-OSS-20B', 'deepseek-ai/deepseek-r1', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'someone/unknown']) {
        const p = await caps.getModelProfile('nvidia', id, NIM);
        assert.deepEqual(p.reasoningLevels, [], id);
        assert.equal(p.defaultReasoningLevel, null, id);
      }
    });

    it('resolveReasoningEffort valida contra los mismos niveles (OpenRouter y NVIDIA)', async () => {
      const fetchImpl = orCatalog([entry('a/r', ['reasoning']), entry('a/p', ['include_reasoning'])]);
      const or = { ...OR, fetchImpl };
      assert.equal(await caps.resolveReasoningEffort('openrouter', 'a/r', 'medium', or), 'medium');
      assert.equal(await caps.resolveReasoningEffort('openrouter', 'a/r', undefined, or), undefined);
      for (const bad of ['none', 'xhigh']) {
        await assert.rejects(caps.resolveReasoningEffort('openrouter', 'a/r', bad, or), (e) => e.kind === 'invalid_reasoning' && e.allowed.join() === 'low,medium,high');
      }
      await assert.rejects(caps.resolveReasoningEffort('openrouter', 'a/p', 'low', or), (e) => e.kind === 'invalid_reasoning');
      assert.equal(await caps.resolveReasoningEffort('nvidia', 'openai/gpt-oss-20b', 'low', NIM), 'low');
      assert.equal(await caps.resolveReasoningEffort('nvidia', 'nvidia/nemotron-3-super-120b-a12b', 'none', NIM), 'none');
      // Difiere por modelo: "medium" vale en gpt-oss pero no en nemotron.
      assert.equal(await caps.resolveReasoningEffort('nvidia', 'openai/gpt-oss-120b', 'medium', NIM), 'medium');
      await assert.rejects(caps.resolveReasoningEffort('nvidia', 'nvidia/nemotron-3-super-120b-a12b', 'medium', NIM), (e) => e.kind === 'invalid_reasoning' && e.allowed.join() === 'none,low,high');
      await assert.rejects(caps.resolveReasoningEffort('nvidia', 'openai/gpt-oss-20b', 'none', NIM), (e) => e.kind === 'invalid_reasoning');
      await assert.rejects(caps.resolveReasoningEffort('nvidia', 'someone/unknown', 'low', NIM), (e) => e.kind === 'invalid_reasoning' && e.allowed.length === 0);
    });
  });
});
