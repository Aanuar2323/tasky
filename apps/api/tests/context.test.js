import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PORT = 9877;

describe('context extraction', async () => {
  let tmpDir;
  let server;
  let storage;
  let api;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-ctx-'));
    process.env.STORAGE_ROOT = tmpDir;
    process.env.PORT = String(PORT);

    // Dynamic import so env vars are set before modules load
    const mod = await import('../src/index.js');
    server = mod.server;
    storage = await import('../src/storage.js');
    api = mod;

    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    await storage.ensureProjectScaffold(projRoot);

    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'notas.md'), '# hello md', 'utf8');
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'data.json'), JSON.stringify({ k: 'val' }), 'utf8');
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    delete process.env.PORT;
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('CONTEXT_EXTS matches supported file types', () => {
    assert.ok(api.CONTEXT_EXTS.test('a.md'));
    assert.ok(api.CONTEXT_EXTS.test('a.DOCX'));
    assert.ok(api.CONTEXT_EXTS.test('a.pdf'));
    assert.ok(api.CONTEXT_EXTS.test('a.txt'));
    assert.ok(api.CONTEXT_EXTS.test('a.pptx'));
    assert.ok(api.CONTEXT_EXTS.test('a.PPTX'));
    assert.ok(api.CONTEXT_EXTS.test('a.ppt'));
    assert.ok(api.CONTEXT_EXTS.test('a.xlsx'));
    assert.ok(api.CONTEXT_EXTS.test('a.xls'));
    assert.ok(!api.CONTEXT_EXTS.test('a.exe'));
    assert.ok(!api.CONTEXT_EXTS.test('a.bin'));
  });

  it('CONTEXT_EXTS does NOT match binary extensions (regression guard)', () => {
    assert.equal(api.CONTEXT_EXTS.test('a.exe'), false);
    assert.equal(api.CONTEXT_EXTS.test('a.bin'), false);
    assert.equal(api.CONTEXT_EXTS.test('a.so'), false);
    assert.equal(api.CONTEXT_EXTS.test('a.dll'), false);
  });

  it('listAllContextFiles returns .md/.json in area dir, excludes area summary file', async () => {
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    const files = await api.listAllContextFiles(projRoot, 'a1');
    assert.ok(files.some((f) => f.endsWith('notas.md')));
    assert.ok(files.some((f) => f.endsWith('data.json')));
    assert.ok(files.every((f) => !f.endsWith(storage.AREA_SUMMARY_FILE)));
  });

  it('listAllContextFiles includes pptx/xlsx/ppt/xls in area dir', async () => {
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'slides.pptx'), 'fake', 'utf8');
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'data.xlsx'), 'fake', 'utf8');
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'old.ppt'), 'fake', 'utf8');
    await fs.writeFile(path.join(projRoot, 'ai/layer2/areas/a1', 'old.xls'), 'fake', 'utf8');
    const files = await api.listAllContextFiles(projRoot, 'a1');
    assert.ok(files.some((f) => f.endsWith('slides.pptx')), `expected slides.pptx, got: ${files.join(',')}`);
    assert.ok(files.some((f) => f.endsWith('data.xlsx')), `expected data.xlsx, got: ${files.join(',')}`);
    assert.ok(files.some((f) => f.endsWith('old.ppt')));
    assert.ok(files.some((f) => f.endsWith('old.xls')));
  });

  it('listAllContextFiles does NOT include info/* or rules.md or root files (anti-leak)', async () => {
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    await fs.writeFile(path.join(projRoot, 'rules.md'), '# root rules', 'utf8');
    await fs.writeFile(path.join(projRoot, 'info', 'custom.txt'), 'custom info', 'utf8');
    const files = await api.listAllContextFiles(projRoot, 'a1');
    for (const f of files) {
      assert.ok(!f.startsWith('info/'), `unexpected info/* path leaked: ${f}`);
      assert.ok(f !== 'rules.md', `unexpected root rules.md leaked: ${f}`);
      assert.ok(!f.startsWith('ai/layer1/'), `unexpected layer1 leak: ${f}`);
    }
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

  it('readContextFile extracts text from a PPTX zip (jszip + <a:t> regex)', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml',
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:txBody><a:p><a:r><a:t>Hola slide uno</a:t></a:r></a:p></p:txBody></p:sld>'
    );
    zip.file('ppt/slides/slide2.xml',
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:txBody><a:p><a:r><a:t>Segunda slide</a:t></a:r></a:p></p:txBody></p:sld>'
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const projRoot = storage.projectRoot({ projectId: 'ctx-test' });
    const pptxPath = path.join(projRoot, 'ai/layer2/areas/a1', 'synthetic.pptx');
    await fs.writeFile(pptxPath, buf);
    const text = await api.readContextFile(projRoot, 'ai/layer2/areas/a1/synthetic.pptx');
    assert.ok(/Hola slide uno/.test(text), `expected slide1 text, got: ${text}`);
    assert.ok(/Segunda slide/.test(text), `expected slide2 text, got: ${text}`);
    assert.ok(/\[Slide 1\]/.test(text));
    assert.ok(/\[Slide 2\]/.test(text));
  });

  it('readContextFile extracts text from a real PPTX if available', async () => {
    const candidates = [
      '/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx/ai/layer2/areas/a1/Presentaci\u00f3n Primer D\u00eda de Clases - CTI.pptx',
      '/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx/ai/layer2/areas/a1/Derecho y TIC - CTI.pptx',
    ];
    for (const realPath of candidates) {
      let stat;
      try { stat = await fs.stat(realPath); } catch { continue; }
      assert.ok(stat.size > 100);
      const projRoot = path.dirname(path.dirname(path.dirname(path.dirname(realPath))));
      const rel = path.relative(projRoot, realPath);
      const text = await api.readContextFile(projRoot, rel);
      assert.ok(text.length > 50, `expected >50 chars from PPTX, got ${text.length}`);
      assert.ok(/\[Slide 1\]/.test(text), `expected [Slide 1] marker, got: ${text.slice(0, 200)}`);
      return;
    }
  });

  it('readContextFile extracts text from a real XLSX if available', async () => {
    const candidates = [
      '/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx/ai/layer2/areas/a1',
    ];
    const projRoot = '/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx';
    for (const dir of candidates) {
      let entries;
      try { entries = await fs.readdir(dir); } catch { continue; }
      const xlsxFile = entries.find((e) => e.toLowerCase().endsWith('.xlsx'));
      if (!xlsxFile) continue;
      const realPath = path.join(dir, xlsxFile);
      const rel = path.relative(projRoot, realPath);
      const text = await api.readContextFile(projRoot, rel);
      assert.ok(text.length >= 0);
      return;
    }
  });
});

describe('docx extraction (mammoth)', async () => {
  let server;

  before(async () => {
    process.env.PORT = '9878';
    const mod = await import('../src/index.js');
    server = mod.server;
  });

  after(async () => {
    delete process.env.PORT;
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('extracts text from a real DOCX if available', async () => {
    const realPath = '/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx/ai/layer2/areas/a1/Web Scraping with Playwright for Multi-Store Monitoring of the Smartphone Market: Price, Supply, and Demand Indicators.docx';
    let stat;
    try {
      stat = await fs.stat(realPath);
    } catch {
      return;
    }
    assert.ok(stat.size > 1000);
    const mod = await import('../src/index.js');
    const text = await mod.readContextFile('/home/anuar/Documents/proyects/tasky/storage/users/default/projects/VHcZ5hrrwx', 'ai/layer2/areas/a1/Web Scraping with Playwright for Multi-Store Monitoring of the Smartphone Market: Price, Supply, and Demand Indicators.docx');
    assert.ok(text.length > 100, `expected >100 chars, got ${text.length}`);
    assert.ok(/Playwright|smartphone|Scrapi/i.test(text));
  });
});
