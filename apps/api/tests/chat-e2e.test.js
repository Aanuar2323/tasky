import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startMockLlm, sseText, sseToolCall } from './helpers/mock-llm.js';

const PORT = 9891;
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function catalogModel(id, { ctx, max, tools, vision = false }) {
  return {
    id,
    name: id,
    context_length: ctx,
    architecture: { modality: 'text->text', input_modalities: vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0', completion: '0' },
    top_provider: { context_length: ctx, max_completion_tokens: max, is_moderated: false },
    supported_parameters: ['max_tokens', 'temperature', ...(tools ? ['tools', 'tool_choice'] : [])],
  };
}

const CATALOG = {
  data: [
    catalogModel('mock/tools-model', { ctx: 32000, max: 8000, tools: true }),
    catalogModel('mock/notools-404', { ctx: 32000, max: 8000, tools: true }),
    catalogModel('mock/hermes', { ctx: 32000, max: 8000, tools: true }),
    catalogModel('mock/small', { ctx: 8192, max: 8192, tools: true }),
    catalogModel('mock/vision', { ctx: 64000, max: 8000, tools: true, vision: true }),
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

describe('chat e2e (LLM simulado)', () => {
  let mock;
  let server;
  let tmpDir;
  let projectId;
  let root;
  let scenario = () => ({ sse: sseText('ok') });
  let chatCounter = 0;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-e2e-'));
    mock = await startMockLlm((body, n, req) => (req.url.endsWith('/models') ? { json: CATALOG } : scenario(body, n, req)));
    Object.assign(process.env, {
      STORAGE_ROOT: tmpDir,
      PORT: String(PORT),
      OPENROUTER_API_KEY: 'sk-or-test-1234567890',
      OPENROUTER_BASE_URL: mock.url,
      OPENROUTER_MODEL: 'mock/tools-model',
      TASKY_RETRY_BASE_MS: '5',
      TASKY_DISABLE_COMPACTION: '1',
    });
    delete process.env.NVIDIA_API_KEY;
    const mod = await import('../src/index.js');
    server = mod.server;
    const res = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'E2E' }) });
    projectId = (await res.json()).id;
    root = path.join(tmpDir, 'users', 'default', 'projects', projectId);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    for (const k of ['STORAGE_ROOT', 'PORT', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL', 'TASKY_RETRY_BASE_MS', 'TASKY_DISABLE_COMPACTION']) delete process.env[k];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function newChat() {
    chatCounter += 1;
    const cfg = await (await fetch(`${BASE}/api/projects/${projectId}/areas`)).json();
    const chatId = `chat${chatCounter}`;
    cfg.areas[0].chats.push({ id: chatId, name: `Chat ${chatCounter}` });
    await fetch(`${BASE}/api/projects/${projectId}/areas`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(cfg) });
    return chatId;
  }

  async function setModel(model) {
    const r = await fetch(`${BASE}/api/model`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ model, provider: 'openrouter' }) });
    assert.equal(r.status, 200);
  }

  async function chatSse(body, { signal, form } = {}) {
    const res = await fetch(`${BASE}/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: form ? { Accept: 'text/event-stream' } : { ...JSON_HEADERS, Accept: 'text/event-stream' },
      body: form ?? JSON.stringify({ areaId: 'a1', ...body }),
      signal,
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    return parseSse(await res.text());
  }

  const deltas = (events) => events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  const done = (events) => events.find((e) => e.event === 'done')?.data?.message;
  const since = (mark) => mock.completions().slice(mark);
  const log = async (chatId) => (await fs.readFile(path.join(root, 'chat', 'areas', 'a1', `${chatId}.jsonl`), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  it('texto en streaming y persistencia', async () => {
    await setModel('mock/tools-model');
    const chatId = await newChat();
    scenario = () => ({ sse: sseText('Hola, soy Tasky. ¿En qué te ayudo?') });
    const events = await chatSse({ chatId, message: 'hola' });
    assert.equal(events[0].event, 'start');
    assert.equal(deltas(events), 'Hola, soy Tasky. ¿En qué te ayudo?');
    assert.equal(done(events).content, 'Hola, soy Tasky. ¿En qué te ayudo?');
    const entries = await log(chatId);
    assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant']);
    assert.equal(entries[1].model, 'mock/tools-model');
    assert.equal(entries[1].content, 'Hola, soy Tasky. ¿En qué te ayudo?');
  });

  it('generate_file crea un archivo real en una sola vuelta', async () => {
    const chatId = await newChat();
    const mark = mock.completions().length;
    scenario = () => ({
      sse: sseToolCall('generate_file', { type: 'docx', filename: 'informe_q3.docx', summary: 'Informe del Q3', data: { title: 'Informe Q3', markdown: '# Resumen\n\nVentas en alza.' } }, { text: 'Te preparo el informe del Q3.' }),
    });
    const events = await chatSse({ chatId, message: 'Haceme un informe del Q3 en Word' });
    const fileEvt = events.find((e) => e.event === 'file');
    assert.equal(fileEvt.data.file.name, 'informe_q3.docx');
    assert.ok(events.some((e) => e.event === 'status' && e.data.phase === 'generating'));
    assert.ok(events.some((e) => e.event === 'status' && e.data.label === 'Generando informe_q3.docx'), 'el estado nombra el archivo');
    const msg = done(events);
    assert.equal(msg.files[0].url, 'files/generated/informe_q3.docx');
    assert.equal(msg.file.name, 'informe_q3.docx');
    assert.equal(msg.content, 'Te preparo el informe del Q3.');
    await fs.access(path.join(root, 'files', 'generated', 'informe_q3.docx'));
    const reqs = since(mark);
    assert.equal(reqs.length, 1);
    assert.ok(reqs[0].body.tools.some((t) => t.function.name === 'generate_file'));
  });

  it('se autocorrige después de un error de validación', async () => {
    const chatId = await newChat();
    const mark = mock.completions().length;
    scenario = (body) => {
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      if (!toolMsg) {
        return { sse: sseToolCall('generate_file', { type: 'pptx', filename: 'deck.pptx', data: { slides: [{ layout: 'chart', title: 'X', chart: { type: 'radar_3d' } }] } }) };
      }
      assert.match(toolMsg.content, /slides\.0/);
      return { sse: sseToolCall('generate_file', { type: 'pptx', filename: 'deck.pptx', data: { slides: [{ layout: 'title', title: 'Plan' }] } }, { id: 'call_2', text: 'Listo, corregí el gráfico.' }) };
    };
    const events = await chatSse({ chatId, message: 'Haceme una presentación' });
    assert.equal(done(events).files.length, 1);
    assert.equal(since(mark).length, 2);
    const replay = since(mark)[1].body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.match(replay.tool_calls[0].function.arguments, /omitido|slides/);
    await fs.access(path.join(root, 'files', 'generated', 'deck.pptx'));
  });

  it('modelo sin tools → protocolo de texto (y lo recuerda)', async () => {
    await setModel('mock/notools-404');
    const chatId = await newChat();
    const mark = mock.completions().length;
    scenario = (body) => {
      if (body.tools) return { status: 404, json: { error: { message: 'No endpoints found that support tool use.' } } };
      assert.match(body.messages[0].content, /tasky-file/);
      const payload = JSON.stringify({ type: 'xlsx', filename: 'ventas.xlsx', summary: 'Ventas', data: { sheets: [{ name: 'Ventas', headers: ['Mes', 'Total'], rows: [['Ene', 10]] }] } });
      return { sse: sseText(`Acá tenés la planilla.\n\`\`\`tasky-file\n${payload}\n\`\`\``) };
    };
    const events = await chatSse({ chatId, message: 'Planilla de ventas' });
    const msg = done(events);
    assert.equal(msg.content, 'Acá tenés la planilla.');
    assert.equal(msg.files[0].name, 'ventas.xlsx');
    assert.ok(!deltas(events).includes('tasky-file'));
    assert.equal(since(mark).length, 2);
    const mark2 = mock.completions().length;
    await chatSse({ chatId, message: 'Otra' });
    assert.ok(!since(mark2)[0].body.tools, 'segunda vez va directo sin tools');
    await setModel('mock/tools-model');
  });

  it('tool call escrita como texto (Hermes) se ejecuta y no se muestra', async () => {
    await setModel('mock/hermes');
    const chatId = await newChat();
    scenario = () => ({
      sse: sseText('Genero el archivo.\n<tool_call>{"name":"generate_file","arguments":{"type":"docx","filename":"nota.docx","data":{"markdown":"# Nota"}}}</tool_call>', { size: 9 }),
    });
    const events = await chatSse({ chatId, message: 'Hacé una nota' });
    assert.ok(!deltas(events).includes('<tool_call>'));
    const msg = done(events);
    assert.equal(msg.content, 'Genero el archivo.');
    assert.equal(msg.files[0].name, 'nota.docx');
    await setModel('mock/tools-model');
  });

  it('read_file y respuesta final con el contenido', async () => {
    const chatId = await newChat();
    await fs.writeFile(path.join(root, 'ai', 'layer2', 'areas', 'a1', 'notas.md'), 'El presupuesto 2026 es de 1.200.000 pesos.', 'utf8');
    scenario = (body) => {
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      if (!toolMsg) return { sse: sseToolCall('read_file', { path: 'ai/layer2/areas/a1/notas.md' }) };
      assert.match(toolMsg.content, /1\.200\.000/);
      return { sse: sseText('El presupuesto 2026 es de 1.200.000 pesos.') };
    };
    const events = await chatSse({ chatId, message: '¿Cuál es el presupuesto?' });
    assert.ok(events.some((e) => e.event === 'status' && e.data.phase === 'reading'));
    assert.match(done(events).content, /1\.200\.000/);
  });

  it('regenerar reemplaza la respuesta sin duplicar el mensaje del usuario', async () => {
    const chatId = await newChat();
    scenario = () => ({ sse: sseText('Primera') });
    await chatSse({ chatId, message: 'Decime algo' });
    scenario = () => ({ sse: sseText('Segunda') });
    const events = await chatSse({ chatId, regenerate: true });
    assert.equal(done(events).content, 'Segunda');
    const entries = await log(chatId);
    assert.deepEqual(entries.map((e) => `${e.role}:${e.content}`), ['user:Decime algo', 'assistant:Segunda']);
  });

  it('contexto chico: historial recortado y salida acotada', async () => {
    await setModel('mock/small');
    const chatId = await newChat();
    const lines = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(JSON.stringify({ id: `h${i}`, role: i % 2 ? 'assistant' : 'user', content: `Mensaje ${i} ${'palabra '.repeat(250)}`, ts: i + 1 }));
    }
    await fs.mkdir(path.join(root, 'chat', 'areas', 'a1'), { recursive: true });
    await fs.writeFile(path.join(root, 'chat', 'areas', 'a1', `${chatId}.jsonl`), `${lines.join('\n')}\n`);
    const mark = mock.completions().length;
    scenario = () => ({ sse: sseText('ok') });
    await chatSse({ chatId, message: 'resumí' });
    const req = since(mark)[0].body;
    const chars = req.messages.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : 0), 0);
    assert.ok(req.max_tokens <= Math.floor(8192 * 0.35), `max_tokens=${req.max_tokens}`);
    assert.ok(Math.ceil(chars / 3.5) + req.max_tokens <= 8192, `tokens estimados=${Math.ceil(chars / 3.5)}`);
    assert.equal(req.messages.at(-1).content, 'resumí');
    assert.ok(req.messages.length < 40);
    await setModel('mock/tools-model');
  });

  it('historial que no entra se compacta en segundo plano y se reutiliza', async () => {
    await setModel('mock/small');
    const chatId = await newChat();
    const lines = [];
    for (let i = 0; i < 30; i += 1) {
      lines.push(JSON.stringify({ id: `k${i}`, role: i % 2 ? 'assistant' : 'user', content: `Tema ${i}: ${'dato '.repeat(300)}`, ts: i + 1 }));
    }
    await fs.writeFile(path.join(root, 'chat', 'areas', 'a1', `${chatId}.jsonl`), `${lines.join('\n')}\n`);
    delete process.env.TASKY_DISABLE_COMPACTION;
    try {
      scenario = (body) => (body.stream
        ? { sse: sseText('ok') }
        : { json: { id: 'sum', model: 'mock/small', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '- Se acordó el tema 0.' } }], usage: {} } });
      await chatSse({ chatId, message: 'seguimos' });
      const summaryPath = path.join(root, 'chat', 'areas', 'a1', `${chatId}.summary.json`);
      let summary = null;
      for (let i = 0; i < 40 && !summary; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        summary = JSON.parse(await fs.readFile(summaryPath, 'utf8').catch(() => 'null'));
      }
      assert.equal(summary.text, '- Se acordó el tema 0.');
      const mark = mock.completions().length;
      await chatSse({ chatId, message: 'y ahora?' });
      assert.match(since(mark).find((r) => r.body.stream).body.messages[0].content, /Se acordó el tema 0/);
    } finally {
      process.env.TASKY_DISABLE_COMPACTION = '1';
      await setModel('mock/tools-model');
    }
  });

  it('detener a mitad del stream guarda la respuesta parcial', async () => {
    const chatId = await newChat();
    scenario = () => ({ sse: sseText('Uno dos tres cuatro cinco seis siete ocho nueve diez', { size: 4 }), delayMs: 60 });
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Accept: 'text/event-stream' },
      body: JSON.stringify({ areaId: 'a1', chatId, message: 'contá' }),
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('event: delta')) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    let entries = [];
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      entries = await log(chatId);
      if (entries.length === 2) break;
    }
    assert.equal(entries[1].stopped, true);
    assert.ok(entries[1].content.length > 0);
    assert.ok(!entries[1].error);
  });

  it('modo JSON conserva la forma de respuesta', async () => {
    const chatId = await newChat();
    scenario = () => ({ sse: sseText('Respuesta JSON') });
    const res = await fetch(`${BASE}/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ areaId: 'a1', chatId, messages: [{ role: 'user', content: 'hola' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content, 'Respuesta JSON');
    assert.ok('id' in body && 'meta' in body && 'file' in body && Array.isArray(body.files));
  });

  it('error del proveedor: evento error, registro y status HTTP', async () => {
    const chatId = await newChat();
    scenario = () => ({ status: 401, json: { error: { message: 'No auth credentials found' } } });
    const events = await chatSse({ chatId, message: 'hola' });
    const err = events.find((e) => e.event === 'error');
    assert.equal(err.data.error.title, 'API key inválida');
    const entries = await log(chatId);
    assert.equal(entries.at(-1).error.title, 'API key inválida');
    const res = await fetch(`${BASE}/api/projects/${projectId}/chat`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ areaId: 'a1', chatId, message: 'hola' }) });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).errorHuman.title, 'API key inválida');
  });

  it('adjuntos: texto en el mensaje y archivo guardado', async () => {
    const chatId = await newChat();
    const mark = mock.completions().length;
    scenario = () => ({ sse: sseText('Leído.') });
    const form = new FormData();
    form.append('areaId', 'a1');
    form.append('chatId', chatId);
    form.append('message', 'Resumí el adjunto');
    form.append('attachments', new Blob(['Contrato de servicios con ACME por 12 meses.'], { type: 'text/plain' }), 'contrato.txt');
    await chatSse({}, { form });
    const userMsg = since(mark)[0].body.messages.at(-1);
    assert.match(userMsg.content, /<adjunto nombre="contrato\.txt">/);
    assert.match(userMsg.content, /ACME por 12 meses/);
    const entries = await log(chatId);
    assert.equal(entries[0].attachments[0].name, 'contrato.txt');
    await fs.access(path.join(root, entries[0].attachments[0].path));
  });

  it('imagen adjunta a un modelo con visión va como image_url', async () => {
    await setModel('mock/vision');
    const chatId = await newChat();
    const mark = mock.completions().length;
    scenario = () => ({ sse: sseText('Veo un gráfico.') });
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const form = new FormData();
    form.append('areaId', 'a1');
    form.append('chatId', chatId);
    form.append('message', '¿Qué ves?');
    form.append('attachments', new Blob([png], { type: 'image/png' }), 'grafico.png');
    await chatSse({}, { form });
    const content = since(mark)[0].body.messages.at(-1).content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
    await setModel('mock/tools-model');
  });

  it('reglas desactivadas no llegan al prompt', async () => {
    const chatId = await newChat();
    await fetch(`${BASE}/api/projects/${projectId}/rules`, {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ areaId: 'a1', markdown: '### Formal\n- Usar tono formal\n`enabled`\n\n### Emojis\n- Usar muchos emojis\n`disabled`' }),
    });
    const mark = mock.completions().length;
    scenario = () => ({ sse: sseText('ok') });
    await chatSse({ chatId, message: 'hola' });
    const system = since(mark)[0].body.messages[0].content;
    assert.match(system, /- Formal: Usar tono formal/);
    assert.doesNotMatch(system, /emojis/i);
  });

  it('vista previa, archivos generados y estado', async () => {
    const preview = await (await fetch(`${BASE}/api/projects/${projectId}/preview?path=${encodeURIComponent('files/generated/informe_q3.docx')}`)).json();
    assert.equal(preview.kind, 'markdown');
    assert.match(preview.markdown, /Resumen/);
    const xlsx = await (await fetch(`${BASE}/api/projects/${projectId}/preview?path=${encodeURIComponent('files/generated/ventas.xlsx')}`)).json();
    assert.equal(xlsx.kind, 'sheets');
    assert.deepEqual(xlsx.sheets[0].rows[0], ['Mes', 'Total']);
    const denied = await fetch(`${BASE}/api/projects/${projectId}/preview?path=${encodeURIComponent('info/areas.json')}`);
    assert.equal(denied.status, 403);
    const generated = await (await fetch(`${BASE}/api/projects/${projectId}/generated?areaId=a1`)).json();
    assert.ok(generated.files.some((f) => f.filename === 'informe_q3.docx'));
    const status = await (await fetch(`${BASE}/api/status`)).json();
    assert.equal(status.capabilities.tools, true);
    assert.equal(status.capabilities.contextLength, 32000);
  });

  it('rechaza ids con rutas', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/chat`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ areaId: '../x', chatId: 'c1', message: 'hola' }) });
    assert.equal(res.status, 400);
    const del = await fetch(`${BASE}/api/projects/${projectId}/area`, { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ areaId: '..' }) });
    assert.equal(del.status, 400);
  });
});
