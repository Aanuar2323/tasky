/**
 * llm/chatgpt-auth.js — "Sign in with ChatGPT" (token sharing, cliente open source).
 *
 * Flujo (ver README → ChatGPT):
 *   1. Registro dinámico: `client_id=dynamic_agent_client` + `ext_agent_host_id` +
 *      `agent_name_hint`. El callback devuelve el `client_id` emitido, que se guarda
 *      y se reutiliza (sin `agent_name_hint`) en los inicios de sesión siguientes.
 *   2. OAuth con PKCE (S256), `state` y `nonce` frescos por intento. El callback
 *      escucha SOLO en 127.0.0.1, en `/auth/callback`, con la URI exacta enviada.
 *   3. Canje del código → validación del ID token (firma contra JWKS, issuer,
 *      audience = client_id emitido, expiración, nonce) → verificación del scope
 *      `chatgpt.tokens.use.direct`.
 *   4. Credenciales en archivos 0600 (un registro por client_id), nunca en logs ni
 *      en el navegador. Refresh serializado (mutex + lock de archivo) y cierre de
 *      sesión con revocación del refresh token.
 *
 * `createChatgptAuth()` es una factory con dependencias inyectables (fetch,
 * directorio, reloj, apertura del navegador) para poder probarla sin red.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getStorageRoot } from '../storage.js';
import { llmError } from './errors.js';

export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const RESOURCE = 'https://api.openai.com/v1';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const REQUESTED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
export const CALLBACK_PATH = '/auth/callback';
export const AGENT_NAME = 'Tasky';

const DEFAULT_PORT = 1455;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 120 * 1000;
const CLOCK_SKEW_S = 60;
const HTTP_TIMEOUT_MS = 15_000;
const META_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 30_000;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{3,128}$/;

/** Errores de refresh que invalidan el token set (hay que repetir OAuth). */
const TERMINAL_REFRESH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error tipado de la capa de autenticación (kind chatgpt_* o genérico). */
function authError(kind, message, extra = {}) {
  return llmError(kind, message, { retriable: false, ...extra });
}

function isOpenAiHttps(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'openai.com' || u.hostname.endsWith('.openai.com'));
  } catch {
    return false;
  }
}

function isContainerized() {
  if (process.env.TASKY_IN_DOCKER === '1') return true;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    return /docker|kubepods|containerd|libpod/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/** Abre la URL en el navegador del sistema. Resuelve false si no se pudo. */
function defaultOpenBrowser(url) {
  return new Promise((resolve) => {
    if (!url.startsWith(`${AUTHORIZE_URL}?`)) return resolve(false);
    let cmd;
    let args;
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      cmd = 'rundll32';
      args = ['url.dll,FileProtocolHandler', url];
    } else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return resolve(false);
      cmd = 'xdg-open';
      args = [url];
    }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function callbackPage(ok, text) {
  const title = ok ? 'Sesión iniciada' : 'No se pudo iniciar sesión';
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title><body style="font:16px system-ui;margin:12vh auto;max-width:28rem;padding:0 1.5rem">`
    + `<h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;
}

// ---- JWT ----------------------------------------------------------------------------

function decodeJwtPart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Verifica la firma con la JWK y devuelve true/false. Solo RS256 y ES256. */
function verifySignature(alg, jwk, signingInput, signature) {
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return false;
  }
  try {
    if (alg === 'RS256') return crypto.verify('sha256', signingInput, key, signature);
    if (alg === 'ES256') return crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
  return false;
}

// ---- Factory ------------------------------------------------------------------------

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   dir?: string | (() => string),
 *   now?: () => number,
 *   openBrowser?: (url: string) => Promise<boolean>,
 *   preferredPort?: number,
 *   containerized?: () => boolean,
 * }} [opts]
 */
export function createChatgptAuth(opts = {}) {
  const doFetch = (...args) => (opts.fetchImpl ?? fetch)(...args);
  const now = opts.now ?? (() => Date.now());
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  const inContainer = opts.containerized ?? isContainerized;
  const credentialsDir = () => {
    const configured = typeof opts.dir === 'function' ? opts.dir() : opts.dir;
    return path.resolve(configured ?? process.env.TASKY_CHATGPT_CREDENTIALS_DIR ?? path.join(getStorageRoot(), 'credentials', 'chatgpt'));
  };

  let pending = null; // intento de login en curso (solo memoria)
  let lastLogin = { state: 'idle' };
  let meta = null; // discovery cacheado
  let jwks = null;
  let jwksFetchedAt = 0;
  const refreshing = new Map(); // clientId → Promise (mutex en proceso)

  // ---- Persistencia ----------------------------------------------------------------

  const accountsDir = () => path.join(credentialsDir(), 'accounts');
  const fileFor = (clientId) => path.join(accountsDir(), `${crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 32)}.json`);
  const accountIdOf = (clientId) => crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 16);

  function ensureDirSync(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort (Windows) */ }
  }

  async function writeAtomic(file, data) {
    ensureDirSync(path.dirname(file));
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { await fsp.chmod(tmp, 0o600); } catch { /* best effort */ }
    await fsp.rename(tmp, file);
  }

  function readJsonSync(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function loadRecord(clientId) {
    const rec = clientId ? readJsonSync(fileFor(clientId)) : null;
    return rec && rec.client_id === clientId ? rec : null;
  }

  function listRecords() {
    try {
      return fs.readdirSync(accountsDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJsonSync(path.join(accountsDir(), f)))
        .filter((r) => r && typeof r.client_id === 'string')
        .sort((a, b) => String(a.email ?? '').localeCompare(String(b.email ?? '')) || a.client_id.localeCompare(b.client_id));
    } catch {
      return [];
    }
  }

  function activeClientId() {
    return readJsonSync(path.join(credentialsDir(), 'active.json'))?.client_id ?? null;
  }

  function activeRecord() {
    const id = activeClientId();
    return id ? loadRecord(id) : null;
  }

  async function setActive(clientId) {
    await writeAtomic(path.join(credentialsDir(), 'active.json'), { client_id: clientId });
  }

  async function hostId() {
    const file = path.join(credentialsDir(), 'host.json');
    const existing = readJsonSync(file)?.ext_agent_host_id;
    if (typeof existing === 'string' && existing) return existing;
    const id = `urn:uuid:${crypto.randomUUID()}`;
    await writeAtomic(file, { ext_agent_host_id: id });
    return id;
  }

  const hasPlanScope = (rec) => Array.isArray(rec?.scopes) && rec.scopes.includes(PLAN_SCOPE);
  const isSignedIn = (rec) => !!(rec?.access_token && rec?.refresh_token && !rec?.reauth_required);

  function expiresAtMs(rec) {
    const expiresIn = Number(rec?.expires_in);
    const saved = Date.parse(rec?.saved_at ?? '');
    if (!Number.isFinite(expiresIn) || Number.isNaN(saved)) return 0;
    return saved + expiresIn * 1000;
  }

  const needsRefresh = (rec) => now() >= expiresAtMs(rec) - REFRESH_SKEW_MS;

  function labelFor(rec, all) {
    const email = rec.email || 'Cuenta de ChatGPT';
    const dup = all.filter((r) => (r.email || '') === (rec.email || '')).length > 1;
    return dup ? `${email} (${rec.client_id.slice(-6)})` : email;
  }

  // ---- Estado público (sin secretos) ---------------------------------------------------

  function containerBlocked() {
    return inContainer() && process.env.TASKY_CHATGPT_ALLOW_CONTAINER !== '1';
  }

  function getStatus() {
    const all = listRecords();
    const rec = activeRecord();
    const signedIn = isSignedIn(rec);
    return {
      available: !containerBlocked(),
      unavailableReason: containerBlocked() ? 'container' : null,
      signedIn,
      planUsage: signedIn && hasPlanScope(rec),
      reauthRequired: !!rec?.reauth_required,
      email: rec?.email ?? null,
      accountId: rec ? accountIdOf(rec.client_id) : null,
      accounts: all.map((r) => ({
        id: accountIdOf(r.client_id),
        label: labelFor(r, all),
        email: r.email ?? null,
        active: rec?.client_id === r.client_id,
        signedIn: isSignedIn(r),
      })),
      login: { ...lastLogin },
    };
  }

  /** ¿Se puede inferir con el plan? (síncrono, sin refrescar) */
  function isReady() {
    const rec = activeRecord();
    return isSignedIn(rec) && hasPlanScope(rec);
  }

  function activeAccountKey() {
    return activeClientId();
  }

  // ---- HTTP hacia auth.openai.com -----------------------------------------------------

  async function postForm(url, params) {
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      throw authError('network', 'No se pudo contactar a auth.openai.com', { retriable: true, code: e?.name === 'TimeoutError' ? 'timeout' : undefined });
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* sin JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async function getJson(url) {
    let res;
    try {
      res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: 'error' });
    } catch {
      throw authError('network', 'No se pudo contactar a auth.openai.com', { retriable: true });
    }
    if (!res.ok) throw authError('bad_gateway', `auth.openai.com respondió ${res.status}`, { status: res.status, retriable: res.status >= 500 });
    try {
      return await res.json();
    } catch {
      throw authError('bad_gateway', 'Respuesta inválida de auth.openai.com');
    }
  }

  async function discovery() {
    if (meta && now() - meta.at < META_TTL_MS) return meta.data;
    const data = await getJson(DISCOVERY_URL);
    if (data?.issuer !== ISSUER) throw authError('bad_gateway', 'El issuer de OpenAI no coincide');
    if (!isOpenAiHttps(data.jwks_uri)) throw authError('bad_gateway', 'jwks_uri inválido en la configuración de OpenAI');
    if (data.revocation_endpoint && !isOpenAiHttps(data.revocation_endpoint)) {
      throw authError('bad_gateway', 'revocation_endpoint inválido en la configuración de OpenAI');
    }
    meta = { at: now(), data };
    return data;
  }

  async function getJwks(force = false) {
    if (jwks && !force && now() - jwksFetchedAt < META_TTL_MS) return jwks;
    if (force && jwks && now() - jwksFetchedAt < JWKS_MIN_REFETCH_MS) return jwks;
    const data = await getJson((await discovery()).jwks_uri);
    if (!Array.isArray(data?.keys)) throw authError('bad_gateway', 'JWKS inválido');
    jwks = data.keys;
    jwksFetchedAt = now();
    return jwks;
  }

  /**
   * Valida un ID token: firma (JWKS), issuer, audience, expiración y nonce.
   * @returns {Promise<object>} claims verificados
   */
  async function verifyIdToken(token, { clientId, nonce, subject } = {}) {
    const bad = (why) => authError('chatgpt_unauthorized', `ID token inválido (${why})`, { code: 'invalid_id_token' });
    if (typeof token !== 'string') throw bad('ausente');
    const parts = token.split('.');
    if (parts.length !== 3) throw bad('formato');
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (!header || !claims) throw bad('formato');
    if (header.alg !== 'RS256' && header.alg !== 'ES256') throw bad('algoritmo');
    let signature;
    try { signature = Buffer.from(parts[2], 'base64url'); } catch { throw bad('firma'); }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);

    const pick = (keys) => keys.filter((k) => {
      if (header.kid && k.kid !== header.kid) return false;
      if (k.use && k.use !== 'sig') return false;
      if (k.alg && k.alg !== header.alg) return false;
      return header.alg === 'RS256' ? k.kty === 'RSA' : (k.kty === 'EC' && k.crv === 'P-256');
    });
    let candidates = pick(await getJwks());
    if (!candidates.length) candidates = pick(await getJwks(true));
    if (!candidates.length || !candidates.some((k) => verifySignature(header.alg, k, signingInput, signature))) throw bad('firma');

    const nowS = Math.floor(now() / 1000);
    if (claims.iss !== ISSUER) throw bad('issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!clientId || !aud.includes(clientId)) throw bad('audience');
    if (aud.length > 1 && claims.azp !== undefined && claims.azp !== clientId) throw bad('azp');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw bad('expirado');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) throw bad('nbf');
    if (typeof claims.iat === 'number' && claims.iat - 300 > nowS) throw bad('iat');
    if (nonce !== undefined) {
      const a = Buffer.from(String(claims.nonce ?? ''));
      const b = Buffer.from(String(nonce));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('nonce');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) throw bad('sub');
    if (subject !== undefined && claims.sub !== subject) throw bad('sub distinto');
    return claims;
  }

  // ---- Login ------------------------------------------------------------------------

  function closePending(reason) {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { server } = pending;
    pending = null;
    try {
      server.close();
      server.closeAllConnections?.();
    } catch { /* ya cerrado */ }
    if (reason && lastLogin.state === 'pending') lastLogin = { state: 'idle' };
  }

  function listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once('error', onError);
      // Solo loopback IPv4: jamás 0.0.0.0 ni localhost.
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    });
  }

  function safeEqual(a, b) {
    const x = Buffer.from(String(a ?? ''));
    const y = Buffer.from(String(b ?? ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  async function startLogin({ newAccount = false, reconsent = false } = {}) {
    if (containerBlocked()) {
      throw authError('chatgpt_forbidden', 'Iniciar sesión con ChatGPT requiere ejecutar Tasky en tu equipo, fuera de Docker', { code: 'container_unsupported', status: 409 });
    }
    closePending();

    const saved = newAccount ? null : activeRecord();
    const reauth = !!saved;
    const hostIdValue = await hostId();
    const state = b64url(crypto.randomBytes(32));
    const nonce = b64url(crypto.randomBytes(32));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const server = http.createServer();
    let port;
    const wanted = Number(opts.preferredPort ?? process.env.TASKY_CHATGPT_CALLBACK_PORT ?? DEFAULT_PORT);
    try {
      port = await listen(server, wanted);
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES') throw authError('network', 'No se pudo abrir el puerto local para el callback', { retriable: true });
      port = await listen(server, 0).catch(() => { throw authError('network', 'No se pudo abrir el puerto local para el callback', { retriable: true }); });
    }
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const attempt = {
      state, nonce, verifier, redirectUri, server, port,
      clientId: reauth ? saved.client_id : null,
      reconsent: !!reconsent,
      hostId: hostIdValue,
      timer: setTimeout(() => {
        if (pending === attempt) {
          closePending();
          lastLogin = { state: 'error', code: 'timeout', message: 'El inicio de sesión expiró. Intentá de nuevo.' };
        }
      }, LOGIN_TTL_MS),
    };
    attempt.timer.unref?.();
    pending = attempt;
    lastLogin = { state: 'pending' };

    server.on('request', (req, res) => { void onRequest(attempt, req, res); });

    const base = {
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: REQUESTED_SCOPES.join(' '),
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ext_agent_host_id: hostIdValue,
    };
    const params = reauth
      ? { client_id: saved.client_id, ...base }
      : { client_id: DYNAMIC_CLIENT_ID, agent_name_hint: AGENT_NAME, ...base };
    if (reauth && saved.email) params.login_hint = saved.email;
    if (reconsent && reauth) params.prompt = 'consent';
    const safeUrl = `${AUTHORIZE_URL}?${new URLSearchParams(params).toString()}`;
    // id_token_hint solo viaja en la URL que abre el servidor; nunca se devuelve al navegador.
    const fullUrl = reauth && saved.id_token ? `${safeUrl}&${new URLSearchParams({ id_token_hint: saved.id_token }).toString()}` : safeUrl;

    let opened = false;
    try { opened = await openBrowser(fullUrl); } catch { opened = false; }
    return { status: 'pending', opened, ...(opened ? {} : { authorizeUrl: safeUrl }) };
  }

  async function onRequest(attempt, req, res) {
    const finish = (status, ok, text) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
      });
      res.end(callbackPage(ok, text));
    };
    try {
      // Anti DNS-rebinding: solo la URI exacta que se envió a OpenAI.
      if (req.headers.host !== `127.0.0.1:${attempt.port}`) return finish(400, false, 'Solicitud no válida.');
      if (req.method !== 'GET') return finish(405, false, 'Método no permitido.');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) return finish(404, false, 'No encontrado.');
      if (pending !== attempt) return finish(410, false, 'Este intento ya terminó. Volvé a Tasky.');

      const q = url.searchParams;
      // Un callback con otro state no consume el intento (otro proceso local no lo cancela).
      if (!safeEqual(q.get('state'), attempt.state)) return finish(400, false, 'La respuesta no corresponde a este inicio de sesión.');
      pending = null;
      clearTimeout(attempt.timer);

      let outcome;
      try {
        outcome = await completeLogin(attempt, q);
      } catch (e) {
        outcome = { ok: false, code: e?.code ?? e?.kind ?? 'error', message: e?.message ?? 'Error al iniciar sesión' };
      }
      lastLogin = outcome.ok
        ? { state: 'success', planUsage: outcome.planUsage }
        : { state: 'error', code: outcome.code, message: outcome.message };
      finish(outcome.ok ? 200 : 400, outcome.ok, outcome.ok ? 'Ya podés volver a Tasky.' : 'Volvé a Tasky para ver el motivo.');
    } catch {
      try { finish(500, false, 'Error interno.'); } catch { /* respuesta ya enviada */ }
    } finally {
      // `Connection: close` ya pidió cerrar el socket; solo se deja de escuchar.
      if (pending !== attempt) {
        try { attempt.server.close(); } catch { /* ya cerrado */ }
      }
    }
  }

  const userMessages = {
    access_denied: 'Cancelaste la autorización en ChatGPT.',
    invalid_grant: 'El código de autorización venció. Intentá de nuevo.',
    account_mismatch: 'Elegiste otra cuenta de ChatGPT. Usá “Otra cuenta” para agregarla.',
  };

  async function completeLogin(attempt, q) {
    const oauthError = q.get('error');
    if (oauthError) {
      const code = /^[a-z_]{1,64}$/.test(oauthError) ? oauthError : 'oauth_error';
      return { ok: false, code, message: userMessages[code] ?? 'ChatGPT rechazó el inicio de sesión.' };
    }
    const code = q.get('code');
    if (!code) return { ok: false, code: 'missing_code', message: 'ChatGPT no devolvió un código de autorización.' };

    const returnedClient = q.get('client_id');
    let clientId = attempt.clientId;
    if (clientId) {
      if (returnedClient && returnedClient !== clientId) {
        return { ok: false, code: 'client_mismatch', message: 'ChatGPT devolvió otro registro. Se descartó el resultado.' };
      }
    } else {
      if (!returnedClient || returnedClient === DYNAMIC_CLIENT_ID || !CLIENT_ID_RE.test(returnedClient)) {
        return { ok: false, code: 'registration_incomplete', message: 'El registro de Tasky en ChatGPT quedó incompleto. Intentá de nuevo.' };
      }
      clientId = returnedClient;
    }

    const res = await postForm(TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: RESOURCE,
    });
    if (!res.ok) {
      const errCode = typeof res.json?.error === 'string' ? res.json.error : (res.json?.error?.code ?? 'token_error');
      return { ok: false, code: errCode, message: userMessages[errCode] ?? `No se pudo canjear el código (${res.status}).` };
    }
    const t = res.json ?? {};
    if (String(t.token_type ?? '').toLowerCase() !== 'bearer' || typeof t.access_token !== 'string' || !t.access_token) {
      return { ok: false, code: 'invalid_token_response', message: 'Respuesta de tokens inválida.' };
    }
    if (typeof t.refresh_token !== 'string' || !t.refresh_token) {
      return { ok: false, code: 'no_refresh_token', message: 'ChatGPT no entregó un refresh token; no se puede mantener la sesión.' };
    }

    const claims = await verifyIdToken(t.id_token, { clientId, nonce: attempt.nonce });

    const existing = loadRecord(clientId);
    if (attempt.clientId && existing && existing.subject && existing.subject !== claims.sub) {
      return { ok: false, code: 'account_mismatch', message: userMessages.account_mismatch };
    }

    const granted = typeof t.scope === 'string' && t.scope.trim()
      ? t.scope
      : (q.get('scope') ?? '');
    const scopes = [...new Set(granted.split(/[\s+]+/).filter((s) => REQUESTED_SCOPES.includes(s)))].sort();

    const record = {
      email: typeof claims.email === 'string' ? claims.email : (existing?.email ?? null),
      issuer: ISSUER,
      subject: claims.sub,
      client_id: clientId,
      ext_agent_host_id: attempt.hostId,
      id_token: t.id_token,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_type: 'Bearer',
      expires_in: Number(t.expires_in) || 3600,
      scopes,
      saved_at: new Date(now()).toISOString(),
    };
    await writeAtomic(fileFor(clientId), record);
    await setActive(clientId);
    return { ok: true, planUsage: scopes.includes(PLAN_SCOPE) };
  }

  function cancelLogin() {
    closePending(true);
    lastLogin = { state: 'idle' };
  }

  // ---- Refresh ----------------------------------------------------------------------

  async function withFileLock(fn) {
    const lock = path.join(credentialsDir(), 'refresh.lock');
    ensureDirSync(credentialsDir());
    const deadline = Date.now() + 15_000;
    let handle;
    for (;;) {
      try {
        handle = await fsp.open(lock, 'wx', 0o600);
        break;
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        try {
          const st = await fsp.stat(lock);
          if (Date.now() - st.mtimeMs > 30_000) await fsp.rm(lock, { force: true });
        } catch { /* lo liberó otro proceso */ }
        if (Date.now() > deadline) throw authError('network', 'Otro proceso está renovando la sesión de ChatGPT', { retriable: true });
        await sleep(80);
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fsp.rm(lock, { force: true }).catch(() => {});
    }
  }

  async function doRefresh(clientId, staleToken) {
    return withFileLock(async () => {
      const rec = loadRecord(clientId);
      if (!rec || !rec.refresh_token) throw authError('chatgpt_not_signed_in', 'No hay sesión de ChatGPT');
      // Otro proceso ya renovó mientras esperábamos el lock.
      if (staleToken !== undefined ? rec.access_token !== staleToken : !needsRefresh(rec)) return rec;

      const res = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: rec.client_id,
        refresh_token: rec.refresh_token,
        resource: RESOURCE,
      });
      if (!res.ok) {
        const code = typeof res.json?.error === 'string' ? res.json.error : (res.json?.error?.code ?? res.json?.code ?? '');
        if (res.status >= 500 || res.status === 429) {
          throw authError('unavailable', 'ChatGPT no pudo renovar la sesión ahora', { status: res.status, retriable: true, code: code || undefined });
        }
        if (TERMINAL_REFRESH_CODES.has(code)) {
          await writeAtomic(fileFor(clientId), { ...rec, access_token: null, refresh_token: null, reauth_required: true });
          throw authError('chatgpt_reauth_required', 'La sesión de ChatGPT venció o fue revocada', { status: res.status, code });
        }
        if (code === 'invalid_client') {
          throw authError('chatgpt_invalid_client', 'ChatGPT no reconoce el registro de Tasky', { status: res.status, code });
        }
        throw authError('chatgpt_unauthorized', `No se pudo renovar la sesión (${res.status})`, { status: res.status, code: code || undefined });
      }
      const t = res.json ?? {};
      if (typeof t.access_token !== 'string' || !t.access_token || String(t.token_type ?? 'Bearer').toLowerCase() !== 'bearer') {
        throw authError('bad_gateway', 'Respuesta de renovación inválida');
      }
      let idToken = rec.id_token;
      if (typeof t.id_token === 'string' && t.id_token) {
        await verifyIdToken(t.id_token, { clientId: rec.client_id, subject: rec.subject });
        idToken = t.id_token;
      }
      const scopes = typeof t.scope === 'string' && t.scope.trim()
        ? [...new Set(t.scope.split(/[\s+]+/).filter((s) => REQUESTED_SCOPES.includes(s)))].sort()
        : rec.scopes;
      // access, refresh, expiración y scopes se reemplazan juntos.
      const next = {
        ...rec,
        id_token: idToken,
        access_token: t.access_token,
        refresh_token: typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : rec.refresh_token,
        token_type: 'Bearer',
        expires_in: Number(t.expires_in) || rec.expires_in || 3600,
        scopes,
        saved_at: new Date(now()).toISOString(),
      };
      delete next.reauth_required;
      await writeAtomic(fileFor(clientId), next);
      return next;
    });
  }

  /**
   * Access token vigente de la cuenta activa (renueva si está por vencer).
   * `staleToken`: token que el servidor rechazó; fuerza renovación salvo que otro ya lo haya hecho.
   * @returns {Promise<string>}
   */
  async function getAccessToken({ staleToken } = {}) {
    const rec = activeRecord();
    if (!rec || !rec.access_token) {
      throw authError(rec?.reauth_required ? 'chatgpt_reauth_required' : 'chatgpt_not_signed_in', 'No hay sesión de ChatGPT activa');
    }
    if (!hasPlanScope(rec)) throw authError('chatgpt_plan_disabled', 'El uso del plan de ChatGPT no está habilitado');
    if (staleToken === undefined && !needsRefresh(rec)) return rec.access_token;
    if (staleToken !== undefined && rec.access_token !== staleToken) return rec.access_token;

    let job = refreshing.get(rec.client_id);
    if (!job) {
      job = doRefresh(rec.client_id, staleToken).finally(() => refreshing.delete(rec.client_id));
      refreshing.set(rec.client_id, job);
    }
    const fresh = await job;
    if (!hasPlanScope(fresh)) throw authError('chatgpt_plan_disabled', 'El uso del plan de ChatGPT no está habilitado');
    return fresh.access_token;
  }

  // ---- Logout -----------------------------------------------------------------------

  /**
   * Revoca el refresh token (con reintentos) y borra tokens locales. Conserva el
   * mapeo cuenta/client_id y el host id para un próximo inicio de sesión.
   * @returns {Promise<{revoked: boolean|null}>} null si no había token que revocar
   */
  async function signOut() {
    cancelLogin();
    const rec = activeRecord();
    if (!rec) return { revoked: null };
    let revoked = rec.refresh_token ? false : null;
    if (rec.refresh_token) {
      const base = Number(process.env.TASKY_RETRY_BASE_MS ?? 500);
      for (let attempt = 0; attempt < 3 && !revoked; attempt += 1) {
        try {
          const endpoint = (await discovery()).revocation_endpoint;
          if (!endpoint) break;
          const res = await postForm(endpoint, { token: rec.refresh_token, token_type_hint: 'refresh_token', client_id: rec.client_id });
          if (res.status === 200) revoked = true;
          else if (res.status < 500) break;
        } catch (e) {
          if (!e?.retriable) break;
        }
        if (!revoked && attempt < 2) await sleep(base * 2 ** attempt);
      }
    }
    const { access_token: _a, refresh_token: _r, id_token: _i, ...rest } = rec;
    await writeAtomic(fileFor(rec.client_id), { ...rest, access_token: null, refresh_token: null, id_token: null, reauth_required: false });
    return { revoked };
  }

  async function selectAccount(accountId) {
    const rec = listRecords().find((r) => accountIdOf(r.client_id) === accountId);
    if (!rec) throw authError('bad_request', 'Cuenta desconocida');
    await setActive(rec.client_id);
  }

  return {
    getStatus,
    isReady,
    startLogin,
    cancelLogin,
    getAccessToken,
    signOut,
    selectAccount,
    activeAccountKey,
    verifyIdToken,
    _internals: { credentialsDir, loadRecord, listRecords },
  };
}

export const chatgptAuth = createChatgptAuth();
