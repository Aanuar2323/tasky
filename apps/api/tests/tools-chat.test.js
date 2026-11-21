import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('chat/tools executeTool', () => {
  let tmpDir;
  let root;
  let tools;
  const events = [];
  let ctx;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-tools-'));
    process.env.STORAGE_ROOT = tmpDir;
    const storage = await import('../src/storage.js');
    tools = await import('../src/chat/tools.js');
    root = storage.projectRoot({ projectId: 'p1' });
    await storage.ensureProjectScaffold(root);
    await fs.writeFile(path.join(root, 'ai/layer2/areas/a1/notas.md'), '# Notas\n\nEl presupuesto 2026 es de $1.200.000.', 'utf8');
    await fs.writeFile(path.join(root, 'ai/layer2/areas/a1/largo.txt'), 'abcdefghij'.repeat(2000), 'utf8');
    ctx = { root, areaId: 'a1', chatId: 'c1', emit: (e) => events.push(e) };
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const call = (name, args) => ({ id: `call_${name}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

  it('isReadablePath permite área/archivos y bloquea internos', () => {
    const ok = tools.isReadablePath;
    assert.equal(ok('ai/layer2/areas/a1/notas.md', 'a1'), true);
    assert.equal(ok('files/generated/x.docx', 'a1'), true);
    assert.equal(ok('files/uploads/a1/c1/base.pdf', 'a1'), true);
    assert.equal(ok('history/areas/a1/files/x.docx', 'a1'), true);
    assert.equal(ok('ai/layer1/00-role-and-flow.md', 'a1'), false);
    assert.equal(ok('ai/layer2/areas/a1/rules(ajkwygebfickuvaulwakfjbscfa).md', 'a1'), false);
    assert.equal(ok('ai/layer2/areas/a2/otro.md', 'a1'), false);
    assert.equal(ok('info/areas.json', 'a1'), false);
    assert.equal(ok('chat/areas/a1/c1.jsonl', 'a1'), false);
    assert.equal(ok('../../etc/passwd', 'a1'), false);
    assert.equal(ok('files/generated/.tasky/x.docx.json', 'a1'), false);
  });

  it('generate_file válido crea archivo, sidecar y devuelve la tarjeta', async () => {
    const r = await tools.executeTool(call('generate_file', {
      type: 'docx', filename: 'informe presupuesto.docx', summary: 'Informe del presupuesto 2026',
      data: { title: 'Presupuesto', markdown: '# Resumen\n\nTotal **$1.200.000**.' },
    }), ctx);
    assert.equal(r.ok, true, r.content);
    assert.equal(r.file.name, 'informe presupuesto.docx');
    assert.equal(r.file.url, 'files/generated/informe presupuesto.docx');
    assert.equal(r.file.type, 'docx');
    assert.equal(r.file.summary, 'Informe del presupuesto 2026');
    assert.ok(r.file.size > 0);
    assert.match(r.content, /^OK/);
    const side = JSON.parse(await fs.readFile(path.join(root, 'files/generated/.tasky/informe presupuesto.docx.json'), 'utf8'));
    assert.equal(side.areaId, 'a1');
    assert.ok(events.some((e) => e.type === 'status' && e.phase === 'generating'));
  });

  it('generate_file inválido devuelve el error del docengine para corregir', async () => {
    const r = await tools.executeTool(call('generate_file', { type: 'pptx', filename: 'x.pptx', data: { slides: [{ layout: 'chart', title: 'x', chart: { type: 'radar_3d' } }] } }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /slides\.0/);
    assert.match(r.content, /generate_file/);
  });

  it('generate_file sin contenido o con JSON cortado explica qué falta', async () => {
    const empty = await tools.executeTool(call('generate_file', { type: 'docx', filename: 'v.docx', data: {} }), ctx);
    assert.equal(empty.ok, false);
    assert.match(empty.content, /data/);
    const cut = await tools.executeTool(call('generate_file', '{"type":"docx","data":{"sections":[{"type":"par'), ctx);
    assert.equal(cut.ok, false);
    assert.match(cut.content, /JSON/);
  });

  it('read_file lee archivos del área y bloquea internos', async () => {
    const r = await tools.executeTool(call('read_file', { path: 'ai/layer2/areas/a1/notas.md' }), ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /presupuesto 2026/);
    const denied = await tools.executeTool(call('read_file', { path: 'ai/layer1/00-role-and-flow.md' }), ctx);
    assert.equal(denied.ok, false);
    const missing = await tools.executeTool(call('read_file', { path: 'ai/layer2/areas/a1/nada.md' }), ctx);
    assert.equal(missing.ok, false);
  });

  it('read_file pagina archivos largos', async () => {
    const first = await tools.executeTool(call('read_file', { path: 'ai/layer2/areas/a1/largo.txt' }), ctx);
    assert.match(first.content, /offset=12000/);
    const second = await tools.executeTool(call('read_file', { path: 'ai/layer2/areas/a1/largo.txt', offset: 12000 }), ctx);
    assert.match(second.content, /12001-20000 de 20000/);
    assert.doesNotMatch(second.content, /offset=/);
  });

  it('read_file de un archivo generado incluye su fuente', async () => {
    const r = await tools.executeTool(call('read_file', { path: 'files/generated/informe presupuesto.docx' }), ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /Resumen/);
    assert.match(r.content, /Fuente para regenerar/);
    assert.match(r.content, /"markdown"/);
  });

  it('edit_file crea una versión nueva y reporta si no cambió nada', async () => {
    const r = await tools.executeTool(call('edit_file', { path: 'files/generated/informe presupuesto.docx', changes: { replace: [{ find: 'Resumen', replace: 'Síntesis' }] } }), ctx);
    assert.equal(r.ok, true, r.content);
    assert.equal(r.file.name, 'informe presupuesto-v2.docx');
    const none = await tools.executeTool(call('edit_file', { path: 'files/generated/informe presupuesto.docx', changes: { replace: [{ find: 'NO-EXISTE', replace: 'x' }] } }), ctx);
    assert.equal(none.ok, false);
    assert.match(none.content, /read_file/);
    await assert.rejects(fs.access(path.join(root, 'files/generated/informe presupuesto-v3.docx')));
  });

  it('herramienta desconocida', async () => {
    const r = await tools.executeTool(call('borrar_todo', {}), ctx);
    assert.equal(r.ok, false);
  });

  it('compactToolCallForReplay reemplaza data por un resumen', () => {
    const c = tools.compactToolCallForReplay(call('generate_file', { type: 'docx', filename: 'a.docx', data: { markdown: 'x'.repeat(5000) } }));
    const args = JSON.parse(c.function.arguments);
    assert.equal(c.type, 'function');
    assert.equal(args.filename, 'a.docx');
    assert.match(args.data, /omitido/);
    assert.ok(c.function.arguments.length < 300);
  });
});
