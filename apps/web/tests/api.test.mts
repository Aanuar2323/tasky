import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPreview } from '../app/lib/api.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('request', () => {
  it('una solicitud cancelada se propaga como AbortError, no como falta de conexión', async () => {
    globalThis.fetch = async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    await assert.rejects(getPreview('p1', 'files/generated/a.xlsx'), { name: 'AbortError' });
  });

  it('un fallo de red se informa como sin conexión (status 0)', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(getPreview('p1', 'files/generated/a.xlsx'), (err: Error & { status?: number }) => {
      assert.equal(err.status, 0);
      assert.match(err.message, /Sin conexión/);
      return true;
    });
  });
});
