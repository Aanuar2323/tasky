import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('context/project', () => {
  let tmpDir;
  let root;
  let project;
  let storage;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-project-'));
    process.env.STORAGE_ROOT = tmpDir;
    storage = await import('../src/storage.js');
    project = await import('../src/context/project.js');
    root = storage.projectRoot({ projectId: 'p1' });
    await storage.ensureProjectScaffold(root);
  });

  after(async () => {
    delete process.env.STORAGE_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('renderActiveRules: solo reglas activas, formato limpio', () => {
    const md = '### Tono\n- Formal\n`enabled`\n\n### Emojis\n- Usar emojis\n`disabled`\n\n### Sin desc\n- Sin descripcion\n`manual`\n`enabled`';
    assert.equal(project.renderActiveRules(md), '- Tono: Formal\n- Sin desc');
  });

  it('renderActiveRules: plantilla por defecto = vacía; texto libre pasa', () => {
    assert.equal(project.renderActiveRules('# Reglas del área: X\n\n**Instrucciones:** Configura reglas…\n\nEjemplos:\n- "Usar tono formal."'), '');
    assert.equal(project.renderActiveRules('Siempre respondé en inglés.'), 'Siempre respondé en inglés.');
    assert.equal(project.renderActiveRules(''), '');
  });

  it('reconoce las plantillas por defecto de versiones anteriores', async () => {
    const { LEGACY_TEMPLATES } = await import('../src/context/legacy-templates.js');
    assert.ok(LEGACY_TEMPLATES.some((t) => t.includes('Máximo 10 filas por tabla')));
    assert.ok(LEGACY_TEMPLATES.some((t) => t.includes('Capa 1 — Rol y orden de ejecución')));
    for (const t of LEGACY_TEMPLATES) {
      assert.equal(project.renderActiveRules(t), '', t.slice(0, 40));
      assert.equal(project.cleanSummary(t), '', t.slice(0, 40));
    }
  });

  it('resúmenes plantilla se ignoran', () => {
    assert.equal(project.cleanSummary('# Capa 2 — Resumen general del proyecto\n\n**Instrucciones:** Describe aquí…'), '');
    assert.equal(project.cleanSummary('Proyecto de marketing Q3.'), 'Proyecto de marketing Q3.');
  });

  it('loadProjectContext en un proyecto recién creado no arrastra plantillas', async () => {
    const areas = [{ id: 'a1', name: 'Ventas', chats: [{ id: 'c1', name: 'Chat 1' }], activeChatId: 'c1' }];
    const ctx = await project.loadProjectContext(root, 'a1', areas);
    assert.equal(ctx.areaName, 'Ventas');
    assert.equal(ctx.rules, '');
    assert.equal(ctx.summary, '');
    assert.equal(ctx.areaSummary, '');
    assert.equal(ctx.customInstructions, '');
  });

  it('loadProjectContext usa reglas globales si el área no tiene; instrucciones personalizadas sí pasan', async () => {
    await fs.writeFile(path.join(root, 'rules.md'), '### Moneda\n- Usar pesos argentinos\n`enabled`', 'utf8');
    await fs.writeFile(path.join(root, 'ai', 'layer1', '00-role-and-flow.md'), 'Sos experto en finanzas.', 'utf8');
    await fs.writeFile(path.join(root, 'info', 'name.txt'), 'Finanzas 2026', 'utf8');
    const ctx = await project.loadProjectContext(root, 'a1', [{ id: 'a1', name: 'Ventas', chats: [] }]);
    assert.equal(ctx.rules, '- Moneda: Usar pesos argentinos');
    assert.equal(ctx.customInstructions, 'Sos experto en finanzas.');
    assert.equal(ctx.projectName, 'Finanzas 2026');
  });

  it('listGeneratedFiles combina sidecars y referencias del chat del área, sin duplicados', async () => {
    const gen = path.join(root, 'files', 'generated');
    await fs.mkdir(path.join(gen, '.tasky'), { recursive: true });
    await fs.writeFile(path.join(gen, 'nuevo.docx'), 'x');
    await fs.writeFile(path.join(gen, '.tasky', 'nuevo.docx.json'), JSON.stringify({ type: 'docx', filename: 'nuevo.docx', summary: 'Informe nuevo', areaId: 'a1', chatId: 'c1', createdAt: '2026-09-01T10:00:00Z' }));
    await fs.writeFile(path.join(gen, 'otra-area.xlsx'), 'x');
    await fs.writeFile(path.join(gen, '.tasky', 'otra-area.xlsx.json'), JSON.stringify({ type: 'xlsx', filename: 'otra-area.xlsx', areaId: 'a2', createdAt: '2026-09-02T10:00:00Z' }));
    await fs.writeFile(path.join(gen, 'legacy.pptx'), 'x');
    await fs.mkdir(path.join(root, 'chat', 'areas', 'a1'), { recursive: true });
    await fs.writeFile(path.join(root, 'chat', 'areas', 'a1', 'c9.jsonl'), [
      JSON.stringify({ role: 'user', content: 'hacé una ppt', ts: 1 }),
      JSON.stringify({ role: 'assistant', content: 'Listo', ts: 2, file: { name: 'legacy.pptx', url: 'files/generated/legacy.pptx', type: 'pptx' } }),
      JSON.stringify({ role: 'assistant', content: 'dup', ts: 3, files: [{ name: 'nuevo.docx', url: 'files/generated/nuevo.docx', type: 'docx' }] }),
      JSON.stringify({ role: 'assistant', content: 'borrado', ts: 4, file: { name: 'no-existe.docx', url: 'files/generated/no-existe.docx', type: 'docx' } }),
    ].join('\n') + '\n');
    const files = await project.listGeneratedFiles(root, { areaId: 'a1' });
    const names = files.map((f) => f.filename).sort();
    assert.deepEqual(names, ['legacy.pptx', 'nuevo.docx']);
    assert.equal(files.find((f) => f.filename === 'nuevo.docx').summary, 'Informe nuevo');
    assert.equal(files.find((f) => f.filename === 'legacy.pptx').path, 'files/generated/legacy.pptx');
  });

  it('listAreaContextFiles devuelve archivos del área con tamaño, sin archivos internos', async () => {
    const dir = path.join(root, 'ai', 'layer2', 'areas', 'a1');
    await fs.writeFile(path.join(dir, 'manual.md'), '# Manual', 'utf8');
    const files = await project.listAreaContextFiles(root, 'a1');
    const man = files.find((f) => f.path.endsWith('manual.md'));
    assert.ok(man);
    assert.equal(man.size, 8);
    assert.ok(files.every((f) => !f.path.includes('rules(') && !f.path.includes('summary(')));
  });
});
