import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('docengine.js (CLI wrapper)', async () => {
  let tmpDir;
  let docengine;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-cli-test-'));
    docengine = await import('../src/generators/docengine.js');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('detectFileType', () => {
    it('detects docx by extension', () => {
      assert.equal(docengine.detectFileType('foo.docx'), 'docx');
    });
    it('detects xlsx by extension', () => {
      assert.equal(docengine.detectFileType('bar.xlsx'), 'xlsx');
    });
    it('detects pptx by extension', () => {
      assert.equal(docengine.detectFileType('baz.pptx'), 'pptx');
    });
    it('returns null for unknown extension', () => {
      assert.equal(docengine.detectFileType('foo.txt'), null);
    });
    it('returns null for empty input', () => {
      assert.equal(docengine.detectFileType(''), null);
      assert.equal(docengine.detectFileType(null), null);
    });
  });

  describe('generateFile via CLI', () => {
    it('generates a valid docx file', async () => {
      const result = await docengine.generateFile({
        type: 'docx',
        outputDir: tmpDir,
        data: {
          filename: 'test.docx',
          title: 'Test',
          sections: [
            { type: 'heading', text: 'Hola', level: 1 },
            { type: 'bullets', items: ['a', 'b'] },
          ],
        },
        filename: 'test.docx',
      });
      assert.equal(result.filename, 'test.docx');
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0, 'docx should not be empty');
      // DOCX/XLSX/PPTX son ZIP: magic bytes PK
      const buf = await fs.readFile(result.filePath);
      assert.equal(buf[0], 0x50, 'first byte should be P (PK magic)');
      assert.equal(buf[1], 0x4b, 'second byte should be K');
    });

    it('generates a valid xlsx file', async () => {
      const result = await docengine.generateFile({
        type: 'xlsx',
        outputDir: tmpDir,
        data: {
          filename: 'test.xlsx',
          sheets: [{
            name: 'S',
            headers: ['A', 'B'],
            rows: [['1', 2], ['3', 4]],
          }],
        },
        filename: 'test.xlsx',
      });
      assert.equal(result.filename, 'test.xlsx');
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0);
      const buf = await fs.readFile(result.filePath);
      assert.equal(buf[0], 0x50);
      assert.equal(buf[1], 0x4b);
    });

    it('generates a valid pptx file', async () => {
      const result = await docengine.generateFile({
        type: 'pptx',
        outputDir: tmpDir,
        data: {
          filename: 'test.pptx',
          slides: [
            { layout: 'title', title: 'Inicio' },
            { layout: 'content', title: 'Puntos', bullets: ['a', 'b'] },
          ],
        },
        filename: 'test.pptx',
      });
      assert.equal(result.filename, 'test.pptx');
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0);
      const buf = await fs.readFile(result.filePath);
      assert.equal(buf[0], 0x50);
      assert.equal(buf[1], 0x4b);
    });

    it('appends extension if missing in filename', async () => {
      const result = await docengine.generateFile({
        type: 'docx',
        outputDir: tmpDir,
        data: { filename: 'naked', sections: [{ type: 'heading', text: 'N', level: 1 }] },
        filename: 'naked',
      });
      assert.match(result.filename, /\.docx$/);
    });

    it('generates nanoid filename if missing', async () => {
      const result = await docengine.generateFile({
        type: 'xlsx',
        outputDir: tmpDir,
        data: { sheets: [{ name: 'S', headers: ['A'], rows: [['x']] }] },
      });
      assert.match(result.filename, /^xlsx-.{8}\.xlsx$/);
    });

    it('creates outputDir if it does not exist', async () => {
      const outDir = path.join(tmpDir, 'nested', 'deeper');
      const result = await docengine.generateFile({
        type: 'docx',
        outputDir: outDir,
        data: { filename: 'nested.docx', sections: [{ type: 'heading', text: 'Nested', level: 1 }] },
        filename: 'nested.docx',
      });
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0);
    });

    it('rejects with schema_error kind on bad payload', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'docx',
          outputDir: tmpDir,
          data: { filename: 'bad.docx', sections: [{ type: 'BOGUS_TYPE' }] },
          filename: 'bad.docx',
        }),
        (err) => {
          assert.equal(err.kind, 'schema_error');
          assert.equal(err.exitCode, 4);
          return true;
        }
      );
    });

    it('rejects with docengine_error kind on unsupported format', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'pdf',
          outputDir: tmpDir,
          data: {},
          filename: 'x.pdf',
        }),
        (err) => {
          assert.equal(err.kind, 'docengine_error');
          return true;
        }
      );
    });

    it('rejects with schema_error on docx with sections: [] (empty_payload)', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'docx',
          outputDir: tmpDir,
          data: { filename: 'empty.docx', sections: [] },
          filename: 'empty.docx',
        }),
        (err) => {
          assert.equal(err.kind, 'schema_error');
          assert.equal(err.exitCode, 4);
          return true;
        }
      );
    });

    it('rejects with schema_error on docx with only filename (no sections)', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'docx',
          outputDir: tmpDir,
          data: { filename: 'empty.docx' },
          filename: 'empty.docx',
        }),
        (err) => {
          assert.equal(err.kind, 'schema_error');
          assert.equal(err.exitCode, 4);
          return true;
        }
      );
    });

    it('rejects with schema_error on xlsx with sheets: []', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'xlsx',
          outputDir: tmpDir,
          data: { filename: 'empty.xlsx', sheets: [] },
          filename: 'empty.xlsx',
        }),
        (err) => {
          assert.equal(err.kind, 'schema_error');
          assert.equal(err.exitCode, 4);
          return true;
        }
      );
    });

    it('rejects with schema_error on pptx with slides: []', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'pptx',
          outputDir: tmpDir,
          data: { filename: 'empty.pptx', slides: [] },
          filename: 'empty.pptx',
        }),
        (err) => {
          assert.equal(err.kind, 'schema_error');
          assert.equal(err.exitCode, 4);
          return true;
        }
      );
    });

    it('accepts docx with divider section (no text, still visible content)', async () => {
      const result = await docengine.generateFile({
        type: 'docx',
        outputDir: tmpDir,
        data: { filename: 'divider.docx', sections: [{ type: 'divider' }] },
        filename: 'divider.docx',
      });
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0);
    });
  });

  describe('editFile via CLI', () => {
    it('edits a docx with replace', async () => {
      const gen = await docengine.generateFile({
        type: 'docx',
        outputDir: tmpDir,
        data: {
          filename: 'edit_src.docx',
          sections: [
            { type: 'paragraph', text: 'Texto original aqui.' },
          ],
        },
        filename: 'edit_src.docx',
      });
      const result = await docengine.editFile({
        type: 'docx',
        inputPath: gen.filePath,
        outputDir: tmpDir,
        changes: { replace: [{ find: 'original', replace: 'editado' }] },
        filename: 'edit_out.docx',
      });
      assert.equal(result.filename, 'edit_out.docx');
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0);
    });

    it('edits an xlsx with update_cells', async () => {
      const gen = await docengine.generateFile({
        type: 'xlsx',
        outputDir: tmpDir,
        data: {
          filename: 'edit_x.xlsx',
          sheets: [{ name: 'S', headers: ['A', 'B'], rows: [[1, 2]] }],
        },
        filename: 'edit_x.xlsx',
      });
      const result = await docengine.editFile({
        type: 'xlsx',
        inputPath: gen.filePath,
        outputDir: tmpDir,
        changes: { sheets: [{ name: 'S', update_cells: [{ cell: 'A1', value: 99 }] }] },
        filename: 'edit_x_out.xlsx',
      });
      const stat = await fs.stat(result.filePath);
      assert.ok(stat.size > 0);
    });

    it('rejects if inputPath does not exist', async () => {
      await assert.rejects(
        docengine.editFile({
          type: 'docx',
          inputPath: path.join(tmpDir, 'nope.docx'),
          outputDir: tmpDir,
          changes: {},
          filename: 'nope_out.docx',
        })
      );
    });

    it('never overwrites the source file when editing to the same name', async () => {
      const dir = path.join(tmpDir, 'edit-same');
      const gen = await docengine.generateFile({
        type: 'docx',
        outputDir: dir,
        data: { sections: [{ type: 'paragraph', text: 'Hola cliente' }] },
        filename: 'contrato.docx',
      });
      const result = await docengine.editFile({
        type: 'docx',
        inputPath: gen.filePath,
        outputDir: dir,
        changes: { replace: [{ find: 'cliente', replace: 'ACME' }] },
        filename: 'contrato.docx',
      });
      assert.equal(result.filename, 'contrato-v2.docx');
      assert.ok((await fs.stat(gen.filePath)).size > 0);
    });
  });

  describe('sanitizeFilename', () => {
    it('strips directory components (path traversal)', () => {
      assert.equal(docengine.sanitizeFilename('../../x.docx', 'docx'), 'x.docx');
      assert.equal(docengine.sanitizeFilename('..\\..\\evil.xlsx', 'xlsx'), 'evil.xlsx');
      assert.equal(docengine.sanitizeFilename('/etc/passwd', 'docx'), 'passwd.docx');
    });

    it('replaces reserved characters and control chars', () => {
      assert.equal(docengine.sanitizeFilename('a/b:c?.xlsx', 'xlsx'), 'b_c_.xlsx');
      assert.equal(docengine.sanitizeFilename('in\u0000fo<>|"*.docx', 'docx'), 'in_fo_____.docx');
    });

    it('keeps accents and spaces readable, trims dots', () => {
      assert.equal(docengine.sanitizeFilename('  Informe de Gestión 2026.docx ', 'docx'), 'Informe de Gestión 2026.docx');
      assert.equal(docengine.sanitizeFilename('...oculto.pptx', 'pptx'), 'oculto.pptx');
    });

    it('fixes the extension to match the type', () => {
      assert.equal(docengine.sanitizeFilename('reporte.pdf', 'docx'), 'reporte.pdf.docx');
      assert.equal(docengine.sanitizeFilename('REPORTE.DOCX', 'docx'), 'REPORTE.DOCX');
    });

    it('generates a name when empty or only junk', () => {
      assert.match(docengine.sanitizeFilename('', 'pptx'), /^pptx-.{8}\.pptx$/);
      assert.match(docengine.sanitizeFilename('../..', 'docx'), /^docx-.{8}\.docx$/);
    });

    it('limits length to 120 chars keeping the extension', () => {
      const name = docengine.sanitizeFilename('a'.repeat(300) + '.xlsx', 'xlsx');
      assert.ok(name.length <= 120);
      assert.ok(name.endsWith('.xlsx'));
    });
  });

  describe('versioning, sidecar and fixes', () => {
    const DOCX = { sections: [{ type: 'paragraph', text: 'x' }] };

    it('versions the filename instead of overwriting', async () => {
      const dir = path.join(tmpDir, 'versions');
      const a = await docengine.generateFile({ type: 'docx', outputDir: dir, filename: 'inf.docx', data: DOCX });
      const b = await docengine.generateFile({ type: 'docx', outputDir: dir, filename: 'inf.docx', data: DOCX });
      const c = await docengine.generateFile({ type: 'docx', outputDir: dir, filename: 'inf.docx', data: DOCX });
      assert.deepEqual([a.filename, b.filename, c.filename], ['inf.docx', 'inf-v2.docx', 'inf-v3.docx']);
    });

    it('overwrite: true replaces the existing file', async () => {
      const dir = path.join(tmpDir, 'overwrite');
      await docengine.generateFile({ type: 'docx', outputDir: dir, filename: 'o.docx', data: DOCX });
      const b = await docengine.generateFile({ type: 'docx', outputDir: dir, filename: 'o.docx', data: DOCX, overwrite: true });
      assert.equal(b.filename, 'o.docx');
    });

    it('writes a source sidecar that can be read back', async () => {
      const dir = path.join(tmpDir, 'sidecar');
      const res = await docengine.generateFile({
        type: 'docx', outputDir: dir, filename: 'side.docx', data: DOCX,
        source: { summary: 'Resumen del archivo', areaId: 'a1', chatId: 'c1' },
      });
      const side = await docengine.readSourceSidecar(dir, res.filename);
      assert.equal(side.summary, 'Resumen del archivo');
      assert.equal(side.areaId, 'a1');
      assert.equal(side.type, 'docx');
      assert.deepEqual(side.data, DOCX);
      assert.ok(Date.parse(side.createdAt) > 0);
      assert.equal(await docengine.readSourceSidecar(dir, 'missing.docx'), null);
    });

    it('reports normalization fixes from the engine', async () => {
      const res = await docengine.generateFile({
        type: 'docx', outputDir: path.join(tmpDir, 'fixes'), filename: 'md.docx',
        data: { markdown: '# Hola\n\ntexto' },
      });
      assert.ok(res.fixes.includes('docx_markdown_converted'));
    });

    it('schema errors carry a short human detail', async () => {
      await assert.rejects(
        docengine.generateFile({
          type: 'pptx', outputDir: tmpDir, filename: 'bad.pptx',
          data: { slides: [{ layout: 'chart', title: 'x', chart: { type: 'radar_3d' } }] },
        }),
        (err) => {
          assert.equal(err.kind, 'schema_error');
          assert.match(err.detail, /slides\.0/);
          assert.ok(err.detail.length < 700);
          return true;
        }
      );
    });
  });
});
