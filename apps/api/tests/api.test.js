import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PORT = 9876;
const BASE = `http://localhost:${PORT}`;

describe('API Endpoints', async () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-api-test-'));
    process.env.STORAGE_ROOT = tmpDir;
    process.env.PORT = String(PORT);
    // Sin red real: los proveedores apuntan a un puerto cerrado.
    process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:9/api/v1';
    process.env.NVIDIA_BASE_URL = 'http://127.0.0.1:9/v1';

    // Dynamic import so env vars are set before modules load
    const mod = await import('../src/index.js');
    server = mod.server;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    delete process.env.STORAGE_ROOT;
    delete process.env.PORT;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.NVIDIA_BASE_URL;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function fetch_(url, opts = {}) {
    return fetch(`${BASE}${url}`, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
  }

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await fetch_('/health');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { ok: true });
    });
  });

  describe('GET /api/status', () => {
    it('returns status object', async () => {
      const res = await fetch_('/api/status');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.ok('configured' in body);
      assert.ok('provider' in body);
      assert.ok('model' in body);
      assert.ok('providerId' in body);
      assert.ok('availableProviders' in body);
      assert.ok('openrouterConfigured' in body);
      assert.ok('nvidiaConfigured' in body);
      assert.equal(typeof body.availableProviders, 'object');
    });
  });

  describe('GET /api/provider', () => {
    it('returns providers object', async () => {
      const res = await fetch_('/api/provider');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok('providers' in body);
      assert.ok('activeProvider' in body);
      assert.equal(typeof body.providers, 'object');
      assert.ok('openrouter' in body.providers);
      assert.ok('nvidia' in body.providers);
    });
  });

  describe('POST /api/provider/keys', () => {
    it('accepts valid provider key', async () => {
      const res = await fetch_('/api/provider/keys', {
        method: 'POST',
        body: JSON.stringify({ provider: 'nvidia', apiKey: 'nvapi-test-key-12345678' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    it('rejects missing apiKey', async () => {
      const res = await fetch_('/api/provider/keys', {
        method: 'POST',
        body: JSON.stringify({ provider: 'nvidia' }),
      });
      assert.ok(res.status === 400 || res.status === 500);
    });
  });

  describe('GET /api/models', () => {
    it('returns models or error depending on configuration', async () => {
      const res = await fetch_('/api/models');
      // Without explicit provider param, uses active provider.
      // If a provider is configured the endpoint attempts upstream;
      // if not, returns 400.
      assert.ok(res.status === 200 || res.status === 400 || res.status === 502);
    });
  });

  describe('POST /api/projects', () => {
    let projectId;

    it('creates a new project', async () => {
      const res = await fetch_('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Project' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.id);
      assert.equal(typeof body.id, 'string');
      assert.equal(body.id.length, 10);
      projectId = body.id;
    });

    it('project appears in list', async () => {
      const res = await fetch_('/api/projects');
      const body = await res.json();
      const ids = body.projects.map(p => p.id);
      assert.ok(ids.includes(projectId));
    });

    it('project has scaffolded areas', async () => {
      const res = await fetch_(`/api/projects/${projectId}/areas`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.areas.length, 3);
      assert.equal(body.activeAreaId, 'a1');
    });
  });

  describe('Areas CRUD', () => {
    let projectId;

    before(async () => {
      const res = await fetch_('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Areas Test' }),
      });
      const body = await res.json();
      projectId = body.id;
    });

    it('GET /api/projects/:id/rules returns default rules', async () => {
      const res = await fetch_(`/api/projects/${projectId}/rules`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.content.includes('Reglas globales'));
    });

    it('PUT /api/projects/:id/rules updates global rules', async () => {
      const res = await fetch_(`/api/projects/${projectId}/rules`, {
        method: 'PUT',
        body: JSON.stringify({ markdown: '# Custom Rules\nTest' }),
      });
      assert.equal(res.status, 200);

      const getRes = await fetch_(`/api/projects/${projectId}/rules`);
      const body = await getRes.json();
      assert.ok(body.content.includes('Custom Rules'));
    });

    it('PUT /api/projects/:id/rules with areaId updates area rules', async () => {
      const res = await fetch_(`/api/projects/${projectId}/rules`, {
        method: 'PUT',
        body: JSON.stringify({ markdown: '# Area Rules\nFor a1', areaId: 'a1' }),
      });
      assert.equal(res.status, 200);

      const getRes = await fetch_(`/api/projects/${projectId}/rules?areaId=a1`);
      const body = await getRes.json();
      assert.ok(body.content.includes('Area Rules'));
    });
  });

  describe('File operations', () => {
    let projectId;

    before(async () => {
      const res = await fetch_('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Files Test' }),
      });
      const body = await res.json();
      projectId = body.id;
    });

    it('POST /api/projects/:id/file creates text file', async () => {
      const res = await fetch_(`/api/projects/${projectId}/file`, {
        method: 'POST',
        body: JSON.stringify({ path: 'test/myfile.txt', content: 'file content' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });

    it('GET /api/projects/:id/file reads the created file', async () => {
      const res = await fetch_(`/api/projects/${projectId}/file?path=test/myfile.txt`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content, 'file content');
    });

    it('GET /api/projects/:id/tree lists files', async () => {
      const res = await fetch_(`/api/projects/${projectId}/tree`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.entries.length > 0);
      const names = body.entries.map(e => e.name);
      assert.ok(names.includes('test'));
    });

    it('DELETE /api/projects/:id/file removes file', async () => {
      const res = await fetch_(`/api/projects/${projectId}/file`, {
        method: 'DELETE',
        body: JSON.stringify({ path: 'test/myfile.txt' }),
      });
      assert.equal(res.status, 200);

      const getRes = await fetch_(`/api/projects/${projectId}/file?path=test/myfile.txt`);
      assert.equal(getRes.status, 404);
    });
  });

  describe('Chat and tasks', () => {
    let projectId;

    before(async () => {
      const res = await fetch_('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Chat Test' }),
      });
      const body = await res.json();
      projectId = body.id;
    });

    it('POST /api/projects/:id/tasks creates task', async () => {
      const res = await fetch_(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Test Task', body: 'Do something' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.taskPath);
      assert.ok(body.taskPath.startsWith('tasks/inbox/'));
      assert.ok(body.taskPath.endsWith('.md'));
    });

    it('GET /api/projects/:id/chatlog returns empty for new chat', async () => {
      const res = await fetch_(`/api/projects/${projectId}/chatlog?areaId=a1&chatId=c1`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.entries, []);
    });

    it('DELETE /api/projects/:id/area removes area', async () => {
      const res = await fetch_(`/api/projects/${projectId}/area`, {
        method: 'DELETE',
        body: JSON.stringify({ areaId: 'a3' }),
      });
      assert.equal(res.status, 200);

      const areasRes = await fetch_(`/api/projects/${projectId}/areas`);
      const body = await areasRes.json();
      assert.equal(body.areas.length, 2);
    });

    it('DELETE /api/projects/:id/chat removes chat', async () => {
      const res = await fetch_(`/api/projects/${projectId}/chat`, {
        method: 'DELETE',
        body: JSON.stringify({ areaId: 'a1', chatId: 'c1' }),
      });
      assert.equal(res.status, 200);

      const areasRes = await fetch_(`/api/projects/${projectId}/areas`);
      const body = await areasRes.json();
      const a1 = body.areas.find(a => a.id === 'a1');
      assert.equal(a1.chats.length, 0);
    });
  });

  describe('Security endpoints', () => {
    it('POST /api/setup rejects short API key', async () => {
      const res = await fetch_('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'short' }),
      });
      assert.ok(res.status === 400 || res.status === 500);
    });

    it('POST /api/setup accepts valid config', async () => {
      const res = await fetch_('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'sk-valid-key-here-at-least-10-chars', provider: 'openrouter' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.configured, true);
    });
  });
});
