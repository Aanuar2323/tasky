import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  readChatLog,
  appendChatEntry,
  truncateAfterLastUser,
  entriesToMessages,
  fitHistory,
  loadSummary,
  saveSummary,
} from '../src/context/history.js';

describe('context/history', () => {
  let root;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-history-'));
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('entriesToMessages agrega notas de archivos y omite errores/vacíos', () => {
    const msgs = entriesToMessages([
      { role: 'user', content: 'hacé un word', ts: 1, attachments: [{ name: 'base.pdf' }] },
      { role: 'assistant', content: 'Listo', ts: 2, file: { name: 'a.docx', url: 'files/generated/a.docx', type: 'docx' } },
      { role: 'assistant', content: '', ts: 3, error: { title: 'x' } },
      { role: 'system', type: 'file_generated', ts: 4, file: { path: 'files/generated/b.xlsx', filename: 'b.xlsx', type: 'xlsx' } },
    ]);
    assert.equal(msgs.length, 3);
    assert.match(msgs[0].content, /hacé un word/);
    assert.match(msgs[0].content, /\[Adjuntos: base\.pdf\]/);
    assert.match(msgs[1].content, /^Listo\n\n\[Archivo generado: a\.docx \(docx\) — files\/generated\/a\.docx\]$/);
    assert.equal(msgs[2].role, 'assistant');
    assert.match(msgs[2].content, /\[Archivo generado: b\.xlsx \(xlsx\) — files\/generated\/b\.xlsx\]/);
  });

  it('entriesToMessages conserva respuestas parciales detenidas', () => {
    const msgs = entriesToMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'mitad', stopped: true }]);
    assert.equal(msgs[1].content, 'mitad');
  });

  it('fitHistory conserva lo más reciente, empieza en user y fusiona roles repetidos', () => {
    const big = 'x'.repeat(700);
    const msgs = [
      { role: 'user', content: `u1 ${big}` },
      { role: 'assistant', content: `a1 ${big}` },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'u2b' },
      { role: 'assistant', content: 'a2' },
    ];
    const { messages, dropped } = fitHistory(msgs, 120);
    assert.ok(dropped >= 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'u2\n\nu2b');
    assert.equal(messages.at(-1).content, 'a2');
  });

  it('fitHistory con presupuesto amplio no descarta nada', () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    assert.deepEqual(fitHistory(msgs, 10_000), { messages: msgs, dropped: 0 });
  });

  it('append/read y truncateAfterLastUser para regenerar', async () => {
    await appendChatEntry(root, 'a1', 'c1', { id: 'u1', role: 'user', content: 'hola', ts: 1 });
    await appendChatEntry(root, 'a1', 'c1', { id: 'x1', role: 'assistant', content: 'resp', ts: 2 });
    await appendChatEntry(root, 'a1', 'c1', { id: 'u2', role: 'user', content: 'otra', ts: 3 });
    await appendChatEntry(root, 'a1', 'c1', { role: 'assistant', content: '', ts: 4, error: { title: 'boom' } });
    await fs.appendFile(path.join(root, 'chat', 'areas', 'a1', 'c1.jsonl'), 'línea rota\n');
    const { lastUser, removed } = await truncateAfterLastUser(root, 'a1', 'c1');
    assert.equal(lastUser.id, 'u2');
    assert.equal(removed, 1);
    const entries = await readChatLog(root, 'a1', 'c1');
    assert.deepEqual(entries.map((e) => e.id), ['u1', 'x1', 'u2']);
  });

  it('readChatLog de un chat inexistente devuelve []', async () => {
    assert.deepEqual(await readChatLog(root, 'a1', 'nada'), []);
  });

  it('guarda y lee el resumen de compactación', async () => {
    assert.equal(await loadSummary(root, 'a1', 'c1'), null);
    await saveSummary(root, 'a1', 'c1', { uptoTs: 2, text: 'Se habló de ventas.' });
    const s = await loadSummary(root, 'a1', 'c1');
    assert.equal(s.text, 'Se habló de ventas.');
    assert.equal(s.uptoTs, 2);
  });
});
