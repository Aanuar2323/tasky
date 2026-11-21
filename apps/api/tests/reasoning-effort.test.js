import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './helpers/mock-llm.js';
import { FAKE_TOKENS, seedChatgptCredentials } from './helpers/chatgpt-creds.js';

// Nivel de razonamiento de extremo a extremo contra la Responses API SIMULADA
// (sin cuenta ni red reales).

const PORT = 9894;
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const evt = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const completed = () => evt('response.completed', { response: { id: 'r', status: 'completed', model: 'gpt-test', usage: { input_tokens: 30, output_tokens: 12 }, output: [] } });
const textSse = (text) => [evt('response.created', { response: {} }), evt('response.output_text.delta', { delta: text }), completed()];
const callSse = (call_id, name, args) => {
  const json = JSON.stringify(args);
  return [
    evt('response.created', { response: {} }),
    evt('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id, name, namespace: 'tasky', arguments: '' } }),
    evt('response.function_call_arguments.done', { output_index: 0, item_id: 'fc_1', arguments: json }),
    evt('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id, name, namespace: 'tasky', arguments: json } }),
    completed(),
  ];
};

// Catálogo simulado: niveles distintos por modelo; `plain` no declara ninguno.
const CATALOG = {
  models: [
    { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list', supported_reasoning_levels: [{ effort: 'low', description: 'Rápido' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], default_reasoning_level: 'medium' },
    { slug: 'gpt-max', display_name: 'GPT Max', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }, { effort: 'ultra' }], default_reasoning_level: 'high' },
    { slug: 'plain', display_name: 'Plain', visibility: 'list', supported_reasoning_levels: [] },
  ],
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

describe('nivel de razonamiento (ChatGPT simulado)', () => {
  let mock;
  let server;
  let tmpDir;
  let root;
  let projectId;
  let scenario;
  let catalogCalls;
  const realFetch = globalThis.fetch;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-reasoning-'));
    catalogCalls = 0;
    mock = await startMockLlm((body, n, req) => {
      if (req.url.endsWith('/models')) {
        catalogCalls += 1;
        return { json: CATALOG };
      }
      return scenario(body, req);
    });
    Object.assign(process.env, {
      STORAGE_ROOT: tmpDir,
      PORT: String(PORT),
      TASKY_CHATGPT_API_BASE_URL: mock.url,
      TASKY_RETRY_BASE_MS: '1',
      TASKY_DISABLE_COMPACTION: '1',
      TASKY_IN_DOCKER: '1',
    });
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    await seedChatgptCredentials(tmpDir);
    // Solo auth.openai.com está interceptado; el resto va a la red local.
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.startsWith('https://auth.openai.com')) return realFetch(url, init);
      if (u.endsWith('/openid-configuration')) {
        return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
      }
      return new Response('nope', { status: 404 });
    };
    const mod = await import('../src/index.js');
    server = mod.server;
    projectId = (await (await realFetch(`${BASE}/api/projects`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'RE' }) })).json()).id;
    root = path.join(tmpDir, 'users', 'default', 'projects', projectId);
    await fs.mkdir(path.join(root, 'files'), { recursive: true });
    await fs.writeFile(path.join(root, 'files', 'notes.txt'), 'notas: 42');
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    for (const k of ['STORAGE_ROOT', 'PORT', 'TASKY_CHATGPT_API_BASE_URL', 'TASKY_RETRY_BASE_MS', 'TASKY_DISABLE_COMPACTION', 'TASKY_IN_DOCKER']) delete process.env[k];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const api = (p, init = {}) => realFetch(`${BASE}${p}`, init);
  const post = (p, body, headers = {}) => api(p, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
  const responsesReqs = () => mock.requests.filter((r) => r.url.endsWith('/responses'));
  const selectModel = (model) => api('/api/model', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ model, provider: 'chatgpt' }) });
  const chatUrl = () => `/api/projects/${projectId}/chat`;
  let chatCount = 0;

  async function newChat() {
    chatCount += 1;
    const id = `re${chatCount}`;
    const cfg = await (await api(`/api/projects/${projectId}/areas`)).json();
    cfg.areas[0].chats.push({ id, name: id });
    await api(`/api/projects/${projectId}/areas`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(cfg) });
    return id;
  }
  const sseChat = async (chatId, extra = {}) => {
    const res = await post(chatUrl(), { areaId: 'a1', chatId, message: 'hola', ...extra }, { Accept: 'text/event-stream' });
    return res.headers.get('content-type')?.includes('text/event-stream')
      ? { status: res.status, events: parseSse(await res.text()) }
      : { status: res.status, json: await res.json() };
  };

  beforeEach(() => {
    mock.requests.length = 0;
    scenario = () => ({ sse: textSse('ok'), noDone: true });
  });

  it('carga los niveles al consultar el estado con el catálogo vacío', async () => {
    await selectModel('gpt-test');
    const { clearChatgptCatalog } = await import('../src/llm/responses.js');
    clearChatgptCatalog();
    const status = await (await api('/api/status')).json();
    assert.deepEqual(status.capabilities.reasoningLevels.map((l) => l.effort), ['low', 'medium', 'high', 'xhigh']);
  });

  it('el modelo activo expone sus niveles reales (y solo esos) en /api/models y /api/status', async () => {
    await selectModel('gpt-test');
    const { models } = await (await api('/api/models?provider=chatgpt')).json();
    const by = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.deepEqual(by['gpt-test'].reasoningLevels.map((l) => l.effort), ['low', 'medium', 'high', 'xhigh']);
    assert.equal(by['gpt-test'].reasoningLevels[0].description, 'Rápido');
    assert.equal(by['gpt-test'].defaultReasoningLevel, 'medium');
    assert.deepEqual(by['gpt-max'].reasoningLevels.map((l) => l.effort), ['high', 'max', 'ultra']);
    assert.deepEqual([by.plain.reasoning, by.plain.reasoningLevels], [false, []]);

    const status = await (await api('/api/status')).json();
    assert.deepEqual(status.capabilities.reasoningLevels.map((l) => l.effort), ['low', 'medium', 'high', 'xhigh']);
    assert.equal(status.capabilities.defaultReasoningLevel, 'medium');

    await selectModel('gpt-max');
    const next = await (await api('/api/status')).json();
    assert.deepEqual(next.capabilities.reasoningLevels.map((l) => l.effort), ['high', 'max', 'ultra']);
  });

  it('JSON: el nivel elegido llega exacto como reasoning:{effort}', async () => {
    await selectModel('gpt-test');
    const { events } = await sseChat(await newChat(), { reasoningEffort: 'xhigh' });
    assert.ok(events.some((e) => e.event === 'done'));
    assert.deepEqual(responsesReqs()[0].body.reasoning, { effort: 'xhigh' });
  });

  it('automático: sin campo no hay override en el cuerpo', async () => {
    await selectModel('gpt-test');
    await sseChat(await newChat());
    assert.equal(responsesReqs().length, 1);
    assert.equal('reasoning' in responsesReqs()[0].body, false);
  });

  it('multipart con adjuntos: el nivel viaja en el formulario y se aplica', async () => {
    await selectModel('gpt-max');
    const chatId = await newChat();
    const form = new FormData();
    form.append('areaId', 'a1');
    form.append('chatId', chatId);
    form.append('message', 'mirá el adjunto');
    form.append('reasoningEffort', 'ultra');
    form.append('attachments', new Blob(['dato adjunto 7'], { type: 'text/plain' }), 'adjunto.txt');
    const res = await api(chatUrl(), { method: 'POST', headers: { Accept: 'text/event-stream' }, body: form });
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.event === 'done'));
    const [req] = responsesReqs();
    assert.deepEqual(req.body.reasoning, { effort: 'ultra' });
    assert.match(JSON.stringify(req.body.input), /dato adjunto 7/);
  });

  it('regeneración: respeta el nivel enviado con regenerate', async () => {
    await selectModel('gpt-test');
    const chatId = await newChat();
    await sseChat(chatId, { reasoningEffort: 'low' });
    mock.requests.length = 0;
    const { events } = await sseChat(chatId, { regenerate: true, message: undefined, reasoningEffort: 'high' });
    assert.ok(events.some((e) => e.event === 'done'));
    assert.deepEqual(responsesReqs()[0].body.reasoning, { effort: 'high' });
  });

  it('turno con herramientas: todas las iteraciones usan el mismo nivel', async () => {
    await selectModel('gpt-test');
    scenario = (body) => ({
      sse: body.input.some((i) => i.type === 'function_call_output') ? textSse('Dicen 42.') : callSse('call_1', 'read_file', { path: 'files/notes.txt' }),
      noDone: true,
    });
    const { events } = await sseChat(await newChat(), { reasoningEffort: 'high' });
    assert.equal(events.find((e) => e.event === 'done').data.message.content, 'Dicen 42.');
    const reqs = responsesReqs();
    assert.equal(reqs.length, 2);
    for (const r of reqs) assert.deepEqual(r.body.reasoning, { effort: 'high' });
  });

  it('nivel que el modelo activo no declara → 400 claro, sin llamar a /responses ni guardar el mensaje', async () => {
    await selectModel('gpt-test');
    const chatId = await newChat();
    const { status, json } = await sseChat(chatId, { reasoningEffort: 'ultra' });
    assert.equal(status, 400);
    assert.equal(json.kind, 'invalid_reasoning');
    assert.deepEqual(json.allowed, ['low', 'medium', 'high', 'xhigh']);
    assert.match(json.error, /ultra/);
    assert.equal(responsesReqs().length, 0);
    const log = await fs.readFile(path.join(root, 'chat', 'areas', 'a1', `${chatId}.jsonl`), 'utf8').catch(() => '');
    assert.equal(log.trim(), '', 'no se persiste el turno rechazado');
  });

  it('cambiar de modelo no arrastra un nivel que el nuevo no admite', async () => {
    await selectModel('gpt-test');
    assert.equal((await sseChat(await newChat(), { reasoningEffort: 'xhigh' })).status, 200);
    await selectModel('gpt-max');
    mock.requests.length = 0;
    const { status, json } = await sseChat(await newChat(), { reasoningEffort: 'xhigh' });
    assert.equal(status, 400);
    assert.deepEqual(json.allowed, ['high', 'max', 'ultra']);
    assert.equal(responsesReqs().length, 0);
  });

  it('modelo sin niveles en el catálogo: cualquier nivel explícito es error', async () => {
    await selectModel('plain');
    const { status, json } = await sseChat(await newChat(), { reasoningEffort: 'low' });
    assert.equal(status, 400);
    assert.equal(json.kind, 'invalid_reasoning');
    assert.equal(responsesReqs().length, 0);
  });

  it('valores mal formados se rechazan en el esquema (400), incluidos vacío y repetidos', async () => {
    await selectModel('gpt-test');
    const chatId = await newChat();
    for (const bad of ['', 'LOW; DROP', 'a'.repeat(40), 'x y']) {
      const res = await post(chatUrl(), { areaId: 'a1', chatId, message: 'hola', reasoningEffort: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const nonString = await post(chatUrl(), { areaId: 'a1', chatId, message: 'hola', reasoningEffort: 5 });
    assert.equal(nonString.status, 400);
    const form = new FormData();
    for (const [k, v] of [['areaId', 'a1'], ['chatId', chatId], ['message', 'hola'], ['reasoningEffort', 'low'], ['reasoningEffort', 'high']]) form.append(k, v);
    assert.equal((await api(chatUrl(), { method: 'POST', body: form })).status, 400);
    assert.equal(responsesReqs().length, 0);
  });

  it('valida contra el catálogo aunque no estuviera en memoria (lo consulta)', async () => {
    await selectModel('gpt-test');
    const { clearChatgptCatalog } = await import('../src/llm/responses.js');
    clearChatgptCatalog();
    const before = catalogCalls;
    const { events } = await sseChat(await newChat(), { reasoningEffort: 'low' });
    assert.ok(events.some((e) => e.event === 'done'));
    assert.ok(catalogCalls > before);
    assert.deepEqual(responsesReqs()[0].body.reasoning, { effort: 'low' });
    assert.equal(responsesReqs()[0].headers.authorization, `Bearer ${FAKE_TOKENS.access}`);
  });
});
