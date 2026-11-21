import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './helpers/mock-llm.js';
import {
  buildRequestBody,
  listChatgptModels,
  modelInfo,
  responsesCompletion,
  toResponsesInput,
  toResponsesTools,
} from '../src/llm/responses.js';
import { TOOL_DEFS } from '../src/chat/tools.js';

const evt = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const created = evt('response.created', { response: { id: 'resp_1', status: 'in_progress' } });
const completed = (extra = {}) => evt('response.completed', {
  response: { id: 'resp_1', status: 'completed', model: 'gpt-test', usage: { input_tokens: 11, output_tokens: 7 }, output: [], ...extra },
});

const textStream = (text, { size = 5 } = {}) => [
  created,
  ...text.match(new RegExp(`.{1,${size}}`, 'gs')).map((delta) => evt('response.output_text.delta', { delta, output_index: 0, content_index: 0 })),
  completed(),
];

function functionCallStream(calls, { text } = {}) {
  const out = [created];
  if (text) out.push(evt('response.output_text.delta', { delta: text, output_index: 0 }));
  calls.forEach(({ call_id, name, args, namespace = 'tasky' }, i) => {
    const idx = i + (text ? 1 : 0);
    const json = typeof args === 'string' ? args : JSON.stringify(args);
    out.push(evt('response.output_item.added', { output_index: idx, item: { type: 'function_call', id: `fc_${i}`, call_id, name, namespace, arguments: '' } }));
    const step = Math.ceil(json.length / 3);
    for (let p = 0; p < json.length; p += step) {
      out.push(evt('response.function_call_arguments.delta', { output_index: idx, item_id: `fc_${i}`, delta: json.slice(p, p + step) }));
    }
    out.push(evt('response.function_call_arguments.done', { output_index: idx, item_id: `fc_${i}`, arguments: json }));
    out.push(evt('response.output_item.done', { output_index: idx, item: { type: 'function_call', id: `fc_${i}`, call_id, name, namespace, arguments: json } }));
  });
  out.push(completed());
  return out;
}

const FORBIDDEN_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
  'max_tokens', 'messages',
];

describe('responses: conversión de mensajes', () => {
  const toolNames = TOOL_DEFS.map((t) => t.function.name);

  it('el system va a instructions y nunca como item role=system', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'Sos Tasky' },
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
      { role: 'user', content: 'gracias' },
    ], toolNames);
    assert.equal(instructions, 'Sos Tasky');
    assert.deepEqual(input, [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
      { role: 'user', content: 'gracias' },
    ]);
    assert.ok(!input.some((i) => i.role === 'system'));
  });

  it('un system posterior se envía como developer', () => {
    const { input } = toResponsesInput([{ role: 'user', content: 'a' }, { role: 'system', content: 'nota' }]);
    assert.deepEqual(input[1], { role: 'developer', content: 'nota' });
  });

  it('adjuntos de imagen → input_text + input_image', () => {
    const { input } = toResponsesInput([{
      role: 'user',
      content: [{ type: 'text', text: 'mirá' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }]);
    assert.deepEqual(input[0].content, [
      { type: 'input_text', text: 'mirá' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('tool calls del asistente → function_call con namespace; resultados → function_call_output', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: 'leé el archivo' },
      {
        role: 'assistant',
        content: 'Voy a leerlo',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"files/x.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_a', name: 'read_file', content: 'contenido' },
    ], toolNames);
    assert.deepEqual(input.slice(1), [
      { role: 'assistant', content: 'Voy a leerlo' },
      { type: 'function_call', call_id: 'call_a', namespace: 'tasky', name: 'read_file', arguments: '{"path":"files/x.txt"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'contenido' },
    ]);
  });

  it('asistente solo con tool calls no genera mensaje vacío', () => {
    const { input } = toResponsesInput([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: {} } }] },
    ], toolNames);
    assert.equal(input.length, 1);
    assert.equal(input[0].type, 'function_call');
    assert.equal(input[0].arguments, '{}');
  });

  it('ids de llamada inválidos o largos se normalizan igual en la llamada y en su resultado', () => {
    const long = `call_${'x'.repeat(80)}`;
    const { input } = toResponsesInput([
      { role: 'assistant', content: '', tool_calls: [{ id: long, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: long, content: 'ok' },
    ], toolNames);
    assert.equal(input[0].call_id, input[1].call_id);
    assert.match(input[0].call_id, /^[\w-]{1,64}$/);
  });

  it('una herramienta desconocida no recibe namespace', () => {
    const { input } = toResponsesInput([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'otra', arguments: '{}' } }] },
    ], toolNames);
    assert.equal('namespace' in input[0], false);
  });
});

describe('responses: herramientas y cuerpo de la solicitud', () => {
  it('agrupa las funciones en un namespace con strict=false', () => {
    const tools = toResponsesTools(TOOL_DEFS);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'namespace');
    assert.equal(tools[0].name, 'tasky');
    assert.deepEqual(tools[0].tools.map((t) => t.name), ['generate_file', 'edit_file', 'read_file']);
    for (const t of tools[0].tools) {
      assert.equal(t.type, 'function');
      assert.equal(t.strict, false);
      assert.equal(t.parameters.type, 'object');
      assert.equal('function' in t, false);
    }
    assert.ok(!JSON.stringify(tools).includes('tool_search'));
  });

  it('sin herramientas no envía tools ni tool_choice', () => {
    assert.equal(toResponsesTools([]), undefined);
    const body = buildRequestBody({ model: 'm', messages: [{ role: 'user', content: 'x' }], toolChoice: 'auto' });
    assert.equal('tools' in body, false);
    assert.equal('tool_choice' in body, false);
  });

  it('store=false, stream=true y ningún campo no admitido', () => {
    const body = buildRequestBody({
      model: 'gpt-x',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      tools: TOOL_DEFS,
      toolChoice: 'none',
    });
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'gpt-x');
    assert.equal(body.instructions, 's');
    assert.ok(Array.isArray(body.input));
    assert.equal(body.tool_choice, 'none');
    for (const f of FORBIDDEN_FIELDS) assert.equal(f in body, false, `no debe enviar ${f}`);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'store', 'stream', 'tool_choice', 'tools']);
  });

  it('tool_choice auto se omite y uno forzado referencia el namespace', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOL_DEFS };
    assert.equal('tool_choice' in buildRequestBody({ ...base, toolChoice: 'auto' }), false);
    assert.deepEqual(buildRequestBody({ ...base, toolChoice: { type: 'function', function: { name: 'read_file' } } }).tool_choice,
      { type: 'function', name: 'read_file', namespace: 'tasky' });
  });
});

describe('responses: streaming, tools y errores (servidor simulado)', () => {
  let mock;
  let scenario;
  let tokens;
  let auth;

  before(async () => {
    mock = await startMockLlm((body, n, req) => scenario(body, req));
    process.env.TASKY_CHATGPT_API_BASE_URL = mock.url;
    process.env.TASKY_RETRY_BASE_MS = '1';
  });
  after(async () => {
    delete process.env.TASKY_CHATGPT_API_BASE_URL;
    delete process.env.TASKY_RETRY_BASE_MS;
    await mock.close();
  });
  beforeEach(() => {
    mock.requests.length = 0;
    tokens = { current: 'access-1', refreshes: [] };
    auth = {
      getAccessToken: async ({ staleToken } = {}) => {
        if (staleToken !== undefined) {
          tokens.refreshes.push(staleToken);
          tokens.current = `access-${tokens.refreshes.length + 1}`;
        }
        return tokens.current;
      },
    };
  });

  const responses = () => mock.requests.filter((r) => r.url.endsWith('/responses'));
  const run = (opts = {}, events = []) => responsesCompletion({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }],
    target: { model: 'gpt-test' },
    onEvent: (e) => events.push(e),
    ...opts,
  }, { auth });

  it('transmite texto, informa uso y envía Bearer + body del flujo', async () => {
    scenario = () => ({ sse: textStream('Hola desde ChatGPT'), noDone: true });
    const events = [];
    const out = await run({ tools: TOOL_DEFS }, events);
    assert.equal(out.content, 'Hola desde ChatGPT');
    assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hola desde ChatGPT');
    assert.deepEqual(out.usage.prompt_tokens, 11);
    assert.equal(out.usage.completion_tokens, 7);
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.toolCalls, []);
    const [req] = responses();
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer access-1');
    assert.match(req.headers.accept, /text\/event-stream/);
    assert.equal(req.body.store, false);
    assert.equal(req.body.stream, true);
    assert.equal(req.body.instructions, 'sys');
    assert.equal(req.body.tools[0].type, 'namespace');
    for (const f of FORBIDDEN_FIELDS) assert.equal(f in req.body, false, f);
  });

  it('reasoning: envía {effort} exacto solo si hay elección; sin ella no hay override', async () => {
    scenario = () => ({ sse: textStream('ok'), noDone: true });
    await run({ reasoningEffort: 'xhigh' });
    await run();
    await run({ reasoningEffort: '' });
    const [chosen, auto, empty] = responses();
    assert.deepEqual(chosen.body.reasoning, { effort: 'xhigh' });
    assert.equal('reasoning' in auto.body, false);
    assert.equal('reasoning' in empty.body, false);
  });

  it('reconstruye una llamada a función con argumentos fragmentados y namespace', async () => {
    const args = { type: 'docx', filename: 'a.docx', data: { title: 'T' } };
    scenario = () => ({ sse: functionCallStream([{ call_id: 'call_gen', name: 'generate_file', args }], { text: 'Listo, genero.' }), noDone: true });
    const events = [];
    const out = await run({ tools: TOOL_DEFS }, events);
    assert.equal(out.content, 'Listo, genero.');
    assert.equal(out.finishReason, 'tool_calls');
    assert.deepEqual(out.toolCalls, [{ id: 'call_gen', name: 'generate_file', arguments: JSON.stringify(args) }]);
    assert.deepEqual(events.filter((e) => e.type === 'tool_call').map((e) => e.name), ['generate_file']);
  });

  it('varias llamadas en paralelo conservan orden y call_id', async () => {
    scenario = () => ({
      sse: functionCallStream([
        { call_id: 'call_1', name: 'read_file', args: { path: 'files/a.txt' } },
        { call_id: 'call_2', name: 'read_file', args: { path: 'files/b.txt' } },
      ]),
      noDone: true,
    });
    const out = await run({ tools: TOOL_DEFS });
    assert.deepEqual(out.toolCalls.map((c) => [c.id, JSON.parse(c.arguments).path]), [['call_1', 'files/a.txt'], ['call_2', 'files/b.txt']]);
  });

  it('acepta un nombre con prefijo de namespace si corresponde a una herramienta conocida', async () => {
    scenario = () => ({ sse: functionCallStream([{ call_id: 'c', name: 'tasky.read_file', args: {}, namespace: undefined }]), noDone: true });
    const out = await run({ tools: TOOL_DEFS });
    assert.equal(out.toolCalls[0].name, 'read_file');
  });

  it('el siguiente turno devuelve la llamada y su resultado dentro de input (sin previous_response_id)', async () => {
    scenario = () => ({ sse: textStream('Resumen listo'), noDone: true });
    await run({
      tools: TOOL_DEFS,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'leé a.txt' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"files/a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'hola mundo' },
      ],
    });
    const { input } = responses()[0].body;
    assert.deepEqual(input.map((i) => i.type ?? i.role), ['user', 'function_call', 'function_call_output']);
    assert.equal(input[1].namespace, 'tasky');
    assert.equal(input[2].output, 'hola mundo');
    assert.equal('previous_response_id' in responses()[0].body, false);
  });

  it('usa el contenido de response.completed si el stream no trajo deltas', async () => {
    scenario = () => ({
      sse: [created, completed({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Respuesta final' }] }] })],
      noDone: true,
    });
    const events = [];
    const out = await run({}, events);
    assert.equal(out.content, 'Respuesta final');
    assert.equal(events.filter((e) => e.type === 'delta').length, 1);
  });

  it('emite razonamiento del resumen sin mezclarlo con el contenido', async () => {
    scenario = () => ({
      sse: [created, evt('response.reasoning_summary_text.delta', { delta: 'pienso…' }), evt('response.output_text.delta', { delta: 'ok' }), completed()],
      noDone: true,
    });
    const events = [];
    const out = await run({}, events);
    assert.equal(out.reasoning, 'pienso…');
    assert.equal(out.content, 'ok');
  });

  it('un stream sin response.completed es un error de interrupción', async () => {
    scenario = () => ({ sse: [created, evt('response.output_text.delta', { delta: 'par' })], noDone: true });
    await assert.rejects(run(), (e) => e.kind === 'interrupted' && e.partialContent === 'par');
    // Ya había emitido texto: no se reintenta (evita duplicados).
    assert.equal(responses().length, 1);
  });

  it('un corte antes de emitir algo se reintenta con backoff acotado', async () => {
    scenario = () => ({ sse: [created], noDone: true });
    await assert.rejects(run(), (e) => e.kind === 'interrupted');
    assert.equal(responses().length, 3);
  });

  it('response.failed tras empezar el stream conserva código y request ID y no se reintenta', async () => {
    scenario = () => ({
      headers: { 'x-request-id': 'req_abc' },
      sse: [
        created,
        evt('response.output_text.delta', { delta: 'parcial' }),
        evt('response.failed', { response: { id: 'resp_1', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'límite' } } }),
      ],
      noDone: true,
    });
    await assert.rejects(run(), (e) => {
      assert.equal(e.kind, 'chatgpt_usage_limit');
      assert.equal(e.code, 'subscription_sharing_usage_limit_exceeded');
      assert.equal(e.status, 429);
      assert.equal(e.requestId, 'req_abc');
      assert.equal(e.partialContent, 'parcial');
      return true;
    });
    assert.equal(responses().length, 1);
  });

  it('response.failed con un código desconocido no se trata como éxito', async () => {
    scenario = () => ({ sse: [created, evt('response.failed', { response: { error: { code: 'server_error', message: 'boom' } } })], noDone: true });
    await assert.rejects(run(), (e) => e.code === 'server_error');
  });

  it('response.incomplete se informa aparte', async () => {
    scenario = () => ({
      sse: [created, evt('response.output_text.delta', { delta: 'corta' }), evt('response.incomplete', { response: { incomplete_details: { reason: 'content_filter' } } })],
      noDone: true,
    });
    await assert.rejects(run(), (e) => e.kind === 'chatgpt_incomplete' && e.code === 'content_filter' && e.retriable === false);
  });

  it('un evento "error" en el stream es un error explícito', async () => {
    scenario = () => ({ sse: [created, evt('error', { code: 'subscription_sharing_usage_unavailable', message: 'x', param: null })], noDone: true });
    await assert.rejects(run(), (e) => e.kind === 'unavailable' && e.status === 503);
  });

  it('un 200 que no es event-stream es un error', async () => {
    scenario = () => ({ json: { id: 'resp_1' } });
    await assert.rejects(run(), (e) => e.kind === 'bad_gateway');
  });

  it('acepta eventos SSE válidos sin cabecera Content-Type', async () => {
    const bytes = new TextEncoder().encode(textStream('Hola sin cabecera').join(''));
    const out = await responsesCompletion({
      messages: [{ role: 'user', content: 'hola' }],
      target: { model: 'gpt-test' },
    }, { auth, fetchImpl: async () => new Response(bytes, { status: 200 }) });
    assert.equal(out.content, 'Hola sin cabecera');
  });

  describe('errores HTTP antes de abrir el stream', () => {
    const table = [
      [401, 'subscription_sharing_invalid_user', 'chatgpt_unauthorized'],
      [403, 'subscription_sharing_user_not_eligible', 'chatgpt_not_eligible'],
      [403, 'subscription_sharing_route_not_supported', 'chatgpt_route'],
      [403, 'chatpass_v2_scope_not_authorized', 'chatgpt_denied'],
      [403, 'chatpass_v2_invalid_authorization_context', 'chatgpt_denied'],
      [400, 'subscription_sharing_unsupported_capability', 'chatgpt_unsupported'],
      [429, 'subscription_sharing_usage_limit_exceeded', 'chatgpt_usage_limit'],
      [503, 'subscription_sharing_usage_unavailable', 'unavailable'],
      [503, 'subscription_sharing_user_unavailable', 'unavailable'],
    ];
    for (const [status, code, kind] of table) {
      it(`${status} ${code} → ${kind}`, async () => {
        scenario = () => ({ status, headers: { 'x-request-id': 'req_9' }, json: { error: { code, message: 'detalle', param: 'tools[0]' } } });
        await assert.rejects(run(), (e) => {
          assert.equal(e.kind, kind);
          assert.equal(e.status, status);
          assert.equal(e.code, code);
          assert.equal(e.param, 'tools[0]');
          assert.equal(e.requestId, 'req_9');
          return true;
        });
        const attempts = responses().length;
        if (kind === 'unavailable') assert.equal(attempts, 3, 'reintenta con backoff acotado');
        else if (status === 401) assert.equal(attempts, 2, 'un refresh y un reintento');
        else assert.equal(attempts, 1, 'no repite la misma solicitud');
      });
    }

    it('cuerpo {"detail":…} sin objeto error: 403 → chatgpt_forbidden, 503 → unavailable', async () => {
      scenario = () => ({ status: 403, json: { detail: 'region not allowed' } });
      await assert.rejects(run(), (e) => e.kind === 'chatgpt_forbidden' && /region not allowed/.test(e.message) && e.code === null);
      scenario = () => ({ status: 503, json: { detail: 'direct routing unavailable' } });
      await assert.rejects(run(), (e) => e.kind === 'unavailable' && e.retriable === true);
    });

    it('401: renueva el token una vez y reintenta con el nuevo', async () => {
      let n = 0;
      scenario = (body, req) => {
        n += 1;
        return req.headers.authorization === 'Bearer access-2'
          ? { sse: textStream('ok'), noDone: true }
          : { status: 401, json: { detail: 'invalid token' } };
      };
      const out = await run();
      assert.equal(out.content, 'ok');
      assert.deepEqual(tokens.refreshes, ['access-1']);
      assert.equal(n, 2);
    });

    it('401 con sesión vencida de forma terminal propaga reauth_required', async () => {
      scenario = () => ({ status: 401, json: { detail: 'x' } });
      auth.getAccessToken = async ({ staleToken } = {}) => {
        if (staleToken !== undefined) throw Object.assign(new Error('vencida'), { kind: 'chatgpt_reauth_required' });
        return 'access-1';
      };
      await assert.rejects(run(), (e) => e.kind === 'chatgpt_reauth_required');
    });

    it('429 sin código estructurado respeta Retry-After y es reintentable', async () => {
      scenario = () => ({ status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } });
      await assert.rejects(run(), (e) => e.kind === 'rate_limited');
      assert.equal(responses().length, 3);
    });
  });

  it('abortar la solicitud devuelve aborted sin reintentar', async () => {
    scenario = () => ({ sse: [created, evt('response.output_text.delta', { delta: 'a' })], delayMs: 200, hang: true });
    const controller = new AbortController();
    const promise = run({ signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(promise, (e) => e.kind === 'aborted');
    assert.equal(responses().length, 1);
  });

  it('sin modelo elegido avisa antes de llamar a la red', async () => {
    await assert.rejects(responsesCompletion({ messages: [], target: { model: '' } }, { auth }), (e) => e.kind === 'not_configured');
    assert.equal(responses().length, 0);
  });

  it('sin sesión propaga el error de autenticación sin llamar a la API', async () => {
    auth.getAccessToken = async () => { throw Object.assign(new Error('no hay sesión'), { kind: 'chatgpt_not_signed_in' }); };
    await assert.rejects(run(), (e) => e.kind === 'chatgpt_not_signed_in');
    assert.equal(responses().length, 0);
  });

  describe('catálogo de modelos', () => {
    const CATALOG = {
      models: [
        { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list', context_window: 200000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }] },
        { slug: 'hidden', display_name: 'Oculto', visibility: 'hide' },
        { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' },
        { slug: 'sin-nombre', visibility: 'list' },
      ],
    };

    it('muestra solo visibility=list conservando el orden del servidor', async () => {
      scenario = () => ({ json: CATALOG });
      const models = await listChatgptModels({ auth });
      assert.deepEqual(models.map((m) => [m.id, m.name]), [['gpt-b', 'GPT B'], ['gpt-a', 'GPT A'], ['sin-nombre', 'sin-nombre']]);
      assert.equal(models[0].contextLength, 200000);
      assert.equal(models[0].vision, true);
      assert.equal(models[1].vision, false);
      const [req] = mock.requests;
      assert.equal(req.method, 'GET');
      assert.ok(req.url.endsWith('/models'));
      assert.equal(req.headers.authorization, 'Bearer access-1');
    });

    it('renueva el token ante 401 y falla con error tipado si el catálogo es inválido', async () => {
      scenario = (b, req) => (req.headers.authorization === 'Bearer access-2' ? { json: CATALOG } : { status: 401, json: { detail: 'x' } });
      assert.equal((await listChatgptModels({ auth })).length, 3);
      scenario = () => ({ json: { data: [] } });
      await assert.rejects(listChatgptModels({ auth }), (e) => e.kind === 'bad_gateway');
      scenario = () => ({ status: 403, json: { error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } } });
      await assert.rejects(listChatgptModels({ auth }), (e) => e.kind === 'chatgpt_not_eligible');
    });

    it('modelInfo usa valores conservadores si el catálogo no declara capacidades', () => {
      assert.deepEqual(modelInfo({ slug: 'x' }), {
        id: 'x', name: 'x', isFree: false, tools: true, vision: false, reasoning: false, reasoningLevels: [], defaultReasoningLevel: null,
      });
    });

    it('modelInfo conserva los niveles de razonamiento reales del catálogo, en orden y sin inventar', () => {
      const info = modelInfo({
        slug: 'gpt-r',
        supported_reasoning_levels: [{ effort: 'low', description: 'Rápido' }, { effort: 'xhigh' }, { effort: 'ultra', description: 'Máximo' }, { effort: 'low' }, { effort: 'bad value!' }, { description: 'sin effort' }, null],
        default_reasoning_level: 'xhigh',
      });
      assert.equal(info.reasoning, true);
      assert.deepEqual(info.reasoningLevels, [{ effort: 'low', description: 'Rápido' }, { effort: 'xhigh' }, { effort: 'ultra', description: 'Máximo' }]);
      assert.equal(info.defaultReasoningLevel, 'xhigh');
    });

    it('modelInfo: un default que no figura en los niveles se descarta; lista vacía = sin razonamiento configurable', () => {
      assert.equal(modelInfo({ slug: 'a', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'high' }).defaultReasoningLevel, null);
      const none = modelInfo({ slug: 'b', supported_reasoning_levels: [], default_reasoning_level: 'medium' });
      assert.deepEqual([none.reasoning, none.reasoningLevels, none.defaultReasoningLevel], [false, [], null]);
    });

    it('listChatgptModels expone los niveles de cada modelo', async () => {
      scenario = () => ({ json: { models: [
        { slug: 'm1', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' },
        { slug: 'm2', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }, { effort: 'ultra' }] },
      ] } });
      const models = await listChatgptModels({ auth });
      assert.deepEqual(models[0].reasoningLevels.map((l) => l.effort), ['low', 'high']);
      assert.equal(models[0].defaultReasoningLevel, 'low');
      assert.deepEqual(models[1].reasoningLevels.map((l) => l.effort), ['medium', 'max', 'ultra']);
      assert.equal(models[1].defaultReasoningLevel, null);
    });
  });
});
