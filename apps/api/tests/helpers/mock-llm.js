/**
 * Servidor OpenAI-compatible de prueba (OpenRouter / NIM simulados).
 *
 * handler(body, n, req) devuelve una de:
 *   { sse: [chunk | string, ...], delayMs?, noDone?, hang? }  → text/event-stream
 *   { json, status?, headers? }                               → application/json
 *   { status, body, headers? }                                 → texto plano
 * `n` cuenta solo llamadas a /chat/completions (1-based).
 */

import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startMockLlm(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(entry);
    const n = requests.filter((r) => r.url.endsWith('/chat/completions')).length;
    let out;
    try {
      out = await handler(body, n, entry);
    } catch (e) {
      out = { status: 500, body: String(e?.stack ?? e) };
    }
    if (!out) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (out.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...(out.headers ?? {}) });
      for (const chunk of out.sse) {
        if (out.delayMs) await sleep(out.delayMs);
        if (res.destroyed) return;
        res.write(typeof chunk === 'string' ? chunk : `data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (out.hang) return;
      if (!out.noDone) res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (out.json !== undefined) {
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.json));
      return;
    }
    res.writeHead(out.status ?? 200, { 'content-type': 'text/plain', ...(out.headers ?? {}) });
    res.end(out.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    completions: () => requests.filter((r) => r.url.endsWith('/chat/completions')),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

let idCounter = 0;
function chunk(delta, extra = {}) {
  idCounter += 1;
  return { id: `gen-${idCounter}`, model: 'mock/model', choices: [{ index: 0, delta, finish_reason: null }], ...extra };
}

/** Chunks SSE que transmiten `text` en pedazos. */
export function sseText(text, { size = 6, reasoning = '', usage = { prompt_tokens: 10, completion_tokens: 5 } } = {}) {
  const out = [];
  if (reasoning) out.push(chunk({ role: 'assistant', reasoning }));
  for (let i = 0; i < text.length; i += size) out.push(chunk({ content: text.slice(i, i + size) }));
  out.push({ id: 'gen-final', model: 'mock/model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  return out;
}

/** Chunks SSE de una tool call con argumentos partidos en `parts` fragmentos. */
export function sseToolCall(name, args, { id = 'call_1', parts = 3, text = '', index = 0 } = {}) {
  const json = typeof args === 'string' ? args : JSON.stringify(args);
  const out = [];
  if (text) out.push(chunk({ content: text }));
  const step = Math.ceil(json.length / parts);
  out.push(chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: json.slice(0, step) } }] }));
  for (let i = step; i < json.length; i += step) {
    out.push(chunk({ tool_calls: [{ index, function: { arguments: json.slice(i, i + step) } }] }));
  }
  out.push({ id: 'gen-final', model: 'mock/model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 30 } });
  return out;
}

/** Respuesta no-stream estilo OpenAI. */
export function jsonCompletion({ content = '', toolCalls = [], reasoning = null, finish = 'stop' } = {}) {
  return {
    id: 'gen-json',
    model: 'mock/model',
    choices: [{
      index: 0,
      finish_reason: finish,
      message: {
        role: 'assistant',
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
          })),
        } : {}),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
