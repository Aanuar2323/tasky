import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './helpers/mock-llm.js';
import { FAKE_TOKENS, seedChatgptCredentials } from './helpers/chatgpt-creds.js';

const PORT = 9893;
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LOCAL_ORIGIN = 'http://localhost:3000';

const evt = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const completed = (usage = { input_tokens: 30, output_tokens: 12 }) => evt('response.completed', { response: { id: 'r', status: 'completed', model: 'gpt-test', usage, output: [] } });
const textSse = (text) => [evt('response.created', { response: {} }), evt('response.output_text.delta', { delta: text }), completed()];
const callSse = (call_id, name, args) => {
  const json = JSON.stringify(args);
  return [
    evt('response.created', { response: {} }),
    evt('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id, name, namespace: 'tasky', arguments: '' } }),
    evt('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_1', delta: json.slice(0, 9) }),
    evt('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_1', delta: json.slice(9) }),
    evt('response.function_call_arguments.done', { output_index: 0, item_id: 'fc_1', arguments: json }),
    evt('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id, name, namespace: 'tasky', arguments: json } }),
    completed(),
  ];
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

describe('ChatGPT e2e (Responses API simulada)', () => {
  let mock;
  let server;
  let tmpDir;
  let root;
  let projectId;
  let scenario;
  let authCalls;
  const realFetch = globalThis.fetch;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-chatgpt-e2e-'));
    mock = await startMockLlm((body, n, req) => (req.url.endsWith('/models')
      ? { json: { models: [{ slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' }, { slug: 'old', display_name: 'Old', visibility: 'hide' }] } }
      : scenario(body, req)));
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
    // auth.openai.com simulado (solo discovery y revocación); el resto va a la red local.
    authCalls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.startsWith('https://auth.openai.com')) return realFetch(url, init);
      authCalls.push({ url: u, form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null });
      if (u.endsWith('/openid-configuration')) {
        return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
      }
      if (u.endsWith('/oauth/revoke')) return new Response('', { status: 200 });
      return new Response('nope', { status: 404 });
    };
    const mod = await import('../src/index.js');
    server = mod.server;
    projectId = (await (await realFetch(`${BASE}/api/projects`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'E2E' }) })).json()).id;
    root = path.join(tmpDir, 'users', 'default', 'projects', projectId);
    await fs.mkdir(path.join(root, 'files'), { recursive: true });
    await fs.writeFile(path.join(root, 'files', 'notes.txt'), 'Contenido secreto de notas: 42');
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

  async function newChat(id) {
    const cfg = await (await api(`/api/projects/${projectId}/areas`)).json();
    cfg.areas[0].chats.push({ id, name: id });
    await api(`/api/projects/${projectId}/areas`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(cfg) });
    return id;
  }
  async function chat(chatId, message) {
    const res = await post(`/api/projects/${projectId}/chat`, { areaId: 'a1', chatId, message }, { Accept: 'text/event-stream' });
    return parseSse(await res.text());
  }

  it('el estado de ChatGPT no incluye tokens y refleja la sesión', async () => {
    const body = await (await api('/api/chatgpt/status')).text();
    const status = JSON.parse(body);
    assert.equal(status.signedIn, true);
    assert.equal(status.planUsage, true);
    assert.equal(status.email, 'seed@example.com');
    for (const secret of Object.values(FAKE_TOKENS)) assert.ok(!body.includes(secret));
    assert.ok(!body.includes('oaiapp_seed'));
    const providers = await (await api('/api/provider')).json();
    assert.equal(providers.providers.chatgpt.configured, true);
    assert.equal(providers.activeProvider, 'chatgpt', 'sin otras keys, ChatGPT pasa a ser el proveedor disponible');
    const s = await (await api('/api/status')).json();
    assert.equal(s.chatgptConfigured, true);
    assert.ok(!JSON.stringify(s).includes(FAKE_TOKENS.access));
  });

  it('protege el estado de la cuenta frente a otros orígenes', async () => {
    const res = await api('/api/chatgpt/status', { headers: { Origin: 'https://example.com' } });
    assert.equal(res.status, 403);
    assert.ok(!(await res.text()).includes('seed@example.com'));
  });

  it('lista los modelos de la cuenta (solo visibility=list)', async () => {
    const res = await api('/api/models?provider=chatgpt');
    assert.equal(res.status, 200);
    const { models } = await res.json();
    assert.deepEqual(models.map((m) => [m.id, m.name]), [['gpt-test', 'GPT Test']]);
    const req = mock.requests.at(-1);
    assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKENS.access}`);
  });

  it('valida los enums: chatgpt se elige, pero no tiene API key', async () => {
    assert.equal((await post('/api/provider', { provider: 'chatgpt' })).status, 200);
    assert.equal((await post('/api/provider/keys', { provider: 'chatgpt', apiKey: 'sk-xxxxxxxxxxxx' })).status, 400);
    assert.equal((await post('/api/provider', { provider: 'otro' })).status, 400);
    assert.equal((await api('/api/models?provider=otro')).status, 400);
    const patch = await api('/api/model', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ model: 'gpt-test', provider: 'chatgpt' }) });
    assert.equal(patch.status, 200);
  });

  it('chat con herramienta local: function_call → ejecución → function_call_output → respuesta', async () => {
    const chatId = await newChat('cg1');
    mock.requests.length = 0;
    scenario = (body) => {
      const hasOutput = body.input.some((i) => i.type === 'function_call_output');
      return { sse: hasOutput ? textSse('Las notas dicen 42.') : callSse('call_read_1', 'read_file', { path: 'files/notes.txt' }), noDone: true };
    };
    const events = await chat(chatId, 'Qué dicen las notas?');
    const done = events.find((e) => e.event === 'done')?.data.message;
    assert.equal(events[0].event, 'start');
    assert.equal(events[0].data.provider, 'chatgpt');
    assert.equal(done.content, 'Las notas dicen 42.');
    assert.equal(done.provider, 'chatgpt');
    assert.equal(done.model, 'gpt-test');
    assert.ok(done.usage.prompt_tokens >= 60);

    const [first, second] = responsesReqs();
    assert.equal(responsesReqs().length, 2);
    for (const req of [first, second]) {
      assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKENS.access}`);
      assert.equal(req.body.store, false);
      assert.equal(req.body.stream, true);
      assert.equal(req.body.model, 'gpt-test');
      assert.equal(req.body.tools[0].type, 'namespace');
      assert.ok(req.body.instructions.length > 100, 'el prompt de Tasky va en instructions');
      assert.ok(!req.body.input.some((i) => i.role === 'system'));
      for (const f of ['temperature', 'max_tokens', 'max_output_tokens', 'previous_response_id', 'messages', 'metadata', 'user']) {
        assert.equal(f in req.body, false, f);
      }
    }
    const types = second.body.input.map((i) => i.type ?? i.role);
    assert.deepEqual(types.slice(-2), ['function_call', 'function_call_output']);
    const call = second.body.input.at(-2);
    assert.equal(call.namespace, 'tasky');
    assert.equal(call.call_id, 'call_read_1');
    assert.deepEqual(JSON.parse(call.arguments), { path: 'files/notes.txt' });
    const output = second.body.input.at(-1);
    assert.equal(output.call_id, 'call_read_1');
    assert.match(output.output, /Contenido secreto de notas: 42/);
  });

  it('historial: el segundo mensaje reenvía los turnos previos dentro de input', async () => {
    const chatId = await newChat('cg2');
    scenario = () => ({ sse: textSse('Hola'), noDone: true });
    await chat(chatId, 'primero');
    mock.requests.length = 0;
    scenario = () => ({ sse: textSse('Segundo'), noDone: true });
    await chat(chatId, 'segundo');
    const { input } = responsesReqs()[0].body;
    assert.deepEqual(input.map((i) => [i.role, typeof i.content === 'string' ? i.content : '']).slice(-3), [['user', 'primero'], ['assistant', 'Hola'], ['user', 'segundo']].map(([r, c]) => [r, c]));
  });

  it('un límite de uso llega como error tipado con acción y se persiste', async () => {
    const chatId = await newChat('cg3');
    scenario = () => ({
      headers: { 'x-request-id': 'req_limit' },
      sse: [
        evt('response.created', { response: {} }),
        evt('response.failed', { response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }),
      ],
      noDone: true,
    });
    mock.requests.length = 0;
    const events = await chat(chatId, 'hola');
    const err = events.find((e) => e.event === 'error').data;
    assert.equal(err.kind, 'chatgpt_usage_limit');
    assert.equal(err.error.action, 'usage');
    assert.equal(err.error.code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(err.retriable, false);
    assert.equal(responsesReqs().length, 1, 'no repite la solicitud');
    const log = (await fs.readFile(path.join(root, 'chat', 'areas', 'a1', `${chatId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(log.at(-1).error.code, 'subscription_sharing_usage_limit_exceeded');
  });

  it('HTTP 403 por capacidad no soportada muestra el param y no reintenta', async () => {
    const chatId = await newChat('cg4');
    scenario = () => ({ status: 400, json: { error: { code: 'subscription_sharing_unsupported_capability', message: 'x', param: 'tools[0]' } } });
    mock.requests.length = 0;
    const events = await chat(chatId, 'hola');
    const err = events.find((e) => e.event === 'error').data;
    assert.equal(err.kind, 'chatgpt_unsupported');
    assert.equal(responsesReqs().length, 1);
  });

  it('login: rechaza orígenes externos, cuerpos con redirect y Docker', async () => {
    assert.equal((await post('/api/chatgpt/login', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/chatgpt/login', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post('/api/chatgpt/logout', {}, { Origin: 'https://evil.example' })).status, 403);
    const redirect = await post('/api/chatgpt/login', { redirect_uri: 'https://evil.example/cb' }, { Origin: LOCAL_ORIGIN });
    assert.equal(redirect.status, 400);
    const docker = await post('/api/chatgpt/login', {}, { Origin: LOCAL_ORIGIN });
    assert.equal(docker.status, 409);
    assert.equal((await docker.json()).code, 'container_unsupported');
    assert.equal((await (await api('/api/chatgpt/status')).json()).available, false);
  });

  it('logout revoca, borra tokens y el chat pide configurar de nuevo', async () => {
    authCalls.length = 0;
    const res = await post('/api/chatgpt/logout', {}, { Origin: LOCAL_ORIGIN });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, revoked: true });
    const revoke = authCalls.find((c) => c.url.endsWith('/oauth/revoke'));
    assert.deepEqual(revoke.form, { token: FAKE_TOKENS.refresh, token_type_hint: 'refresh_token', client_id: 'oaiapp_seed' });
    const status = await (await api('/api/chatgpt/status')).json();
    assert.equal(status.signedIn, false);
    assert.equal(status.planUsage, false);
    const stored = await fs.readFile(path.join(tmpDir, 'credentials', 'chatgpt', 'accounts', (await fs.readdir(path.join(tmpDir, 'credentials', 'chatgpt', 'accounts')))[0]), 'utf8');
    for (const secret of Object.values(FAKE_TOKENS)) assert.ok(!stored.includes(secret));
    assert.equal((await (await api('/api/provider')).json()).providers.chatgpt.configured, false);

    const chatId = await newChat('cg5');
    mock.requests.length = 0;
    const events = await chat(chatId, 'hola');
    assert.equal(events.find((e) => e.event === 'error').data.kind, 'not_configured');
    assert.equal(responsesReqs().length, 0);
    assert.equal((await post('/api/provider', { provider: 'chatgpt' })).status, 400);
  });
});
