import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from '../app/lib/sse.ts';

describe('parseSse', () => {
  it('separa eventos completos y conserva el resto', () => {
    const { events, rest } = parseSse('event: delta\ndata: {"text":"Ho"}\n\nevent: delta\ndata: {"text":"la"}\n\nevent: do');
    assert.deepEqual(events, [
      { event: 'delta', data: { text: 'Ho' } },
      { event: 'delta', data: { text: 'la' } },
    ]);
    assert.equal(rest, 'event: do');
  });

  it('ignora comentarios/heartbeats y usa "message" por defecto', () => {
    const { events } = parseSse(': ping\n\ndata: {"a":1}\n\n');
    assert.deepEqual(events, [{ event: 'message', data: { a: 1 } }]);
  });

  it('acepta CRLF y data en varias líneas', () => {
    const { events } = parseSse('event: x\r\ndata: {"a":\r\ndata: 2}\r\n\r\n');
    assert.deepEqual(events, [{ event: 'x', data: { a: 2 } }]);
  });

  it('data que no es JSON queda como texto', () => {
    const { events } = parseSse('data: hola\n\n');
    assert.deepEqual(events, [{ event: 'message', data: 'hola' }]);
  });
});
