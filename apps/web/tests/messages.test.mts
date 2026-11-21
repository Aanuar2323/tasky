import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fromLogEntries, fileKind, formatBytes } from '../app/lib/messages.ts';

describe('fromLogEntries', () => {
  it('normaliza archivos nuevos y legacy, conserva errores y estados', () => {
    const msgs = fromLogEntries([
      { id: 'u1', role: 'user', content: 'hola', ts: 1, attachments: [{ name: 'a.pdf', size: 10, path: 'files/uploads/a1/c1/a.pdf' }] },
      { id: 'x1', role: 'assistant', content: 'listo', ts: 2, files: [{ name: 'a.docx', url: 'files/generated/a.docx', type: 'docx', summary: 'Informe', size: 2048 }], file: { name: 'a.docx', url: 'files/generated/a.docx', type: 'docx' } },
      { role: 'assistant', content: 'viejo', ts: 3, file: { name: 'b.xlsx', url: 'files/generated/b.xlsx', type: 'xlsx', meta: 'XLSX' } },
      { role: 'system', type: 'file_generated', ts: 4, content: 'Archivo generado: c.pptx', file: { path: 'files/generated/c.pptx', filename: 'c.pptx', type: 'pptx' } },
      { role: 'assistant', content: '', ts: 5, error: { title: 'API key inválida', hint: 'x', codes: [401], retriable: false } },
      { id: 'x2', role: 'assistant', content: 'parcial', ts: 6, stopped: true },
    ]);
    assert.equal(msgs.length, 6);
    assert.equal(msgs[0].attachments?.[0].name, 'a.pdf');
    assert.equal(msgs[1].files?.length, 1);
    assert.equal(msgs[1].files?.[0].summary, 'Informe');
    assert.deepEqual(msgs[2].files?.[0], { name: 'b.xlsx', url: 'files/generated/b.xlsx', type: 'xlsx', summary: null, size: undefined });
    assert.equal(msgs[3].role, 'assistant');
    assert.equal(msgs[3].content, '');
    assert.equal(msgs[3].files?.[0].url, 'files/generated/c.pptx');
    assert.equal(msgs[4].error?.title, 'API key inválida');
    assert.equal(msgs[5].stopped, true);
    assert.equal(new Set(msgs.map((m) => m.id)).size, 6);
  });

  it('ignora entradas sin rol válido', () => {
    assert.equal(fromLogEntries([{ role: 'tool', content: 'x' }, { content: 'y' }]).length, 0);
  });
});

describe('fileKind y formatBytes', () => {
  it('clasifica por extensión o mime', () => {
    assert.equal(fileKind('informe.DOCX'), 'docx');
    assert.equal(fileKind('datos.xlsx'), 'xlsx');
    assert.equal(fileKind('deck.pptx'), 'pptx');
    assert.equal(fileKind('scan.pdf'), 'pdf');
    assert.equal(fileKind('foto.png'), 'image');
    assert.equal(fileKind('image/jpeg'), 'image');
    assert.equal(fileKind('notas.md'), 'text');
    assert.equal(fileKind('bin.exe'), 'other');
  });

  it('formatea tamaños en español', () => {
    assert.equal(formatBytes(undefined), '');
    assert.equal(formatBytes(512), '1 KB');
    assert.equal(formatBytes(1536), '2 KB');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1,5 MB');
  });
});
