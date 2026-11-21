import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effortKey, reasoningLabel, resolveEffort, withEffort } from '../app/lib/reasoning.ts';
import { streamChat } from '../app/lib/api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GPT_A = [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }];
const GPT_B = [{ effort: 'high' }, { effort: 'max' }, { effort: 'ultra' }];

describe('reasoningLabel', () => {
  it('traduce los valores conocidos y muestra tal cual los desconocidos del catálogo', () => {
    assert.deepEqual(
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'turbo'].map(reasoningLabel),
      ['Baja', 'Media', 'Alta', 'Muy alta', 'Máxima', 'Ultra', 'Turbo']
    );
  });

  it('traduce none y minimal (NVIDIA)', () => {
    assert.deepEqual(['none', 'minimal'].map(reasoningLabel), ['Ninguna', 'Mínima']);
  });
});

describe('resolveEffort (selección por modelo)', () => {
  const a = effortKey('chatgpt', 'gpt-a');
  const b = effortKey('chatgpt', 'gpt-b');

  it('sin elección es automático: no se envía nada', () => {
    assert.equal(resolveEffort({}, a, GPT_A), undefined);
  });

  it('la elección se conserva mientras el modelo activo sea el mismo', () => {
    const sel = withEffort({}, a, 'xhigh');
    assert.equal(resolveEffort(sel, a, GPT_A), 'xhigh');
    assert.equal(resolveEffort(sel, a, GPT_A), 'xhigh');
  });

  it('al cambiar de modelo no se envía un nivel que el nuevo no admite, y al volver se recupera', () => {
    const sel = withEffort({}, a, 'xhigh');
    assert.equal(resolveEffort(sel, b, GPT_B), undefined);
    assert.equal(resolveEffort(sel, a, GPT_A), 'xhigh');
  });

  it('si el catálogo deja de declarar el nivel guardado, vuelve a automático (sin reemplazarlo por otro)', () => {
    const sel = withEffort({}, b, 'ultra');
    assert.equal(resolveEffort(sel, b, [{ effort: 'high' }, { effort: 'max' }]), undefined);
  });

  it('modelos sin niveles (NVIDIA, OpenRouter sin lista) nunca envían nivel', () => {
    const key = effortKey('nvidia', 'meta/llama');
    assert.equal(resolveEffort({ [key]: 'high' }, key, []), undefined);
    assert.equal(resolveEffort({ [key]: 'high' }, key, undefined), undefined);
  });

  it('withEffort vuelve a automático con undefined sin mutar el original', () => {
    const sel = { [a]: 'low' };
    const next = withEffort(sel, a, undefined);
    assert.deepEqual(next, {});
    assert.deepEqual(sel, { [a]: 'low' });
  });
});

describe('streamChat: serialización del nivel', () => {
  const capture = () => {
    const calls: { body: BodyInit | null | undefined }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ body: init.body });
      return new Response('event: done\ndata: {"message":{}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    return calls;
  };
  const base = { areaId: 'a1', chatId: 'c1', message: 'hola' };

  it('JSON: incluye reasoningEffort solo si se eligió', async () => {
    const calls = capture();
    await streamChat('p1', { ...base, reasoningEffort: 'ultra' }, { onEvent: () => {} });
    await streamChat('p1', base, { onEvent: () => {} });
    assert.equal(JSON.parse(calls[0].body as string).reasoningEffort, 'ultra');
    assert.equal('reasoningEffort' in JSON.parse(calls[1].body as string), false);
  });

  it('JSON: la regeneración también lleva el nivel', async () => {
    const calls = capture();
    await streamChat('p1', { areaId: 'a1', chatId: 'c1', regenerate: true, reasoningEffort: 'high' }, { onEvent: () => {} });
    const body = JSON.parse(calls[0].body as string);
    assert.deepEqual([body.regenerate, body.reasoningEffort], [true, 'high']);
  });

  it('multipart: el nivel va como campo del formulario junto a los adjuntos', async () => {
    const calls = capture();
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    await streamChat('p1', { ...base, attachments: [file], reasoningEffort: 'max' }, { onEvent: () => {} });
    await streamChat('p1', { ...base, attachments: [file] }, { onEvent: () => {} });
    const [withLevel, auto] = calls.map((c) => c.body as FormData);
    assert.equal(withLevel.get('reasoningEffort'), 'max');
    assert.equal(withLevel.getAll('attachments').length, 1);
    assert.equal(auto.has('reasoningEffort'), false);
  });
});
