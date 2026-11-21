import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Module-level state to restore after tests
const STORAGE_ROOT_ENV = 'TEST_STORAGE_ROOT';

let tmpDir;

describe('storage.js', async () => {
  let storage;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-test-'));
    process.env.STORAGE_ROOT = tmpDir;
    storage = await import('../src/storage.js');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getStorageRoot()', () => {
    it('returns the STORAGE_ROOT from env', () => {
      assert.equal(storage.getStorageRoot(), tmpDir);
    });
  });

  describe('projectRoot()', () => {
    it('throws without projectId', () => {
      assert.throws(() => storage.projectRoot({}), /projectId required/);
    });

    it('constructs path with userId and projectId', () => {
      const root = storage.projectRoot({ userId: 'testuser', projectId: 'proj123' });
      assert.match(root, /testuser.*projects.*proj123$/);
    });

    it('uses default userId when not provided', () => {
      const root = storage.projectRoot({ projectId: 'proj456' });
      assert.match(root, /default.*projects.*proj456$/);
    });
  });

  describe('safeJoin()', () => {
    const root = '/base/path';

    it('resolves simple relative paths', () => {
      assert.equal(storage.safeJoin(root, 'foo/bar'), '/base/path/foo/bar');
    });

    it('resolves empty relPath to root', () => {
      assert.equal(storage.safeJoin(root, ''), root);
    });

    it('prevents path traversal', () => {
      assert.throws(
        () => storage.safeJoin(root, '../../../etc/passwd'),
        /Invalid path/
      );
    });

    it('prevents absolute paths that escape', () => {
      assert.throws(
        () => storage.safeJoin(root, '/etc/passwd'),
        /Invalid path/
      );
    });
  });

  describe('ensureProjectScaffold()', () => {
    let projRoot;

    before(async () => {
      projRoot = path.join(tmpDir, 'users', 'default', 'projects', 'test-scaffold');
      await storage.ensureProjectScaffold(projRoot);
    });

    it('creates info directory', async () => {
      const stat = await fs.stat(path.join(projRoot, 'info'));
      assert.ok(stat.isDirectory());
    });

    it('creates chat/areas directory', async () => {
      const stat = await fs.stat(path.join(projRoot, 'chat', 'areas'));
      assert.ok(stat.isDirectory());
    });

    it('creates tasks directories', async () => {
      const inbox = await fs.stat(path.join(projRoot, 'tasks', 'inbox'));
      assert.ok(inbox.isDirectory());
      const history = await fs.stat(path.join(projRoot, 'tasks', 'history'));
      assert.ok(history.isDirectory());
    });

    it('la plantilla de reglas no impone límites artificiales y se reconoce como plantilla', async () => {
      const content = await fs.readFile(path.join(projRoot, 'rules.md'), 'utf8');
      assert.ok(!content.includes('10 filas'));
      assert.ok(content.includes('**Instrucciones:**'));
    });

    it('creates default rules.md', async () => {
      const content = await fs.readFile(path.join(projRoot, 'rules.md'), 'utf8');
      assert.ok(content.includes('Reglas globales'));
    });

    it('creates default areas.json with 3 areas', async () => {
      const raw = await fs.readFile(path.join(projRoot, 'info', 'areas.json'), 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.areas.length, 3);
      assert.equal(parsed.activeAreaId, 'a1');
      assert.equal(parsed.areas[0].name, 'Area #1');
    });

    it('creates AI layer files', async () => {
      const layer1 = await fs.readFile(path.join(projRoot, 'ai', 'layer1', '00-role-and-flow.md'), 'utf8');
      assert.ok(layer1.includes('Capa 1'));
      const summary = await fs.readFile(path.join(projRoot, 'ai', 'layer2', 'summary.md'), 'utf8');
      assert.ok(summary.includes('Capa 2'));
      const qa = await fs.readFile(path.join(projRoot, 'ai', 'layer3', 'qa.md'), 'utf8');
      assert.ok(qa.includes('Capa 3'));
    });

    it('creates per-area summaries and rules', async () => {
      for (const areaId of ['a1', 'a2', 'a3']) {
        const summary = await fs.readFile(
          path.join(projRoot, 'ai', 'layer2', 'areas', areaId, storage.AREA_SUMMARY_FILE),
          'utf8'
        );
        assert.ok(summary.includes('Capa 2'));
        assert.ok(summary.includes('Resumen del área'));
        const rules = await fs.readFile(
          path.join(projRoot, 'ai', 'layer2', 'areas', areaId, storage.AREA_RULES_FILE),
          'utf8'
        );
        assert.ok(rules.includes('Reglas del área'));
      }
    });

    it('is idempotent (does not throw on second call)', async () => {
      await assert.doesNotReject(() => storage.ensureProjectScaffold(projRoot));
    });
  });

  describe('writeTextFile / readTextFile', () => {
    let projRoot;

    before(async () => {
      projRoot = path.join(tmpDir, 'users', 'default', 'projects', 'test-files');
      await storage.ensureProjectScaffold(projRoot);
    });

    it('writes and reads a text file', async () => {
      await storage.writeTextFile(projRoot, 'test/hello.txt', 'Hello World');
      const content = await storage.readTextFile(projRoot, 'test/hello.txt');
      assert.equal(content, 'Hello World');
    });

    it('creates intermediate directories when writing', async () => {
      await storage.writeTextFile(projRoot, 'a/b/c/deep.txt', 'deep');
      const exists = await fs.stat(path.join(projRoot, 'a', 'b', 'c', 'deep.txt'));
      assert.ok(exists.isFile());
    });

    it('prevents reading outside root', async () => {
      await assert.rejects(
        () => storage.readTextFile(projRoot, '../../../etc/passwd'),
        /Invalid path/
      );
    });

    it('prevents writing outside root', async () => {
      await assert.rejects(
        () => storage.writeTextFile(projRoot, '../../../tmp/escape.txt', 'bad'),
        /Invalid path/
      );
    });
  });

  describe('listDir', () => {
    let projRoot;

    before(async () => {
      projRoot = path.join(tmpDir, 'users', 'default', 'projects', 'test-list');
      await storage.ensureProjectScaffold(projRoot);
    });

    it('lists root directory entries', async () => {
      const entries = await storage.listDir(projRoot);
      assert.ok(entries.length > 0);
      const names = entries.map(e => e.name);
      assert.ok(names.includes('info'));
      assert.ok(names.includes('chat'));
      assert.ok(names.includes('rules.md'));
    });

    it('returns dirs before files', async () => {
      const entries = await storage.listDir(projRoot);
      let sawFile = false;
      for (const e of entries) {
        if (e.type === 'file') sawFile = true;
        else if (e.type === 'dir') assert.ok(!sawFile, 'dir after file');
      }
    });
  });

  describe('deletePath', () => {
    let projRoot;

    before(async () => {
      projRoot = path.join(tmpDir, 'users', 'default', 'projects', 'test-delete');
      await storage.ensureProjectScaffold(projRoot);
      await storage.writeTextFile(projRoot, 'delete-me.txt', 'bye');
    });

    it('deletes a file', async () => {
      await storage.deletePath(projRoot, 'delete-me.txt');
      await assert.rejects(
        () => fs.stat(path.join(projRoot, 'delete-me.txt')),
        /ENOENT/
      );
    });

    it('deletes a directory recursively', async () => {
      await storage.writeTextFile(projRoot, 'dir-to-delete/sub/file.txt', 'nested');
      await storage.deletePath(projRoot, 'dir-to-delete');
      await assert.rejects(
        () => fs.stat(path.join(projRoot, 'dir-to-delete')),
        /ENOENT/
      );
    });

    it('throws on traversal attempt', async () => {
      await assert.rejects(
        () => storage.deletePath(projRoot, '../../../etc'),
        /Invalid path/
      );
    });
  });

  describe('movePath', () => {
    let projRoot;

    before(async () => {
      projRoot = path.join(tmpDir, 'users', 'default', 'projects', 'test-move');
      await storage.ensureProjectScaffold(projRoot);
      await storage.writeTextFile(projRoot, 'source.txt', 'moveme');
    });

    it('moves a file from source to destination', async () => {
      await storage.movePath(projRoot, 'source.txt', 'dest.txt');
      const content = await storage.readTextFile(projRoot, 'dest.txt');
      assert.equal(content, 'moveme');
      await assert.rejects(
        () => fs.stat(path.join(projRoot, 'source.txt')),
        /ENOENT/
      );
    });

    it('creates parent directories on move', async () => {
      await storage.writeTextFile(projRoot, 'move2.txt', 'hello');
      await storage.movePath(projRoot, 'move2.txt', 'nested/deep/moved.txt');
      const content = await storage.readTextFile(projRoot, 'nested/deep/moved.txt');
      assert.equal(content, 'hello');
    });
  });
});
