import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createThinkFilter,
  stripThink,
  extractTextToolCalls,
  parseToolArguments,
  createMarkerFilter,
} from '../src/llm/normalize.js';

const TOOLS = ['generate_file', 'edit_file', 'read_file'];

function runFilter(filter, chunks) {
  let content = '';
  let reasoning = '';
  for (const ch of chunks) {
    const o = filter.push(ch);
    content += o.content;
    reasoning += o.reasoning;
  }
  const o = filter.flush();
  return { content: content + o.content, reasoning: reasoning + o.reasoning };
}

describe('createThinkFilter', () => {
  it('separa <think> partido entre chunks', () => {
    assert.deepEqual(runFilter(createThinkFilter(), ['Ho', '<thi', 'nk>pien', 'so</th', 'ink>la']), { content: 'Hola', reasoning: 'pienso' });
  });

  it('soporta <thinking> y varios bloques', () => {
    assert.deepEqual(
      runFilter(createThinkFilter(), ['<thinking>a</thinking>X', '<think>b</think>Y']),
      { content: 'XY', reasoning: 'ab' }
    );
  });

  it('no retiene texto que solo se parece al inicio de una etiqueta', () => {
    const f = createThinkFilter();
    assert.equal(f.push('a < b').content, 'a < b');
  });

  it('un <think> sin cerrar al final queda como razonamiento', () => {
    assert.deepEqual(runFilter(createThinkFilter(), ['Hola <think>sin cierre']), { content: 'Hola ', reasoning: 'sin cierre' });
  });
});

describe('stripThink', () => {
  it('</think> sin apertura (R1 distill)', () => {
    assert.deepEqual(stripThink('razono</think>Respuesta'), { content: 'Respuesta', reasoning: 'razono' });
  });

  it('bloques normales y salto de línea inicial', () => {
    assert.deepEqual(stripThink('<think>\nplan\n</think>\n\nHola'), { content: 'Hola', reasoning: 'plan' });
  });

  it('sin etiquetas no toca el texto', () => {
    assert.deepEqual(stripThink('Hola **mundo**'), { content: 'Hola **mundo**', reasoning: '' });
  });
});

describe('extractTextToolCalls', () => {
  it('Hermes/Qwen <tool_call>', () => {
    const r = extractTextToolCalls('Ok.\n<tool_call>{"name":"generate_file","arguments":{"type":"docx"}}</tool_call>', TOOLS);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'generate_file');
    assert.deepEqual(JSON.parse(r.calls[0].arguments), { type: 'docx' });
    assert.equal(r.text.trim(), 'Ok.');
    assert.ok(r.calls[0].id);
  });

  it('Hermes con arguments como string JSON', () => {
    const r = extractTextToolCalls('<tool_call>\n{"name": "read_file", "arguments": "{\\"path\\": \\"a.md\\"}"}\n</tool_call>', TOOLS);
    assert.deepEqual(JSON.parse(r.calls[0].arguments), { path: 'a.md' });
  });

  it('Mistral [TOOL_CALLS] lista', () => {
    const r = extractTextToolCalls('[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "x.md"}}]', TOOLS);
    assert.equal(r.calls[0].name, 'read_file');
    assert.equal(r.text.trim(), '');
  });

  it('Mistral v11 name[ARGS]{...}', () => {
    const r = extractTextToolCalls('[TOOL_CALLS]read_file[ARGS]{"path": "y.md"}', TOOLS);
    assert.equal(r.calls[0].name, 'read_file');
    assert.deepEqual(JSON.parse(r.calls[0].arguments), { path: 'y.md' });
  });

  it('DeepSeek full-width con bloque json', () => {
    const t = 'Leo el archivo.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path":"a.md"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const r = extractTextToolCalls(t, TOOLS);
    assert.equal(r.calls[0].name, 'read_file');
    assert.deepEqual(JSON.parse(r.calls[0].arguments), { path: 'a.md' });
    assert.equal(r.text, 'Leo el archivo.');
  });

  it('DeepSeek V3.1 ASCII nombre<sep>json', () => {
    const t = '<|tool_calls_begin|><|tool_call_begin|>read_file<|tool_sep|>{"path":"b.md"}<|tool_call_end|><|tool_calls_end|>';
    const r = extractTextToolCalls(t, TOOLS);
    assert.equal(r.calls[0].name, 'read_file');
    assert.deepEqual(JSON.parse(r.calls[0].arguments), { path: 'b.md' });
  });

  it('Llama <|python_tag|> y <function=...>', () => {
    const a = extractTextToolCalls('<|python_tag|>{"name": "read_file", "parameters": {"path": "c.md"}}', TOOLS);
    assert.deepEqual(JSON.parse(a.calls[0].arguments), { path: 'c.md' });
    const b = extractTextToolCalls('<function=read_file>{"path": "d.md"}</function>', TOOLS);
    assert.deepEqual(JSON.parse(b.calls[0].arguments), { path: 'd.md' });
  });

  it('JSON suelto con name/parameters solo si la tool existe', () => {
    assert.equal(extractTextToolCalls('{"name":"read_file","parameters":{"path":"x"}}', TOOLS).calls.length, 1);
    assert.equal(extractTextToolCalls('{"name":"otro","parameters":{}}', TOOLS).calls.length, 0);
    assert.equal(extractTextToolCalls('{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"z\\"}"}}', TOOLS).calls[0].name, 'read_file');
  });

  it('JSON de tool al final de un párrafo', () => {
    const r = extractTextToolCalls('Genero el informe ahora.\n{"name": "generate_file", "arguments": {"type": "docx", "filename": "a.docx"}}', TOOLS);
    assert.equal(r.calls.length, 1);
    assert.equal(r.text.trim(), 'Genero el informe ahora.');
  });

  it('texto normal no produce llamadas', () => {
    const r = extractTextToolCalls('Usá la función {"a": 1} en tu código.', TOOLS);
    assert.equal(r.calls.length, 0);
    assert.equal(r.text, 'Usá la función {"a": 1} en tu código.');
  });
});

describe('parseToolArguments', () => {
  it('acepta objeto, string, fences y doble codificación', () => {
    assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
    assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
    assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseToolArguments(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
    assert.deepEqual(parseToolArguments('{"a":1,}'), { a: 1 });
    assert.deepEqual(parseToolArguments('texto {"a":1} más'), { a: 1 });
  });

  it('JSON truncado devuelve null', () => {
    assert.equal(parseToolArguments('{"type":"docx","data":{"sections":[{"type":"par'), null);
    assert.equal(parseToolArguments(''), null);
  });
});

describe('createMarkerFilter', () => {
  function run(chunks, opts) {
    const f = createMarkerFilter(opts);
    let out = '';
    for (const ch of chunks) out += f.push(ch);
    return out + f.flush();
  }

  it('oculta <tool_call> en streaming', () => {
    assert.equal(run(['Listo ', '<tool', '_call>{"a":1}</tool_call>', ' fin']), 'Listo  fin');
  });

  it('oculta bloques ```tasky-file``` y avisa', () => {
    const seen = [];
    const out = run(['Te dejo el archivo.\n```tas', 'ky-file\n{"type":"docx"}\n', '```\nSaludos'], { onHidden: (m) => seen.push(m) });
    assert.equal(out, 'Te dejo el archivo.\n\nSaludos');
    assert.deepEqual(seen, ['tasky-file']);
  });

  it('retiene respuestas que empiezan con JSON hasta el final', () => {
    const f = createMarkerFilter();
    assert.equal(f.push('{"content": "ho'), '');
    assert.equal(f.push('la"}'), '');
    assert.equal(f.flush(), '{"content": "hola"}');
  });

  it('corta todo lo que sigue a [TOOL_CALLS]', () => {
    assert.equal(run(['Hola [TOOL_', 'CALLS] [{"name":"x"}]']), 'Hola ');
  });

  it('deja pasar texto normal sin demoras', () => {
    const f = createMarkerFilter();
    assert.equal(f.push('Hola, '), 'Hola, ');
    assert.equal(f.push('¿cómo estás?'), '¿cómo estás?');
  });
});
