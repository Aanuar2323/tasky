import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileBlocks,
  parseTextModeResponse,
  normalizeFileGenerated,
  parseStructuredResponse,
} from '../src/chat/protocol.js';

const XLSX = { type: 'xlsx', filename: 'a.xlsx', data: { sheets: [{ name: 'S', headers: ['A'], rows: [[1]] }] } };

describe('extractFileBlocks', () => {
  it('extrae ```tasky-file``` y lo saca del texto visible', () => {
    const r = extractFileBlocks('Te dejo el archivo.\n```tasky-file\n{"type":"docx","filename":"a.docx","data":{"markdown":"# Hola"}}\n```\nSaludos');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].filename, 'a.docx');
    assert.equal(r.text, 'Te dejo el archivo.\n\nSaludos');
  });

  it('un ```json``` con forma de archivo también cuenta', () => {
    const r = extractFileBlocks(`Acá está:\n\`\`\`json\n${JSON.stringify(XLSX)}\n\`\`\``);
    assert.equal(r.files.length, 1);
    assert.equal(r.text, 'Acá está:');
  });

  it('un ```json``` cualquiera queda en el texto', () => {
    const text = 'Ejemplo:\n```json\n{"a":1}\n```';
    const r = extractFileBlocks(text);
    assert.equal(r.files.length, 0);
    assert.equal(r.text, text);
  });

  it('varios bloques → varios archivos', () => {
    const block = (o) => `\`\`\`tasky-file\n${JSON.stringify(o)}\n\`\`\``;
    const r = extractFileBlocks(`Uno\n${block(XLSX)}\nDos\n${block({ ...XLSX, filename: 'b.xlsx' })}`);
    assert.deepEqual(r.files.map((f) => f.filename), ['a.xlsx', 'b.xlsx']);
    assert.equal(r.text, 'Uno\n\nDos');
  });

  it('bloque inválido o cortado no se muestra y deja aviso', () => {
    const bad = extractFileBlocks('Hola\n```tasky-file\n{"type":"docx",\n```');
    assert.equal(bad.files.length, 0);
    assert.equal(bad.text, 'Hola');
    assert.ok(bad.warnings.includes('file_block_unparseable'));
    const cut = extractFileBlocks('Hola\n```tasky-file\n{"type":"docx","data":{"markdown":"x"');
    assert.equal(cut.text, 'Hola');
    assert.ok(cut.warnings.includes('file_block_truncated'));
  });
});

describe('parseTextModeResponse', () => {
  it('markdown + bloque', () => {
    const r = parseTextModeResponse(`Listo.\n\`\`\`tasky-file\n${JSON.stringify(XLSX)}\n\`\`\``);
    assert.equal(r.content, 'Listo.');
    assert.equal(r.files.length, 1);
  });

  it('wrapper legacy {content, fileGenerated}', () => {
    const r = parseTextModeResponse(JSON.stringify({ content: 'Hecho', meta: { complete: true }, fileGenerated: XLSX }));
    assert.equal(r.content, 'Hecho');
    assert.equal(r.files[0].filename, 'a.xlsx');
  });

  it('JSON suelto de archivo', () => {
    const r = parseTextModeResponse(JSON.stringify(XLSX));
    assert.equal(r.content, '');
    assert.equal(r.files.length, 1);
  });

  it('texto plano sin archivos', () => {
    const r = parseTextModeResponse('## Hola\n\n- a\n- b');
    assert.equal(r.content, '## Hola\n\n- a\n- b');
    assert.equal(r.files.length, 0);
  });
});

describe('normalizeFileGenerated (mejoras)', () => {
  it('secciones en la raíz se mueven a data', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 'a.docx', title: 'T', sections: [{ type: 'paragraph', text: 'x' }] });
    assert.equal(fg.data.sections.length, 1);
    assert.equal(fg.data.title, 'T');
    assert.ok(fixes.includes('data_hoisted_from_top_level'));
  });

  it('contenido bajo schema/document se usa como data', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'pptx', filename: 'p.pptx', schema: { slides: [{ layout: 'title', title: 'x' }] } });
    assert.equal(fg.data.slides.length, 1);
    assert.ok(fixes.includes('data_from_schema'));
  });

  it('data doblemente envuelta se desenvuelve', () => {
    const { fg, fixes } = normalizeFileGenerated({ type: 'xlsx', filename: 'a.xlsx', data: { data: { sheets: [{ name: 'S', rows: [[1]] }] } } });
    assert.equal(fg.data.sheets.length, 1);
    assert.ok(fixes.includes('data_unwrapped'));
  });

  it('docx con solo markdown es válido', () => {
    assert.ok(normalizeFileGenerated({ type: 'docx', filename: 'a.docx', data: { markdown: '# x' } }).fg);
  });

  it('filename con ruta se reduce al nombre', () => {
    const { fg } = normalizeFileGenerated({ type: 'docx', filename: '../../x.docx', data: { markdown: '# x' } });
    assert.equal(fg.filename, 'x.docx');
  });

  it('parseStructuredResponse sigue disponible desde protocol', () => {
    assert.equal(parseStructuredResponse('{"content":"a"}').content, 'a');
  });
});
