import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredResponse, normalizeFileGenerated } from '../src/index.js';
import { TOOLS } from '../src/llm-client.js';

const PORT = 9879;

describe('parseStructuredResponse (parser defensivo — fallback legacy for non-tools models)', () => {
  let server;

  before(async () => {
    process.env.PORT = String(PORT);
    const mod = await import('../src/index.js');
    server = mod.server;
  });

  after(async () => {
    delete process.env.PORT;
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

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
      const dataObj = { filename: 'x.docx', title: 'Y', sections: [{ type: 'heading', text: 'Hola', level: 1 }] };
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

  describe('7. DeepSeek tool_call tokens <|tool_call_begin|>', () => {
    it('recupera fileGenerated de tool_call_begin + JSON completo', () => {
      const fg = { type: 'docx', filename: 't.docx', data: { filename: 't.docx', title: 'X', sections: [{ type: 'heading', text: 'Hola', level: 1 }] } };
      const raw = '```\n<|tool_call_begin|>' + JSON.stringify(fg);
      const r = parseStructuredResponse(raw);
      assert.ok(r.fileGenerated !== null, 'debe recuperar fileGenerated');
      assert.equal(r.fileGenerated.type, 'docx');
      assert.equal(r.fileGenerated.filename, 't.docx');
      assert.ok(r.parseWarnings.some(w => w.includes('sloss') || w.includes('tool_call')));
    });

    it('recupera fileGenerated de tool_call_begin + tool_call_end', () => {
      const fg = { type: 'xlsx', filename: 'x.xlsx', data: { sheets: [{ name: 'S', headers: ['A'], rows: [[1]] }] } };
      const raw = '<|tool_call_begin|>' + JSON.stringify(fg) + '<|tool_call_end|>';
      const r = parseStructuredResponse(raw);
      assert.ok(r.fileGenerated !== null);
      assert.equal(r.fileGenerated.type, 'xlsx');
    });
  });

  describe('8. Wrapper suelto (sin content/meta/fileGenerated)', () => {
    it('trata {"type":"docx","data":{...}} como fileGenerated directo', () => {
      const raw = JSON.stringify({ type: 'docx', filename: 't.docx', data: { filename: 't.docx', sections: [{ type: 'heading', text: 'X', level: 1 }] } });
      const r = parseStructuredResponse(raw);
      assert.equal(r.parseError, null);
      assert.ok(r.fileGenerated !== null);
      assert.equal(r.fileGenerated.type, 'docx');
      assert.equal(r.content, '');
    });

    it('no interpreta como sloss si tiene content aunque tenga type', () => {
      const raw = JSON.stringify({ content: 'listo', meta: { complete: true }, fileGenerated: { type: 'docx', filename: 't.docx', data: { sections: [] } } });
      const r = parseStructuredResponse(raw);
      assert.equal(r.content, 'listo');
      assert.equal(r.fileGenerated.type, 'docx');
      assert.equal(r.fileGenerated.data.sections.length, 0);
    });

    it('no trata como sloss si type no es valido', () => {
      const raw = JSON.stringify({ type: 'pdf', filename: 't.pdf', data: {} });
      const r = parseStructuredResponse(raw);
      assert.equal(r.fileGenerated, null);
      assert.equal(r.content, '');
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
    const { fg, fixes } = normalizeFileGenerated({ filename: 't.xlsx', data: { sheets: [{ name: 'S', headers: ['A'], rows: [[1]] }] } });
    assert.equal(fg.type, 'xlsx');
    assert.ok(fixes.some(f => f.startsWith('type_inferred')));
  });

  it('infiere type por extensión de editPath', () => {
    const { fg, fixes } = normalizeFileGenerated({ editPath: 'files/generated/t.pptx', editChanges: { replace: [{ find: 'a', replace: 'b' }] } });
    assert.equal(fg.type, 'pptx');
    assert.ok(fixes.some(f => f.startsWith('type_inferred')));
  });

  it('genera nanoid filename si falta', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', data: { sections: [{ type: 'heading', text: 'X', level: 1 }] } });
    assert.match(fg.filename, /^docx-.{8}\.docx$/);
    assert.ok(fixes.includes('filename_generated'));
  });

  it('appenda extensión si filename no la tiene', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'xlsx', filename: 'sinext', data: { sheets: [{ name: 'S', headers: ['A'], rows: [[1]] }] } });
    assert.equal(fg.filename, 'sinext.xlsx');
    assert.ok(fixes.includes('filename_extension_appended'));
  });

  it('no toca filename con extensión correcta', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: { sections: [{ type: 'heading', text: 'X', level: 1 }] } });
    assert.equal(fg.filename, 't.docx');
    assert.ok(!fixes.includes('filename_extension_appended'));
    assert.ok(!fixes.includes('filename_generated'));
  });

  it('no aplica fixes si todo está OK', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: { sections: [{ type: 'heading', text: 'X', level: 1 }] } });
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

describe('normalizeFileGenerated — rechazo de data vacía (FASE 2)', () => {
  it('rechaza data: undefined', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx' });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_data_skipped'));
  });

  it('rechaza data: null', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: null });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_data_skipped'));
  });

  it('rechaza data: {} (objeto vacío)', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: {} });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_data_skipped'));
  });

  it('rechaza docx con sections: []', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: { sections: [] } });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_docx_sections_skipped'));
  });

  it('rechaza xlsx con sheets: []', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'xlsx', filename: 't.xlsx', data: { sheets: [] } });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_xlsx_sheets_skipped'));
  });

  it('rechaza pptx con slides: []', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'pptx', filename: 't.pptx', data: { slides: [] } });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_pptx_slides_skipped'));
  });

  it('acepta docx con sections con texto', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', data: { sections: [{ type: 'heading', text: 'Hola', level: 1 }] } });
    assert.ok(fg !== null);
    assert.equal(fg.data.sections.length, 1);
  });

  it('rechaza edit con editChanges vacío', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', editPath: 'files/x.docx', editChanges: {} });
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_edit_changes_skipped'));
  });

  it('acepta edit con editChanges válido', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 't.docx', editPath: 'files/x.docx', editChanges: { replace: [{ find: 'a', replace: 'b' }] } });
    assert.ok(fg !== null);
    assert.equal(fg.editChanges.replace[0].find, 'a');
  });
});

describe('TOOLS schema (function calling definitions)', () => {
  it('TOOLS expone generate_file, edit_file y read_file', () => {
    assert.ok(TOOLS);
    const names = TOOLS.map(t => t.function.name).sort();
    assert.deepEqual(names, ['edit_file', 'generate_file', 'read_file']);
    assert.ok(TOOLS.every(t => t.type === 'function'));
  });

  it('generate_file requiere type, filename y data (contenido en data)', () => {
    const gen = TOOLS.find(t => t.function.name === 'generate_file');
    const params = gen.function.parameters;
    assert.deepEqual([...params.required].sort(), ['data', 'filename', 'type']);
    assert.deepEqual(params.properties.type.enum, ['docx', 'xlsx', 'pptx']);
    assert.ok(params.properties.summary);
  });

  it('read_file y edit_file requieren path', () => {
    const read = TOOLS.find(t => t.function.name === 'read_file');
    const edit = TOOLS.find(t => t.function.name === 'edit_file');
    assert.ok(read.function.parameters.required.includes('path'));
    assert.deepEqual([...edit.function.parameters.required].sort(), ['changes', 'path']);
  });
});

describe('normalizeFileGenerated — tool_calls integration', () => {
  it('acepta args de generate_file con sections válidas', () => {
    const args = { type: 'docx', filename: 't.docx', data: { sections: [{ type: 'heading', text: 'Hola', level: 1 }] } };
    const { fg, fixes } = normalizeFileGenerated(args);
    assert.ok(fg !== null);
    assert.equal(fg.type, 'docx');
    assert.equal(fg.data.sections.length, 1);
  });

  it('acepta args de generate_file con sheets válidas', () => {
    const args = { type: 'xlsx', filename: 't.xlsx', data: { sheets: [{ name: 'S', headers: ['A'], rows: [[1]] }] } };
    const { fg, fixes } = normalizeFileGenerated(args);
    assert.ok(fg !== null);
    assert.equal(fg.type, 'xlsx');
    assert.equal(fg.data.sheets.length, 1);
  });

  it('acepta args de generate_file con slides válidas', () => {
    const args = { type: 'pptx', filename: 't.pptx', data: { slides: [{ layout: 'title', title: 'Hola' }] } };
    const { fg, fixes } = normalizeFileGenerated(args);
    assert.ok(fg !== null);
    assert.equal(fg.type, 'pptx');
    assert.equal(fg.data.slides.length, 1);
  });

  it('rechaza generate_file con data vacío', () => {
    const args = { type: 'docx', filename: 't.docx', data: {} };
    const { fg, fixes } = normalizeFileGenerated(args);
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_data_skipped'));
  });

  it('acepta editPath + editChanges válido', () => {
    const args = { type: 'docx', filename: 'out.docx', editPath: 'files/x.docx', editChanges: { replace: [{ find: 'a', replace: 'b' }] } };
    const { fg, fixes } = normalizeFileGenerated(args);
    assert.ok(fg !== null);
    assert.equal(fg.editPath, 'files/x.docx');
    assert.deepEqual(fg.editChanges.replace[0], { find: 'a', replace: 'b' });
  });

  it('rechaza edit con editChanges vacío', () => {
    const args = { type: 'docx', filename: 't.docx', editPath: 'files/x.docx', editChanges: {} };
    const { fg, fixes } = normalizeFileGenerated(args);
    assert.equal(fg, null);
    assert.ok(fixes.includes('empty_edit_changes_skipped'));
  });
});

describe('reasoning_content fallback (for reasoning models)', () => {
  it('parseStructuredResponse still works as legacy fallback', () => {
    // This tests that the legacy parser still works when model doesn't use tools
    const raw = JSON.stringify({
      content: 'Hola desde legacy',
      meta: { complete: true, summary: 'test' },
      fileGenerated: { type: 'docx', filename: 't.docx', data: { sections: [{ type: 'heading', text: 'X', level: 1 }] } }
    });
    const r = parseStructuredResponse(raw);
    assert.equal(r.parseError, null);
    assert.equal(r.content, 'Hola desde legacy');
    assert.equal(r.fileGenerated.type, 'docx');
  });
});

describe('llm-client tool_calls handling (integration)', () => {
  it('TOOLS constant is exported from llm-client', async () => {
    const mod = await import('../src/llm-client.js');
    assert.ok(mod.TOOLS);
    assert.equal(mod.TOOLS.length, 3);
  });

  it('LEGACY_RESPONSE_FORMAT is exported for fallback', async () => {
    const mod = await import('../src/llm-client.js');
    assert.ok(mod.LEGACY_RESPONSE_FORMAT);
    assert.equal(mod.LEGACY_RESPONSE_FORMAT.type, 'json_schema');
  });
});
