import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChatgptAuth, PLAN_SCOPE } from '../src/llm/chatgpt-auth.js';
import { idTokenFor, makeKeys, mockAuthServer, signJwt, ISSUER } from './helpers/chatgpt-mock.js';

const keys = makeKeys();
const ALL_SCOPES = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';
const CLIENT = 'oaiapp_test';

function rawRequest({ port, pathAndQuery, method = 'GET', host }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method, headers: host ? { Host: host } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function harness({ tokenHandler, revoke, containerized = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-chatgpt-'));
  const h = { dir, clock: Date.now(), opened: [], ctx: null, browser: true };
  h.mock = mockAuthServer(keys, {
    token: (form, n) => (tokenHandler ? tokenHandler(form, n, h) : defaultToken(form, h)),
    revoke,
  });
  h.auth = createChatgptAuth({
    fetchImpl: h.mock.fetchImpl,
    dir,
    now: () => h.clock,
    openBrowser: async (url) => { h.opened.push(url); return h.browser; },
    preferredPort: 0,
    containerized: () => containerized,
  });
  h.login = async (start = {}) => {
    const res = await h.auth.startLogin(start);
    const url = h.browser ? h.opened.at(-1) : res.authorizeUrl;
    const q = new URL(url).searchParams;
    h.ctx = { q, nonce: q.get('nonce'), state: q.get('state'), redirect: q.get('redirect_uri'), port: Number(new URL(q.get('redirect_uri')).port), res, url };
    return h.ctx;
  };
  h.callback = (params = {}, extra = {}) => {
    const qs = new URLSearchParams({ state: h.ctx.state, ...params });
    for (const [k, v] of [...qs]) if (v === 'undefined') qs.delete(k);
    return rawRequest({ port: h.ctx.port, pathAndQuery: `${new URL(h.ctx.redirect).pathname}?${qs}`, ...extra });
  };
  h.cleanup = async () => {
    h.auth.cancelLogin();
    await fs.rm(dir, { recursive: true, force: true });
  };
  return h;
}

function defaultToken(form, h) {
  if (form.grant_type === 'refresh_token') {
    return { body: { access_token: 'at-refreshed', refresh_token: 'rt-rotated', token_type: 'Bearer', expires_in: 3600, scope: ALL_SCOPES } };
  }
  return {
    body: {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      id_token: idTokenFor(keys, { clock: h.clock, aud: form.client_id, nonce: h.ctx.nonce }),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: ALL_SCOPES,
    },
  };
}

const readAccounts = async (dir) => {
  const d = path.join(dir, 'accounts');
  const files = await fs.readdir(d).catch(() => []);
  return Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await fs.readFile(path.join(d, f), 'utf8'))));
};

describe('chatgpt-auth: registro y OAuth', () => {
  let h;
  beforeEach(async () => { h = await harness(); });
  afterEach(() => h.cleanup());

  it('inicia registro dinámico con todos los parámetros del flujo documentado', async () => {
    const { q, redirect } = await h.login();
    assert.equal(q.get('client_id'), 'dynamic_agent_client');
    assert.equal(q.get('agent_name_hint'), 'Tasky');
    assert.match(q.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    assert.equal(q.get('resource'), 'https://api.openai.com/v1');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('code_challenge').length >= 43);
    assert.ok(q.get('state').length >= 32 && q.get('nonce').length >= 32);
    assert.equal(q.get('id_token_hint'), null);
    assert.equal(q.get('prompt'), null);
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.ok(h.opened[0].startsWith('https://auth.openai.com/api/accounts/authorize?'));
  });

  it('canjea el código con el client_id emitido, PKCE y la misma redirect_uri', async () => {
    const ctx = await h.login();
    const res = await h.callback({ code: 'code-1', client_id: CLIENT, scope: ALL_SCOPES });
    assert.equal(res.status, 200);
    const [call] = h.mock.tokenCalls();
    assert.equal(call.form.grant_type, 'authorization_code');
    assert.equal(call.form.client_id, CLIENT);
    assert.notEqual(call.form.client_id, 'dynamic_agent_client');
    assert.equal(call.form.code, 'code-1');
    assert.equal(call.form.redirect_uri, ctx.redirect);
    assert.equal(call.form.resource, 'https://api.openai.com/v1');
    assert.equal(call.form.client_secret, undefined);
    const challenge = crypto.createHash('sha256').update(call.form.code_verifier).digest('base64url');
    assert.equal(challenge, ctx.q.get('code_challenge'));
    assert.match(String(call.headers['Content-Type']), /x-www-form-urlencoded/);
  });

  it('guarda el registro con permisos 0600 y el formato documentado', async () => {
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    const [rec] = await readAccounts(h.dir);
    assert.deepEqual(Object.keys(rec).sort(), [
      'access_token', 'client_id', 'email', 'expires_in', 'ext_agent_host_id', 'id_token', 'issuer',
      'refresh_token', 'saved_at', 'scopes', 'subject', 'token_type',
    ]);
    assert.equal(rec.client_id, CLIENT);
    assert.equal(rec.subject, 'user-123');
    assert.equal(rec.issuer, ISSUER);
    assert.deepEqual(rec.scopes, ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke']);
    const file = path.join(h.dir, 'accounts', (await fs.readdir(path.join(h.dir, 'accounts')))[0]);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(h.dir)).mode & 0o777, 0o700);
    }
    const left = (await fs.readdir(path.join(h.dir, 'accounts'))).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });

  it('el estado público nunca incluye tokens', async () => {
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    const status = h.auth.getStatus();
    assert.equal(status.signedIn, true);
    assert.equal(status.planUsage, true);
    assert.equal(status.email, 'user@example.com');
    assert.deepEqual(status.login, { state: 'success', planUsage: true });
    const text = JSON.stringify(status);
    for (const secret of ['at-1', 'rt-1', 'eyJ', CLIENT]) assert.ok(!text.includes(secret), `filtra ${secret}`);
  });

  it('rechaza un state distinto sin consumir el intento', async () => {
    await h.login();
    const bad = await h.callback({ state: 'otro', code: 'c', client_id: CLIENT });
    assert.equal(bad.status, 400);
    assert.equal(h.mock.tokenCalls().length, 0);
    assert.equal(h.auth.getStatus().signedIn, false);
    const ok = await h.callback({ code: 'c', client_id: CLIENT });
    assert.equal(ok.status, 200);
    assert.equal(h.auth.getStatus().signedIn, true);
  });

  it('un callback es de un solo uso', async () => {
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    await assert.rejects(h.callback({ code: 'c2', client_id: CLIENT }), /ECONNREFUSED|ECONNRESET/);
    assert.equal(h.mock.tokenCalls().length, 1);
  });

  it('solo acepta GET /auth/callback con el Host exacto 127.0.0.1:puerto', async () => {
    await h.login();
    const { port } = h.ctx;
    const qs = `?state=${h.ctx.state}&code=c&client_id=${CLIENT}`;
    assert.equal((await rawRequest({ port, pathAndQuery: `/callback${qs}` })).status, 404);
    assert.equal((await rawRequest({ port, pathAndQuery: `/auth/callback/x${qs}` })).status, 404);
    assert.equal((await rawRequest({ port, pathAndQuery: `/auth/callback${qs}`, method: 'POST' })).status, 405);
    assert.equal((await rawRequest({ port, pathAndQuery: `/auth/callback${qs}`, host: `localhost:${port}` })).status, 400);
    assert.equal((await rawRequest({ port, pathAndQuery: `/auth/callback${qs}`, host: 'evil.example' })).status, 400);
    assert.equal(h.mock.tokenCalls().length, 0);
  });

  it('escucha solo en loopback IPv4', async () => {
    await h.login();
    await assert.rejects(rawRequestV6(h.ctx.port));
  });

  it('ignora cualquier redirect enviado por el callback', async () => {
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT, redirect_uri: 'https://evil.example/cb', redirect: 'https://evil.example' });
    assert.equal(h.mock.tokenCalls()[0].form.redirect_uri, h.ctx.redirect);
  });

  it('access_denied valida el state, no canjea código y no guarda nada', async () => {
    await h.login();
    const res = await h.callback({ error: 'access_denied', code: 'no-usar' });
    assert.equal(res.status, 400);
    assert.equal(h.mock.tokenCalls().length, 0);
    assert.equal(h.auth.getStatus().login.state, 'error');
    assert.equal(h.auth.getStatus().login.code, 'access_denied');
    assert.deepEqual(await readAccounts(h.dir), []);
  });

  it('un error OAuth con state inválido no cancela el intento', async () => {
    await h.login();
    await h.callback({ state: 'falso', error: 'access_denied' });
    assert.equal(h.auth.getStatus().login.state, 'pending');
  });

  for (const [name, returned] of [
    ['sin client_id emitido', undefined],
    ['con dynamic_agent_client', 'dynamic_agent_client'],
    ['con client_id mal formado', 'a b;c'],
  ]) {
    it(`registro incompleto ${name}: no se canjea ni se guarda`, async () => {
      await h.login();
      await h.callback({ code: 'c', client_id: String(returned) });
      assert.equal(h.mock.tokenCalls().length, 0);
      assert.equal(h.auth.getStatus().login.code, 'registration_incomplete');
      assert.deepEqual(await readAccounts(h.dir), []);
    });
  }

  it('invalid_grant en el canje vuelve a pedir autorización sin guardar', async () => {
    await h.cleanup();
    h = await harness({ tokenHandler: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    assert.equal(h.auth.getStatus().login.code, 'invalid_grant');
    assert.deepEqual(await readAccounts(h.dir), []);
  });

  it('sin scope chatgpt.tokens.use.direct conserva la sesión pero deshabilita el plan', async () => {
    await h.cleanup();
    h = await harness({
      tokenHandler: (form, n, hh) => {
        const out = defaultToken(form, hh);
        out.body.scope = 'email offline_access openid profile resource.invoke';
        return out;
      },
    });
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    const status = h.auth.getStatus();
    assert.equal(status.signedIn, true);
    assert.equal(status.planUsage, false);
    assert.equal(h.auth.isReady(), false);
    await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'chatgpt_plan_disabled');
  });

  it('un scope solo en la URL del callback no habilita el plan si el token no lo concede', async () => {
    await h.cleanup();
    h = await harness({
      tokenHandler: (form, n, hh) => {
        const out = defaultToken(form, hh);
        out.body.scope = 'openid email';
        return out;
      },
    });
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT, scope: ALL_SCOPES });
    assert.equal(h.auth.getStatus().planUsage, false);
  });

  it('reautorizar para habilitar el plan usa prompt=consent con el client_id guardado', async () => {
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    const ctx = await h.login({ reconsent: true });
    assert.equal(ctx.q.get('prompt'), 'consent');
    assert.equal(ctx.q.get('client_id'), CLIENT);
    assert.equal(ctx.q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  });

  it('sin reconsent no se fuerza el consentimiento', async () => {
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
    assert.equal((await h.login()).q.get('prompt'), null);
  });
});

function rawRequestV6(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '::1', port, path: '/auth/callback', timeout: 1500 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

describe('chatgpt-auth: validación del ID token', () => {
  const cases = {
    'nonce distinto': (form, h) => idTokenFor(keys, { clock: h.clock, aud: form.client_id, nonce: 'otro-nonce' }),
    'sin nonce': (form, h) => idTokenFor(keys, { clock: h.clock, aud: form.client_id, nonce: undefined }),
    'issuer distinto': (form, h) => idTokenFor(keys, { clock: h.clock, aud: form.client_id, nonce: h.ctx.nonce, iss: 'https://evil.example' }),
    'audience distinta': (form, h) => idTokenFor(keys, { clock: h.clock, aud: 'dynamic_agent_client', nonce: h.ctx.nonce }),
    'vencido': (form, h) => idTokenFor(keys, { clock: h.clock - 7200_000, aud: form.client_id, nonce: h.ctx.nonce }),
    'firma de otra clave': (form, h) => idTokenFor(makeKeys('test-key-1'), { clock: h.clock, aud: form.client_id, nonce: h.ctx.nonce }),
    'payload alterado': (form, h) => signJwt(keys, { iss: ISSUER, aud: form.client_id, nonce: h.ctx.nonce, sub: 'u', exp: Math.floor(h.clock / 1000) + 99 }, { tamper: true }),
    'alg none': (form, h) => signJwt(keys, { iss: ISSUER, aud: form.client_id, nonce: h.ctx.nonce, sub: 'u', exp: Math.floor(h.clock / 1000) + 99 }, { alg: 'none' }),
    'alg HS256': (form, h) => signJwt(keys, { iss: ISSUER, aud: form.client_id, nonce: h.ctx.nonce, sub: 'u', exp: Math.floor(h.clock / 1000) + 99 }, { alg: 'HS256' }),
    'sin sub': (form, h) => idTokenFor(keys, { clock: h.clock, aud: form.client_id, nonce: h.ctx.nonce, sub: undefined }),
    'ausente': () => undefined,
  };
  for (const [name, makeToken] of Object.entries(cases)) {
    it(`rechaza ID token ${name} y no guarda credenciales`, async () => {
      const h = await harness({
        tokenHandler: (form, n, hh) => {
          const out = defaultToken(form, hh);
          out.body.id_token = makeToken(form, hh);
          return out;
        },
      });
      try {
        await h.login();
        await h.callback({ code: 'c', client_id: CLIENT });
        const status = h.auth.getStatus();
        assert.equal(status.signedIn, false);
        assert.equal(status.login.state, 'error');
        assert.deepEqual(await readAccounts(h.dir), []);
      } finally {
        await h.cleanup();
      }
    });
  }

  it('acepta audience como lista que incluye el client_id', async () => {
    const h = await harness({
      tokenHandler: (form, n, hh) => {
        const out = defaultToken(form, hh);
        out.body.id_token = idTokenFor(keys, { clock: hh.clock, aud: [form.client_id, 'otra'], azp: form.client_id, nonce: hh.ctx.nonce });
        return out;
      },
    });
    try {
      await h.login();
      await h.callback({ code: 'c', client_id: CLIENT });
      assert.equal(h.auth.getStatus().signedIn, true);
    } finally {
      await h.cleanup();
    }
  });

  it('rechaza una respuesta sin refresh token o con token_type distinto de Bearer', async () => {
    for (const mutate of [(b) => { delete b.refresh_token; }, (b) => { b.token_type = 'mac'; }]) {
      const h = await harness({
        tokenHandler: (form, n, hh) => {
          const out = defaultToken(form, hh);
          mutate(out.body);
          return out;
        },
      });
      try {
        await h.login();
        await h.callback({ code: 'c', client_id: CLIENT });
        assert.equal(h.auth.getStatus().signedIn, false);
      } finally {
        await h.cleanup();
      }
    }
  });
});

describe('chatgpt-auth: reautorización y cuentas', () => {
  let h;
  beforeEach(async () => {
    h = await harness();
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
  });
  afterEach(() => h.cleanup());

  it('reutiliza client_id y host id, omite agent_name_hint y envía los hints', async () => {
    const [saved] = await readAccounts(h.dir);
    const first = h.ctx.q.get('ext_agent_host_id');
    const ctx = await h.login();
    assert.equal(ctx.q.get('client_id'), CLIENT);
    assert.equal(ctx.q.get('agent_name_hint'), null);
    assert.equal(ctx.q.get('ext_agent_host_id'), first);
    assert.equal(ctx.q.get('id_token_hint'), saved.id_token);
    assert.equal(ctx.q.get('login_hint'), 'user@example.com');
  });

  it('el id_token_hint no se devuelve al navegador si hay que abrir la URL desde la UI', async () => {
    h.browser = false;
    const ctx = await h.login();
    assert.ok(ctx.res.authorizeUrl.startsWith('https://auth.openai.com/api/accounts/authorize?'));
    assert.equal(ctx.q.get('id_token_hint'), null);
    assert.equal(ctx.q.get('login_hint'), 'user@example.com');
    assert.ok(!JSON.stringify(ctx.res).includes('eyJ'));
  });

  it('acepta el callback sin client_id y mantiene el registro', async () => {
    await h.login();
    const res = await h.callback({ code: 'c2' });
    assert.equal(res.status, 200);
    assert.equal(h.mock.tokenCalls().at(-1).form.client_id, CLIENT);
  });

  it('rechaza si el callback trae otro client_id y no reemplaza credenciales', async () => {
    const before = await readAccounts(h.dir);
    await h.login();
    await h.callback({ code: 'c2', client_id: 'oaiapp_otro' });
    assert.equal(h.auth.getStatus().login.code, 'client_mismatch');
    assert.deepEqual(await readAccounts(h.dir), before);
  });

  it('rechaza una identidad distinta (sub) y conserva las credenciales anteriores', async () => {
    const original = await readAccounts(h.dir);
    const opened = [];
    let nonce = null;
    const other = createChatgptAuth({
      fetchImpl: mockAuthServer(keys, {
        token: (form) => ({
          body: {
            access_token: 'at-evil', refresh_token: 'rt-evil', token_type: 'Bearer', expires_in: 3600, scope: ALL_SCOPES,
            id_token: idTokenFor(keys, { clock: h.clock, aud: form.client_id, nonce, sub: 'user-OTRO' }),
          },
        }),
      }).fetchImpl,
      dir: h.dir,
      now: () => h.clock,
      openBrowser: async (url) => { opened.push(url); return true; },
      preferredPort: 0,
      containerized: () => false,
    });
    try {
      await other.startLogin();
      const q = new URL(opened[0]).searchParams;
      assert.equal(q.get('client_id'), CLIENT);
      nonce = q.get('nonce');
      const port = Number(new URL(q.get('redirect_uri')).port);
      await rawRequest({ port, pathAndQuery: `/auth/callback?state=${q.get('state')}&code=c3` });
      assert.equal(other.getStatus().login.code, 'account_mismatch');
      assert.deepEqual(await readAccounts(h.dir), original);
    } finally {
      other.cancelLogin();
    }
  });

  it('"Otra cuenta" registra un client_id nuevo sin tocar el anterior', async () => {
    const ctx = await h.login({ newAccount: true });
    assert.equal(ctx.q.get('client_id'), 'dynamic_agent_client');
    assert.equal(ctx.q.get('id_token_hint'), null);
    await h.callback({ code: 'c', client_id: 'oaiapp_second' });
    const accounts = await readAccounts(h.dir);
    assert.deepEqual(accounts.map((a) => a.client_id).sort(), [CLIENT, 'oaiapp_second'].sort());
    const status = h.auth.getStatus();
    assert.equal(status.accounts.length, 2);
    assert.equal(status.accounts.filter((a) => a.active).length, 1);
    assert.notEqual(status.accounts[0].label, status.accounts[1].label);
    const other = status.accounts.find((a) => !a.active);
    await h.auth.selectAccount(other.id);
    assert.equal(h.auth.getStatus().accounts.find((a) => a.id === other.id).active, true);
    await assert.rejects(h.auth.selectAccount('0000000000000000'));
  });
});

describe('chatgpt-auth: Docker y puerto', () => {
  it('bloquea el login dentro de un contenedor salvo opt-in explícito', async () => {
    const h = await harness({ containerized: true });
    try {
      assert.equal(h.auth.getStatus().available, false);
      assert.equal(h.auth.getStatus().unavailableReason, 'container');
      await assert.rejects(h.auth.startLogin(), (e) => e.code === 'container_unsupported');
      assert.equal(h.opened.length, 0);
      process.env.TASKY_CHATGPT_ALLOW_CONTAINER = '1';
      try {
        assert.equal(h.auth.getStatus().available, true);
        await h.login();
        assert.match(h.ctx.redirect, /^http:\/\/127\.0\.0\.1:/);
      } finally {
        delete process.env.TASKY_CHATGPT_ALLOW_CONTAINER;
      }
    } finally {
      await h.cleanup();
    }
  });

  it('si el puerto preferido está ocupado usa otro y mantiene la misma ruta', async () => {
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    const h = await harness();
    h.auth = createChatgptAuth({
      fetchImpl: h.mock.fetchImpl, dir: h.dir, now: () => h.clock, preferredPort: busy, containerized: () => false,
      openBrowser: async (u) => { h.opened.push(u); return true; },
    });
    try {
      const ctx = await h.login();
      assert.notEqual(ctx.port, busy);
      assert.equal(new URL(ctx.redirect).pathname, '/auth/callback');
      assert.equal(new URL(ctx.redirect).hostname, '127.0.0.1');
    } finally {
      await h.cleanup();
      await new Promise((r) => blocker.close(r));
    }
  });

  it('un nuevo login reemplaza al anterior y libera su puerto', async () => {
    const h = await harness();
    try {
      const first = await h.login();
      await h.login();
      await assert.rejects(rawRequest({ port: first.port, pathAndQuery: '/auth/callback' }));
    } finally {
      await h.cleanup();
    }
  });
});

describe('chatgpt-auth: refresh', () => {
  let h;
  let refreshBody = null;
  beforeEach(async () => {
    refreshBody = null;
    h = await harness({
      tokenHandler: (form, n, hh) => {
        if (form.grant_type === 'refresh_token') {
          if (refreshBody?.error) return { status: refreshBody.status ?? 400, body: { error: refreshBody.error } };
          if (refreshBody?.throw) return { throw: true };
          return { body: refreshBody ?? { access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer', expires_in: 7200, scope: ALL_SCOPES } };
        }
        return defaultToken(form, hh);
      },
    });
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
  });
  afterEach(() => h.cleanup());

  it('no refresca mientras el token es vigente', async () => {
    assert.equal(await h.auth.getAccessToken(), 'at-1');
    assert.equal(h.mock.tokenCalls().length, 1);
  });

  it('refresca cerca del vencimiento con client_id guardado, resource y sin scope', async () => {
    h.clock += 3600_000 - 60_000;
    assert.equal(await h.auth.getAccessToken(), 'at-new');
    const call = h.mock.tokenCalls().at(-1);
    assert.deepEqual(call.form, { grant_type: 'refresh_token', client_id: CLIENT, refresh_token: 'rt-1', resource: 'https://api.openai.com/v1' });
    const [rec] = await readAccounts(h.dir);
    assert.equal(rec.access_token, 'at-new');
    assert.equal(rec.refresh_token, 'rt-new');
    assert.equal(rec.expires_in, 7200);
    assert.equal(rec.saved_at, new Date(h.clock).toISOString());
    assert.ok(rec.id_token);
  });

  it('usa el refresh token rotado en el siguiente refresh', async () => {
    h.clock += 3600_000;
    await h.auth.getAccessToken();
    h.clock += 7200_000;
    await h.auth.getAccessToken();
    assert.equal(h.mock.tokenCalls().at(-1).form.refresh_token, 'rt-new');
  });

  it('serializa refreshes concurrentes: una sola llamada al token endpoint', async () => {
    h.clock += 3600_000;
    const tokens = await Promise.all([h.auth.getAccessToken(), h.auth.getAccessToken(), h.auth.getAccessToken()]);
    assert.deepEqual(tokens, ['at-new', 'at-new', 'at-new']);
    assert.equal(h.mock.tokenCalls().filter((c) => c.form.grant_type === 'refresh_token').length, 1);
  });

  it('dos instancias (procesos) comparten el lock: la segunda reutiliza el resultado', async () => {
    h.clock += 3600_000;
    const second = createChatgptAuth({ fetchImpl: h.mock.fetchImpl, dir: h.dir, now: () => h.clock, containerized: () => false });
    const out = await Promise.all([h.auth.getAccessToken(), second.getAccessToken()]);
    assert.deepEqual(out, ['at-new', 'at-new']);
    assert.equal(h.mock.tokenCalls().filter((c) => c.form.grant_type === 'refresh_token').length, 1);
  });

  it('staleToken fuerza renovar aunque no haya vencido, salvo que otro ya lo haya hecho', async () => {
    assert.equal(await h.auth.getAccessToken({ staleToken: 'at-1' }), 'at-new');
    assert.equal(await h.auth.getAccessToken({ staleToken: 'at-1' }), 'at-new');
    assert.equal(h.mock.tokenCalls().filter((c) => c.form.grant_type === 'refresh_token').length, 1);
  });

  it('conserva el refresh token anterior si la respuesta no trae uno nuevo y los scopes si no vienen', async () => {
    refreshBody = { access_token: 'at-x', token_type: 'Bearer', expires_in: 100 };
    h.clock += 3600_000;
    assert.equal(await h.auth.getAccessToken(), 'at-x');
    const [rec] = await readAccounts(h.dir);
    assert.equal(rec.refresh_token, 'rt-1');
    assert.ok(rec.scopes.includes(PLAN_SCOPE));
  });

  it('si el refresh quita el scope del plan, deshabilita el uso', async () => {
    refreshBody = { access_token: 'at-x', refresh_token: 'rt-x', token_type: 'Bearer', expires_in: 3600, scope: 'openid email' };
    h.clock += 3600_000;
    await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'chatgpt_plan_disabled');
    assert.equal(h.auth.isReady(), false);
  });

  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
    it(`${code}: borra tokens inutilizables y pide iniciar sesión de nuevo`, async () => {
      refreshBody = { error: code };
      h.clock += 3600_000;
      await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'chatgpt_reauth_required' && e.code === code);
      const [rec] = await readAccounts(h.dir);
      assert.equal(rec.access_token, null);
      assert.equal(rec.refresh_token, null);
      assert.equal(rec.client_id, CLIENT);
      const status = h.auth.getStatus();
      assert.equal(status.signedIn, false);
      assert.equal(status.reauthRequired, true);
      assert.equal(h.auth.isReady(), false);
      const ctx = await h.login();
      assert.equal(ctx.q.get('client_id'), CLIENT);
    });
  }

  it('invalid_client no borra credenciales (error de configuración)', async () => {
    refreshBody = { error: 'invalid_client', status: 401 };
    h.clock += 3600_000;
    await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'chatgpt_invalid_client');
    const [rec] = await readAccounts(h.dir);
    assert.equal(rec.refresh_token, 'rt-1');
  });

  it('un fallo temporal (5xx o red) no borra credenciales', async () => {
    h.clock += 3600_000;
    refreshBody = { error: 'temporarily_unavailable', status: 503 };
    await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'unavailable' && e.retriable === true);
    refreshBody = { throw: true };
    await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'network');
    const [rec] = await readAccounts(h.dir);
    assert.equal(rec.refresh_token, 'rt-1');
    assert.equal(h.auth.getStatus().signedIn, true);
  });
});

describe('chatgpt-auth: cierre de sesión', () => {
  let h;
  let revokeHandler;
  beforeEach(async () => {
    process.env.TASKY_RETRY_BASE_MS = '1';
    revokeHandler = () => ({ status: 200 });
    h = await harness({ revoke: (form, n) => revokeHandler(form, n) });
    await h.login();
    await h.callback({ code: 'c', client_id: CLIENT });
  });
  afterEach(async () => {
    delete process.env.TASKY_RETRY_BASE_MS;
    await h.cleanup();
  });

  it('revoca el refresh token en el endpoint de discovery y borra los tokens locales', async () => {
    const out = await h.auth.signOut();
    assert.equal(out.revoked, true);
    assert.deepEqual(h.mock.revokeCalls()[0].form, { token: 'rt-1', token_type_hint: 'refresh_token', client_id: CLIENT });
    const [rec] = await readAccounts(h.dir);
    assert.equal(rec.access_token, null);
    assert.equal(rec.refresh_token, null);
    assert.equal(rec.id_token, null);
    assert.equal(rec.client_id, CLIENT);
    assert.equal(rec.subject, 'user-123');
    assert.match(rec.ext_agent_host_id, /^urn:uuid:/);
    const status = h.auth.getStatus();
    assert.equal(status.signedIn, false);
    assert.equal(status.reauthRequired, false);
    assert.equal(h.auth.isReady(), false);
    await assert.rejects(h.auth.getAccessToken(), (e) => e.kind === 'chatgpt_not_signed_in');
  });

  it('un próximo login reutiliza client_id y host id, sin id_token_hint', async () => {
    const host = h.ctx.q.get('ext_agent_host_id');
    await h.auth.signOut();
    const ctx = await h.login();
    assert.equal(ctx.q.get('client_id'), CLIENT);
    assert.equal(ctx.q.get('ext_agent_host_id'), host);
    assert.equal(ctx.q.get('id_token_hint'), null);
    assert.equal(ctx.q.get('login_hint'), 'user@example.com');
  });

  it('reintenta la revocación ante 5xx y red', async () => {
    revokeHandler = (form, n) => (n === 1 ? { status: 503 } : n === 2 ? { throw: true } : { status: 200 });
    const out = await h.auth.signOut();
    assert.equal(out.revoked, true);
    assert.equal(h.mock.revokeCalls().length, 3);
  });

  it('si no se confirma la revocación igual borra los tokens e informa revoked=false', async () => {
    revokeHandler = () => ({ status: 503 });
    const out = await h.auth.signOut();
    assert.equal(out.revoked, false);
    assert.equal(h.mock.revokeCalls().length, 3);
    const [rec] = await readAccounts(h.dir);
    assert.equal(rec.refresh_token, null);
    assert.equal(h.auth.getStatus().signedIn, false);
  });

  it('cancela un login pendiente al cerrar sesión', async () => {
    const ctx = await h.login();
    await h.auth.signOut();
    await assert.rejects(rawRequest({ port: ctx.port, pathAndQuery: '/auth/callback' }));
    assert.equal(h.auth.getStatus().login.state, 'idle');
  });

  it('sin sesión devuelve revoked=null', async () => {
    await h.auth.signOut();
    assert.equal((await h.auth.signOut()).revoked, null);
  });
});
