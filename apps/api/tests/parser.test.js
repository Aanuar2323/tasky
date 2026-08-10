import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredResponse, normalizeFileGenerated } from '../src/index.js';

describe('parseStructuredResponse (parser defensivo)', () => {

  describe('1. JSON válido directo', () => {
    it('parsea JSON válido simple', () => {
      const raw = JSON.stringify({
        content: 'Hola mundo',
        meta: { complete: true, taskPath: null, summary: 'saludo' },
        fileGenerated: { type: 'docx', filename: 't.docx', data: { title: 'X' } },
      });
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, 'Hola mundo');
      assert.equal(r.meta.complete, true);
      assert.equal(r.fileGenerated.type, 'docx');
      assert.equal(r.fileGenerated.data.title, 'X');
      assert.deepEqual(r.parseWarnings, []);
    });

    it('acepta JSON sin fileGenerated', () => {
      const raw = JSON.stringify({ content: 'solo texto', meta: { complete: true } });
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.fileGenerated, null);
      assert.equal(r.content, 'solo texto');
    });

    it('empty_response en string vacío', () => {
      const r = parseStructuredResponse('');
      assert.equal(r.parseError, 'empty_response');
      assert.equal(r.content, '');
      assert.equal(r.fileGenerated, null);
    });

    it('empty_response en whitespace only', () => {
      const r = parseStructuredResponse('   \n  ');
      assert.equal(r.parseError, 'empty_response');
    });
  });

  describe('2. JSON fenced en ```json```', () => {
    it('recupera JSON dentro de fences ```json', () => {
      const raw = '```json\n' + JSON.stringify({
        content: 'dentro de fence',
        meta: { complete: false },
        fileGenerated: { type: 'xlsx', filename: 'x.xlsx', data: {} },
      }) + '\n```';
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, 'dentro de fence');
      assert.equal(r.fileGenerated.type, 'xlsx');
      assert.ok(r.parseWarnings.some(w => w.startsWith('step2_')));
    });

    it('recupera JSON dentro de fences simples ```', () => {
      const raw = '```\n' + JSON.stringify({ content: 'en fence', meta: { complete: true } }) + '\n```';
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, 'en fence');
    });
  });

  describe('3. JSON con texto antes/después (balanced extraction)', () => {
    it('ignora texto antes del JSON', () => {
      const json = JSON.stringify({ content: 'texto real', meta: { complete: true }, fileGenerated: { type: 'docx', filename: 't.docx', data: { sections: [] } } });
      const raw = 'Locura preambulo del modelo\n' + json;
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, 'texto real');
      assert.equal(r.fileGenerated.type, 'docx');
      assert.ok(r.parseWarnings.some(w => w.startsWith('step3_')));
    });

    it('ignora texto después del JSON', () => {
      const json = JSON.stringify({ content: 'texto real', meta: { complete: true }, fileGenerated: { type: 'docx', filename: 't.docx', data: { sections: [] } } });
      const raw = json + '\n📎 El archivo se descarga\n---\nNota extra';
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, 'texto real');
      assert.equal(r.fileGenerated.type, 'docx');
    });

    it('recupera JSON con emojis en content sin romper', () => {
      const raw = JSON.stringify({ content: '📎 Archivo listo', meta: { complete: true }, fileGenerated: { type: 'pptx', filename: 'p.pptx', data: { slides: [] } } });
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, '📎 Archivo listo');
      assert.equal(r.fileGenerated.type, 'pptx');
    });
  });

  describe('4. JSON con tokens corruptos (MiniMax-like)', () => {
    it('elimina tokens tipo <]brand[> antes de parsear', () => {
      const real = `{"content":"hola","meta":{"complete":true},"fileGenerated":{"type":"docx","filename":"t.docx","data":{"sections":[]}}}]brand[>`;
      const r = parseStructuredResponse(real);
      assert.ok(r.fileGenerated !== null || r.fileGenerated === null);
      if (r.parseError) {
        assert.ok(r.parseWarnings.length > 0);
      } else {
        assert.equal(r.content, 'hola');
        assert.equal(r.fileGenerated.type, 'docx');
      }
    });

    it('elimina chars de control no imprimibles', () => {
      const obj = { content: 'hola', meta: { complete: true }, fileGenerated: { type: 'docx', filename: 't.docx', data: {} } };
      const raw = JSON.stringify(obj) + '\x01\x02\x03';
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.equal(r.content, 'hola');
    });

    it('recupera fileGenerated best-effort de snippet JSON corrupto', () => {
      const raw = '{"content":"x","meta":{"complete":true},"fileGenerated":{"type":"docx","filename":"t.docx","data":{"title":"X"}}}';
      const r = parseStructuredResponse(raw);
      assert.ok(r.fileGenerated !== null);
      assert.equal(r.fileGenerated.type, 'docx');
    });
  });

  describe('5. Input 100% markdown sin JSON', () => {
    it('contenido markdown queda como content, fileGenerated null', () => {
      const raw = '## Hola\n\n- punto 1\n- punto 2\nEsto es solo markdown.';
      const r = parseStructuredResponse(raw);
      assert.ok(r.fileGenerated === null || r.fileGenerated === undefined);
      assert.equal(r.content, raw);
      assert.equal(r.parseError, 'legacy_fallback');
    });
  });

  describe('6. JSON con data string (algunos modelos la serializan así)', () => {
    it('fase C parsea data string a objeto', () => {
      const dataObj = { filename: 'x.docx', title: 'Y' };
      const raw = JSON.stringify({
        content: ' listo',
        meta: { complete: true },
        fileGenerated: { type: 'docx', filename: 'x.docx', data: JSON.stringify(dataObj) },
      });
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.ok(typeof r.fileGenerated.data === 'string');
      const { fg, fixes } = normalizeFileGenerated(r.fileGenerated);
      assert.ok(typeof fg.data === 'object');
      assert.equal(fg.data.title, 'Y');
      assert.ok(fixes.includes('data_string_parsed_to_object'));
    });
  });
});

describe('normalizeFileGenerated', () => {
  it('retorna null si fg no es objeto', () => {
    const { fg, fixes } = normalizeFileGenerated(null);
    assert.equal(fg, null);
    assert.deepEqual(fixes, []);
  });

  it('infiere type por extensión de filename', () => {
    const { fg, fixes } = normalizeFileGenerated({ filename: 't.xlsx', data: {} });
    assert.equal(fg.type, 'xlsx');
    assert.ok(fixes.some(f => f.startsWith('type_inferred')));
  });

  it('infiere type por extensión de editPath', () => {
    const { fg, fixes } = normalizeFileGenerated({ editPath: 'files/generated/t.pptx', editChanges: {} });
    assert.equal(fg.type, 'pptx');
    assert.ok(fixes.some(f => f.startsWith('type_inferred')));
  });

  it('genera nanoid filename si falta', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', data: { sections: [] } });
    assert.match(fg.filename, /^docx-.{8}\.docx$/);
    assert.ok(fixes.includes('filename_generated'));
  });

  it('appenda extensión si filename no la tiene', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'xlsx', filename: 'sinext', data: {} });
    assert.equal(fg.filename, 'sinext.xlsx');
    assert.ok(fixes.includes('filename_extension_appended'));
  });

  it('no toca filename con extensión correcta', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: { sections: [] } });
    assert.equal(fg.filename, 't.docx');
    assert.ok(!fixes.includes('filename_extension_appended'));
    assert.ok(!fixes.includes('filename_generated'));
  });

  it('no aplica fixes si todo está OK', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: { sections: [] } });
    assert.equal(fg.type, 'docx');
    assert.equal(fg.filename, 't.docx');
    assert.equal(fixes.length, 0);
  });

  it('preserva editPath y editChanges', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 'out.docx', editPath: 'files/generated/in.docx', editChanges: { replace: [{ find: 'a', replace: 'b' }] } });
    assert.equal(fg.editPath, 'files/generated/in.docx');
    assert.deepEqual(fg.editChanges.replace[0], { find: 'a', replace: 'b' });
  });
});
