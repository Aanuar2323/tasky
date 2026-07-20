import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('context extraction', async () => {
  let tmpDir;
  let api;
  let storage;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-ctx-'));
    process.env.STORAGE_ROOT = tmpDir;
    storage = await import('../src/storage.js');
    api = await import('../src/index.js');

    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    await storage.ensureProjectScaffold(projRoot);

    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'notas.md'), '# hello md', 'utf8');
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'data.json'), JSON.stringify({ k: 'val' }), 'utf8');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('CONTEXT_EXTS matches supported file types', () => {
    assert.ok(api.CONTEXT_EXTS.test('a.md'));
    assert.ok(api.CONTEXT_EXTS.test('a.DOCX'));
    assert.ok(api.CONTEXT_EXTS.test('a.pdf'));
    assert.ok(api.CONTEXT_EXTS.test('a.txt'));
    assert.ok(!api.CONTEXT_EXTS.test('a.exe'));
    assert.ok(!api.CONTEXT_EXTS.test('a.bin'));
  });

  it('listAllContextFiles returns .md/.json in area dir, excludes area summary file', async () => {
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    const files = await api.listAllContextFiles(projRoot, 'a1');
    assert.ok(files.some((f) => f.endsWith('notas.md')));
    assert.ok(files.some((f) => f.endsWith('data.json')));
    assert.ok(files.every((f) => !f.endsWith(storage.AREA_SUMMARY_FILE)));
  });

  it('readContextFile reads plain text files', async () => {
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    const md = await api.readContextFile(projRoot, 'ai/layer2/areas/a1/notas.md');
    assert.equal(md, '# hello md');
    const json = await api.readContextFile(projRoot, 'ai/layer2/areas/a1/data.json');
    assert.equal(JSON.parse(json).k, 'val');
  });

  it('readContextFile returns "" for unsupported extensions', async () => {
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'archivo.exe'), 'binary', 'utf8');
    const out = await api.readContextFile(projRoot, 'ai/layer2/areas/a1/archivo.exe');
    assert.equal(out, '');
  });
});

describe('docx extraction (mammoth)', () => {
  it('extracts text from a real DOCX if available', async () => {
    const realPath = '/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx/ai/layer2/areas/a1/Web Scraping with Playwright for Multi-Store Monitoring of the Smartphone Market: Price, Supply, and Demand Indicators.docx';
    let stat;
    try {
      stat = await fs.stat(realPath);
    } catch {
      return;
    }
    assert.ok(stat.size > 1000);
    const api = await import('../src/index.js');
    const text = await api.readContextFile('/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx', 'ai/layer2/areas/a1/Web Scraping with Playwright for Multi-Store Monitoring of the Smartphone Market: Price, Supply, and Demand Indicators.docx');
    assert.ok(text.length > 100, `expected >100 chars, got ${text.length}`);
    assert.ok(/Playwright|smartphone|Scrapi/i.test(text));
  });
});
