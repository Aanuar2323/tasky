import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('tools.js', async () => {
  let tmpDir;
  let tools;
  let storage;
  let projRoot;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-tools-test-'));
    process.env.STORAGE_ROOT = tmpDir;

    storage = await import('../src/storage.js');
    tools = await import('../src/tools.js');

    projRoot = storage.projectRoot({ projectId: 'test-tools' });
    await storage.ensureProjectScaffold(projRoot);
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('executeTool', () => {
    it('read_file reads existing file', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'rules.md' }) },
      });
      assert.ok(result.includes('Reglas globales'));
    });

    it('read_file throws on non-existent file', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'nonexistent.md' }) },
      });
      assert.ok(result.error || result.includes('ENOENT'));
    });

    it('read_file rejects traversal', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'read_file', arguments: JSON.stringify({ path: '../../../etc/passwd' }) },
      });
      assert.ok(result.error || result.includes('Invalid path'));
    });

    it('list_directory lists root', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'list_directory', arguments: JSON.stringify({ path: '' }) },
      });
      assert.ok(result.includes('[DIR]'));
      assert.ok(result.includes('[FILE]'));
      assert.ok(result.includes('info'));
    });

    it('list_directory lists nested dir', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'list_directory', arguments: JSON.stringify({ path: 'info' }) },
      });
      assert.ok(result.includes('areas.json'));
    });

    it('write_file creates file', async () => {
      const msg = await tools.executeTool(projRoot, {
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'test-new.txt', content: 'created by tool' }) },
      });
      assert.ok(msg.includes('guardado'));
      const content = await storage.readTextFile(projRoot, 'test-new.txt');
      assert.equal(content, 'created by tool');
    });

    it('write_file rejects traversal', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'write_file', arguments: JSON.stringify({ path: '../../../escaped.txt', content: 'bad' }) },
      });
      assert.ok(result.error || result.includes('Invalid path'));
    });

    it('returns error for unknown tool', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'unknown_tool', arguments: '{}' },
      });
      assert.ok(result.error.includes('not found'));
    });

    it('returns error on invalid JSON arguments', async () => {
      const result = await tools.executeTool(projRoot, {
        function: { name: 'read_file', arguments: 'not-json' },
      });
      assert.ok(result.error.includes('Invalid JSON'));
    });
  });

  describe('toolsSchema', () => {
    it('exports an array of tool definitions', () => {
      assert.ok(Array.isArray(tools.toolsSchema));
      assert.ok(tools.toolsSchema.length > 0);
    });

    it('each tool has type "function"', () => {
      for (const t of tools.toolsSchema) {
        assert.equal(t.type, 'function');
        assert.ok(t.function.name);
        assert.ok(t.function.description);
        assert.ok(t.function.parameters);
      }
    });

    it('contains read_file, list_directory, write_file', () => {
      const names = tools.toolsSchema.map(t => t.function.name);
      assert.ok(names.includes('read_file'));
      assert.ok(names.includes('list_directory'));
      assert.ok(names.includes('write_file'));
    });
  });
});
