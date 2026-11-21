import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelChatgptLogin,
  chatgptLogout,
  fetchModels,
  getChatgptStatus,
  selectChatgptAccount,
  setProvider,
  startChatgptLogin,
} from '../app/lib/api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method?: string; body: unknown };

function mockFetch(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return calls;
}

const ok = (body: unknown) => Response.json(body);

describe('API de ChatGPT en el cliente web', () => {
  it('el estado se lee con GET', async () => {
    const calls = mockFetch(() => ok({ available: true, signedIn: true, planUsage: true, email: 'a@b.c', accounts: [], login: { state: 'idle' } }));
    const status = await getChatgptStatus();
    assert.match(calls[0].url, /\/api\/chatgpt\/status$/);
    assert.equal(calls[0].method, undefined);
    assert.equal(status.signedIn, true);
  });

  it('iniciar sesión no envía ninguna URL de redirección, solo opciones booleanas', async () => {
    const calls = mockFetch(() => ok({ status: 'pending', opened: true }));
    await startChatgptLogin();
    await startChatgptLogin({ reconsent: true });
    await startChatgptLogin({ newAccount: true });
    assert.deepEqual(calls.map((c) => c.body), [{}, { reconsent: true }, { newAccount: true }]);
    assert.ok(calls.every((c) => c.method === 'POST' && /\/api\/chatgpt\/login$/.test(c.url)));
  });

  it('cancelar, cerrar sesión y elegir cuenta usan POST', async () => {
    const calls = mockFetch((c) => ok(c.url.endsWith('/logout') ? { ok: true, revoked: false } : { ok: true }));
    await cancelChatgptLogin();
    const out = await chatgptLogout();
    await selectChatgptAccount('0123456789abcdef');
    assert.equal(out.revoked, false);
    assert.deepEqual(calls.map((c) => [c.method, c.url.replace(/^.*\/api/, '/api')]), [
      ['POST', '/api/chatgpt/login/cancel'],
      ['POST', '/api/chatgpt/logout'],
      ['POST', '/api/chatgpt/account'],
    ]);
    assert.deepEqual(calls[2].body, { id: '0123456789abcdef' });
  });

  it('ChatGPT se elige como proveedor y sus modelos se piden con ?provider=chatgpt', async () => {
    const calls = mockFetch((c) => ok(c.url.includes('/api/models') ? { models: [{ id: 'm', name: 'M', isFree: false }] } : { ok: true }));
    await setProvider('chatgpt');
    const { models } = await fetchModels('chatgpt');
    assert.deepEqual(calls[0].body, { provider: 'chatgpt' });
    assert.match(calls[1].url, /\/api\/models\?provider=chatgpt$/);
    assert.equal(models[0].id, 'm');
  });

  it('un error con acción conserva código, request ID y acción para la UI', async () => {
    mockFetch(() => Response.json(
      { error: 'límite', errorHuman: { title: 'Límite', hint: 'x', codes: [429], retriable: false, code: 'subscription_sharing_usage_limit_exceeded', requestId: 'req_1', action: 'usage' } },
      { status: 429 },
    ));
    await assert.rejects(startChatgptLogin(), (err: Error & { errorHuman: { action?: string; code?: string; requestId?: string } }) => {
      assert.equal(err.errorHuman.action, 'usage');
      assert.equal(err.errorHuman.code, 'subscription_sharing_usage_limit_exceeded');
      assert.equal(err.errorHuman.requestId, 'req_1');
      return true;
    });
  });

  it('el login bloqueado en Docker llega como 409 con su código', async () => {
    mockFetch(() => Response.json({ error: 'requiere ejecutar Tasky en tu equipo', code: 'container_unsupported' }, { status: 409 }));
    await assert.rejects(startChatgptLogin(), (err: Error & { status: number; body: { code?: string } }) => {
      assert.equal(err.status, 409);
      assert.equal(err.body.code, 'container_unsupported');
      return true;
    });
  });
});
