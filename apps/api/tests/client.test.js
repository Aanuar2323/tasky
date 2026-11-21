import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startMockLlm, sseText, sseToolCall, jsonCompletion } from './helpers/mock-llm.js';

describe('llm/client chatCompletion', () => {
  let tmpDir;
  let client;
  let caps;
  let mock;

  const PROFILE = { id: 'mock/model', provider: 'openrouter', contextLength: 32000, maxOutput: 8000, tools: true, temperature: true, reasoning: false, vision: false };

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-client-'));
    process.env.STORAGE_ROOT = tmpDir;
    process.env.TASKY_RETRY_BASE_MS = '5';
    client = await import('../src/llm/client.js');
    caps = await import('../src/llm/capabilities.js');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    delete process.env.TASKY_RETRY_BASE_MS;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (mock) await mock.close();
    mock = null;
  });

  const target = () => ({ provider: 'openrouter', baseUrl: mock.url, apiKey: 'sk-test', model: 'mock/model', label: 'OpenRouter' });
  const msgs = [{ role: 'user', content: 'hola' }];

  it('stream: texto en deltas + usage + headers', async () => {
    mock = await startMockLlm(() => ({ sse: sseText('Hola, ¿cómo estás?') }));
    const events = [];
    const r = await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE, onEvent: (e) => events.push(e) });
    assert.equal(r.content, 'Hola, ¿cómo estás?');
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hola, ¿cómo estás?');
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.usage.completion_tokens, 5);
    const req = mock.completions()[0];
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.model, 'mock/model');
    assert.equal(req.body.max_tokens, 8000);
  });

  it('stream: reasoning y <think> no llegan al contenido', async () => {
    const sse = [
      { choices: [{ index: 0, delta: { reasoning: 'pienso ' } }] },
      { choices: [{ index: 0, delta: { reasoning_content: 'más' } }] },
      { choices: [{ index: 0, delta: { content: '<think>oculto</think>Visible' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    mock = await startMockLlm(() => ({ sse }));
    const events = [];
    const r = await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE, onEvent: (e) => events.push(e) });
    assert.equal(r.content, 'Visible');
    assert.equal(r.reasoning, 'pienso másoculto');
    assert.ok(events.some((e) => e.type === 'reasoning'));
    assert.ok(!events.filter((e) => e.type === 'delta').map((e) => e.text).join('').includes('oculto'));
  });

  it('stream: tool call fragmentada se reensambla', async () => {
    const args = { type: 'docx', filename: 'a.docx', data: { markdown: '# Hola' } };
    mock = await startMockLlm(() => ({ sse: sseToolCall('generate_file', args, { parts: 4, text: 'Listo. ' }) }));
    const events = [];
    const r = await client.chatCompletion({ messages: msgs, stream: true, tools: [{ type: 'function', function: { name: 'generate_file', parameters: { type: 'object' } } }], target: target(), profile: PROFILE, onEvent: (e) => events.push(e) });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'generate_file');
    assert.equal(r.toolCalls[0].id, 'call_1');
    assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), args);
    assert.equal(r.content, 'Listo. ');
    assert.equal(r.finishReason, 'tool_calls');
    assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'generate_file'));
    assert.ok(mock.completions()[0].body.tools);
  });

  it('no-stream: tool_calls y reasoning del mensaje', async () => {
    mock = await startMockLlm(() => ({ json: jsonCompletion({ content: 'ok', reasoning: 'r', toolCalls: [{ name: 'read_file', arguments: { path: 'a.md' } }] }) }));
    const r = await client.chatCompletion({ messages: msgs, stream: false, target: target(), profile: PROFILE });
    assert.equal(r.content, 'ok');
    assert.equal(r.reasoning, 'r');
    assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { path: 'a.md' });
  });

  it('stream pedido pero el proveedor responde JSON', async () => {
    mock = await startMockLlm(() => ({ json: jsonCompletion({ content: 'sin stream' }) }));
    const events = [];
    const r = await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE, onEvent: (e) => events.push(e) });
    assert.equal(r.content, 'sin stream');
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'sin stream');
  });

  it('temperature no soportada → reintenta sin ella y lo aprende', async () => {
    mock = await startMockLlm((body, n) => (n === 1
      ? { status: 400, json: { error: { message: 'Unsupported parameter: temperature is not supported with this model.' } } }
      : { json: jsonCompletion({ content: 'ok' }) }));
    const r = await client.chatCompletion({ messages: msgs, target: target(), profile: { ...PROFILE, id: 'm-temp' } });
    assert.equal(r.content, 'ok');
    const [a, b] = mock.completions();
    assert.ok('temperature' in a.body);
    assert.ok(!('temperature' in b.body));
    caps.clearCapabilityCache({ keepLearned: false });
    const learned = JSON.parse(await fs.readFile(path.join(tmpDir, 'model-capabilities.json'), 'utf8'));
    assert.equal(learned['openrouter::mock/model'].temperature, false);
  });

  it('max_tokens excesivo → reintenta con el límite indicado', async () => {
    mock = await startMockLlm((body, n) => (n === 1
      ? { status: 400, json: { error: { message: 'max_tokens must be less than or equal to 4096' } } }
      : { json: jsonCompletion({ content: 'ok' }) }));
    const r = await client.chatCompletion({ messages: msgs, target: target(), profile: PROFILE });
    assert.equal(r.content, 'ok');
    assert.equal(mock.completions()[1].body.max_tokens, 4096);
  });

  it('contexto excedido → recalcula salida con el tamaño informado', async () => {
    mock = await startMockLlm((body, n) => (n === 1
      ? { status: 400, json: { error: { message: "This model's maximum context length is 8192 tokens. However, you requested 12000 tokens (4000 in the messages, 8000 in the completion)." } } }
      : { json: jsonCompletion({ content: 'ok' }) }));
    await client.chatCompletion({ messages: msgs, target: target(), profile: PROFILE });
    const second = mock.completions()[1].body.max_tokens;
    assert.ok(second <= 4192 - 64 && second >= 1024, `max_tokens=${second}`);
  });

  it('402 "can only afford" → reintenta con menos tokens', async () => {
    mock = await startMockLlm((body, n) => (n === 1
      ? { status: 402, json: { error: { message: 'This request requires more credits, or fewer max_tokens. You requested up to 8000 tokens, but can only afford 3000.' } } }
      : { json: jsonCompletion({ content: 'ok' }) }));
    await client.chatCompletion({ messages: msgs, target: target(), profile: PROFILE });
    const second = mock.completions()[1].body.max_tokens;
    assert.ok(second < 3000 && second >= 2900);
  });

  it('429 con retry-after → reintenta', async () => {
    mock = await startMockLlm((body, n) => (n === 1
      ? { status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'Rate limit exceeded' } } }
      : { json: jsonCompletion({ content: 'ok' }) }));
    const r = await client.chatCompletion({ messages: msgs, target: target(), profile: PROFILE });
    assert.equal(r.content, 'ok');
    assert.equal(mock.completions().length, 2);
  });

  it('429 persistente → error rate_limited tras 3 intentos', async () => {
    mock = await startMockLlm(() => ({ status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'Rate limit exceeded' } } }));
    await assert.rejects(client.chatCompletion({ messages: msgs, target: target(), profile: PROFILE }), (e) => e.kind === 'rate_limited' && e.status === 429);
    assert.equal(mock.completions().length, 3);
  });

  it('404 sin soporte de tools → tools_unsupported y aprende tools=false', async () => {
    mock = await startMockLlm(() => ({ status: 404, json: { error: { message: 'No endpoints found that support tool use.' } } }));
    await assert.rejects(
      client.chatCompletion({ messages: msgs, tools: [{ type: 'function', function: { name: 'x', parameters: {} } }], target: { ...target(), model: 'm-notools' }, profile: { ...PROFILE, id: 'm-notools' } }),
      (e) => e.kind === 'tools_unsupported'
    );
    const p = await caps.getModelProfile('openrouter', 'm-notools', { baseUrl: mock.url, apiKey: 'k', fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(p.tools, false);
  });

  it('401 no se reintenta', async () => {
    mock = await startMockLlm(() => ({ status: 401, json: { error: { message: 'No auth credentials found' } } }));
    await assert.rejects(client.chatCompletion({ messages: msgs, target: target(), profile: PROFILE }), (e) => e.kind === 'unauthorized');
    assert.equal(mock.completions().length, 1);
  });

  it('abort durante el stream → kind aborted', async () => {
    mock = await startMockLlm(() => ({ sse: sseText('uno dos tres cuatro cinco seis siete', { size: 3 }), delayMs: 40 }));
    const ctrl = new AbortController();
    const p = client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE, signal: ctrl.signal, onEvent: (e) => { if (e.type === 'delta') ctrl.abort(); } });
    await assert.rejects(p, (e) => e.kind === 'aborted');
  });

  it('error a mitad de stream no reintenta ni duplica', async () => {
    mock = await startMockLlm(() => ({ sse: [
      { choices: [{ index: 0, delta: { content: 'parcial' } }] },
      { error: { message: 'Provider returned error', code: 502 }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] },
    ] }));
    const events = [];
    await assert.rejects(
      client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE, onEvent: (e) => events.push(e) }),
      (e) => e.kind === 'bad_gateway' && e.partialContent === 'parcial'
    );
    assert.equal(mock.completions().length, 1);
  });

  it('OpenRouter: reasoning low solo en modelos de razonamiento; NIM: stream_options', async () => {
    mock = await startMockLlm(() => ({ sse: sseText('ok') }));
    await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: { ...PROFILE, reasoning: true } });
    await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE });
    await client.chatCompletion({ messages: msgs, stream: true, target: { ...target(), provider: 'nvidia' }, profile: PROFILE });
    const [a, b, c] = mock.completions();
    assert.deepEqual(a.body.reasoning, { effort: 'low' });
    assert.equal(b.body.reasoning, undefined);
    assert.deepEqual(c.body.stream_options, { include_usage: true });
    assert.equal(c.body.reasoning, undefined);
  });

  describe('reasoningEffort explícito', () => {
    const LEVELS = [{ effort: 'low' }, { effort: 'high' }];
    const orProfile = { ...PROFILE, reasoning: true, reasoningLevels: LEVELS };

    it('OpenRouter: envía reasoning.effort elegido (no "low") cuando el modelo declara ese nivel', async () => {
      mock = await startMockLlm(() => ({ sse: sseText('ok') }));
      await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: orProfile, reasoningEffort: 'high' });
      assert.deepEqual(mock.completions()[0].body.reasoning, { effort: 'high' });
    });

    it('OpenRouter: nivel que el modelo no declara → invalid_reasoning sin llamar al proveedor', async () => {
      mock = await startMockLlm(() => ({ sse: sseText('ok') }));
      await assert.rejects(
        client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: orProfile, reasoningEffort: 'ultra' }),
        (e) => e.kind === 'invalid_reasoning' && e.status === 400
      );
      await assert.rejects(
        client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: PROFILE, reasoningEffort: 'low' }),
        (e) => e.kind === 'invalid_reasoning'
      );
      assert.equal(mock.completions().length, 0);
    });

    it('NVIDIA: sin niveles declarados una elección explícita es un error, no se descarta', async () => {
      mock = await startMockLlm(() => ({ sse: sseText('ok') }));
      await assert.rejects(
        client.chatCompletion({ messages: msgs, stream: true, target: { ...target(), provider: 'nvidia' }, profile: PROFILE, reasoningEffort: 'low' }),
        (e) => e.kind === 'invalid_reasoning'
      );
      assert.equal(mock.completions().length, 0);
    });

    it('OpenRouter: cada nivel estándar viaja como reasoning.effort', async () => {
      mock = await startMockLlm(() => ({ sse: sseText('ok') }));
      const profile = { ...PROFILE, reasoning: true, reasoningLevels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] };
      for (const effort of ['low', 'medium', 'high']) {
        await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile, reasoningEffort: effort });
      }
      assert.deepEqual(mock.completions().map((c) => c.body.reasoning), [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }]);
      assert.ok(mock.completions().every((c) => c.body.reasoning_effort === undefined));
    });

    describe('NVIDIA con niveles documentados', () => {
      const nvTarget = (model) => ({ ...target(), provider: 'nvidia', model });
      const nvProfile = (model, efforts) => ({ ...PROFILE, id: model, provider: 'nvidia', reasoning: true, reasoningLevels: efforts.map((effort) => ({ effort })) });

      it('envía reasoning_effort de primer nivel (sin objeto reasoning) solo con elección explícita', async () => {
        mock = await startMockLlm(() => ({ sse: sseText('ok') }));
        const m = 'openai/gpt-oss-120b';
        const profile = nvProfile(m, ['low', 'medium', 'high']);
        await client.chatCompletion({ messages: msgs, stream: true, target: nvTarget(m), profile, reasoningEffort: 'high' });
        await client.chatCompletion({ messages: msgs, stream: true, target: nvTarget(m), profile });
        const [explicit, auto] = mock.completions();
        assert.equal(explicit.body.model, m);
        assert.equal(explicit.body.reasoning_effort, 'high');
        assert.equal(explicit.body.reasoning, undefined);
        assert.deepEqual(explicit.body.stream_options, { include_usage: true });
        assert.equal('reasoning_effort' in auto.body, false);
        assert.equal('reasoning' in auto.body, false);
      });

      it('distintos modelos aceptan distintos niveles (none en nemotron, medium en gpt-oss)', async () => {
        mock = await startMockLlm(() => ({ sse: sseText('ok') }));
        const nemo = 'nvidia/nemotron-3-super-120b-a12b';
        const profile = nvProfile(nemo, ['none', 'low', 'high']);
        await client.chatCompletion({ messages: msgs, stream: true, target: nvTarget(nemo), profile, reasoningEffort: 'none' });
        assert.equal(mock.completions()[0].body.reasoning_effort, 'none');
        await assert.rejects(
          client.chatCompletion({ messages: msgs, stream: true, target: nvTarget(nemo), profile, reasoningEffort: 'medium' }),
          (e) => e.kind === 'invalid_reasoning' && e.allowed.join() === 'none,low,high'
        );
        assert.equal(mock.completions().length, 1);
      });

      it('un 400 del proveedor con nivel explícito se propaga sin quitar reasoning_effort ni reintentar', async () => {
        mock = await startMockLlm(() => ({ status: 400, json: { error: { message: 'reasoning_effort is not supported' } } }));
        const m = 'openai/gpt-oss-20b';
        await assert.rejects(
          client.chatCompletion({ messages: msgs, stream: true, target: nvTarget(m), profile: nvProfile(m, ['low', 'medium', 'high']), reasoningEffort: 'low' }),
          (e) => e.status === 400 && /reasoning_effort/.test(e.message)
        );
        assert.equal(mock.completions().length, 1);
        assert.equal(mock.completions()[0].body.reasoning_effort, 'low');
      });
    });

    it('OpenRouter: el error 400 de un nivel explícito se propaga (no se reintenta sin reasoning)', async () => {
      mock = await startMockLlm(() => ({ status: 400, json: { error: { message: 'reasoning effort not supported for this model' } } }));
      await assert.rejects(
        client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: orProfile, reasoningEffort: 'low' }),
        (e) => e.status === 400
      );
      assert.equal(mock.completions().length, 1);
      assert.deepEqual(mock.completions()[0].body.reasoning, { effort: 'low' });
    });

    it('OpenRouter sin elección conserva el comportamiento previo (low y reintento sin reasoning ante 400)', async () => {
      mock = await startMockLlm((body, n) => (n === 1 ? { status: 400, json: { error: { message: 'unsupported parameter: reasoning' } } } : { sse: sseText('ok') }));
      const r = await client.chatCompletion({ messages: msgs, stream: true, target: target(), profile: orProfile });
      assert.equal(r.content, 'ok');
      assert.deepEqual(mock.completions()[0].body.reasoning, { effort: 'low' });
      assert.equal(mock.completions()[1].body.reasoning, undefined);
    });
  });
});
