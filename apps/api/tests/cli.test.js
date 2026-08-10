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
        data: { filename: 'naked' },
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
        data: { filename: 'nested.docx' },
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
  });
});
