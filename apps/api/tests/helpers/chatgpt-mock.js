/**
 * Utilidades de prueba para "Sign in with ChatGPT": firma ID tokens RS256 con una clave
 * local y simula auth.openai.com (discovery, JWKS, token, revocación) sin red.
 */

import crypto from 'node:crypto';

export const ISSUER = 'https://auth.openai.com';

export function makeKeys(kid = 'test-key-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk };
}

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** JWT firmado. `claims` se mezcla sobre los claims válidos por defecto. */
export function signJwt(keys, claims = {}, { alg = 'RS256', kid, tamper = false } = {}) {
  const header = { alg, typ: 'JWT', kid: kid ?? keys.kid };
  const payload = `${enc(header)}.${enc(claims)}`;
  let signature;
  if (alg === 'none') return `${payload}.`;
  if (alg === 'HS256') signature = crypto.createHmac('sha256', 'secret').update(payload).digest();
  else signature = crypto.sign('sha256', Buffer.from(payload), keys.privateKey);
  const sig = signature.toString('base64url');
  return `${tamper ? `${enc(header)}.${enc({ ...claims, sub: 'attacker' })}` : payload}.${sig}`;
}

export function idTokenFor(keys, { clock = Date.now(), ...over } = {}) {
  const nowS = Math.floor(clock / 1000);
  return signJwt(keys, {
    iss: ISSUER,
    aud: 'oaiapp_test',
    sub: 'user-123',
    email: 'user@example.com',
    iat: nowS,
    exp: nowS + 3600,
    ...over,
  });
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * fetch simulado de auth.openai.com. `handlers.token(form, n)` y `handlers.revoke(form, n)`
 * devuelven `{status?, body?}`; `calls` registra todo lo enviado.
 */
export function mockAuthServer(keys, handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    const entry = { url: u, method: init.method ?? 'GET', headers: init.headers, form };
    calls.push(entry);
    if (u === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
        token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
      });
    }
    if (u === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [keys.jwk] });
    if (u === `${ISSUER}/api/accounts/oauth/token`) {
      const n = calls.filter((c) => c.url === u).length;
      const out = await handlers.token?.(form, n);
      if (out?.throw) throw new TypeError('fetch failed');
      return json(out?.body ?? {}, out?.status ?? 200);
    }
    if (u === `${ISSUER}/api/accounts/oauth/revoke`) {
      const n = calls.filter((c) => c.url === u).length;
      const out = (await handlers.revoke?.(form, n)) ?? { status: 200 };
      if (out.throw) throw new TypeError('fetch failed');
      return new Response(out.status === 200 ? '' : JSON.stringify(out.body ?? {}), { status: out.status });
    }
    return new Response('not found', { status: 404 });
  };
  return {
    fetchImpl,
    calls,
    tokenCalls: () => calls.filter((c) => c.url.endsWith('/oauth/token')),
    revokeCalls: () => calls.filter((c) => c.url.endsWith('/oauth/revoke')),
  };
}
