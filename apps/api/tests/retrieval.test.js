import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, chunkText, buildIndex, search } from '../src/context/retrieval.js';
import { estimateTokens, estimateMessagesTokens, planBudget, truncateToTokens } from '../src/context/budget.js';

describe('context/retrieval', () => {
  it('tokenize normaliza tildes, mayúsculas, plurales y stopwords', () => {
    assert.deepEqual(tokenize('¿Cuántos DÍAS de vacaciones tengo?'), ['cuanto', 'dia', 'vacacion', 'tengo']);
    assert.deepEqual(tokenize('Informes y reportes'), ['informe', 'reporte']);
    assert.deepEqual(tokenize('the and of'), []);
  });

  it('chunkText respeta párrafos, tamaño y solapamiento', () => {
    const para = (n) => `Párrafo ${n}. ` + 'palabra '.repeat(60).trim();
    const text = [1, 2, 3, 4, 5].map(para).join('\n\n');
    const chunks = chunkText(text, { size: 900, overlap: 100 });
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.text.length <= 900 + 100 + 20, `chunk demasiado largo: ${c.text.length}`);
    assert.ok(chunks[0].text.startsWith('Párrafo 1.'));
    assert.equal(chunks.map((c) => c.index).join(','), chunks.map((_, i) => i).join(','));
  });

  it('chunkText corta párrafos gigantes sin separadores', () => {
    const chunks = chunkText('x'.repeat(5000), { size: 1000, overlap: 0 });
    assert.equal(chunks.length, 5);
  });

  it('encuentra el fragmento relevante ignorando tildes', () => {
    const idx = buildIndex([
      { id: 'a', path: 'politicas.md', text: 'Política de vacaciones: cada empleado tiene 15 días hábiles por año.' },
      { id: 'b', path: 'menu.md', text: 'Menú del comedor: lunes pastas, martes pescado.' },
    ]);
    const res = search(idx, 'cuantos dias de vacacion me corresponden', { limit: 1 });
    assert.equal(res[0].path, 'politicas.md');
    assert.ok(res[0].score > 0);
  });

  it('prioriza documentos cuyo nombre coincide con la consulta', () => {
    const idx = buildIndex([
      { id: 'a', path: 'contrato_proveedor.md', text: 'Cláusulas generales y plazos de entrega.' },
      { id: 'b', path: 'notas.md', text: 'Plazos de entrega y cláusulas.' },
    ]);
    assert.equal(search(idx, 'plazos del contrato', { limit: 1 })[0].path, 'contrato_proveedor.md');
  });

  it('limita fragmentos por documento y descarta puntaje cero', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sección ${i}: presupuesto anual detallado número ${i}.`).join('\n\n');
    const idx = buildIndex([{ id: 'a', path: 'p.md', text: long }, { id: 'b', path: 'x.md', text: 'nada que ver' }], { chunkSize: 60, overlap: 0 });
    const res = search(idx, 'presupuesto', { limit: 10, perDocLimit: 3 });
    assert.equal(res.length, 3);
    assert.ok(res.every((r) => r.path === 'p.md'));
  });

  it('consulta vacía no devuelve resultados', () => {
    const idx = buildIndex([{ id: 'a', path: 'a.md', text: 'hola' }]);
    assert.deepEqual(search(idx, '¿y?', { limit: 3 }), []);
  });
});

describe('context/budget', () => {
  it('estimación de tokens conservadora', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('a'.repeat(350)), 100);
    const n = estimateMessagesTokens([{ role: 'user', content: 'a'.repeat(35) }, { role: 'user', content: [{ type: 'text', text: 'a'.repeat(35) }, { type: 'image_url', image_url: { url: 'data:' } }] }]);
    assert.ok(n >= 10 + 10 + 1000);
  });

  it('planBudget con 8K reduce la salida y reparte el resto', () => {
    const b = planBudget({ contextLength: 8192, maxOutput: 8192, coreTokens: 2500 });
    assert.ok(b.output <= 3072);
    assert.ok(b.input + b.output <= 8192);
    assert.ok(b.sections.history > 0);
    const sum = Object.values(b.sections).reduce((a, c) => a + c, 0);
    assert.ok(sum <= b.input - 2500);
  });

  it('planBudget con 1M limita la entrada y conserva la salida del modelo', () => {
    const b = planBudget({ contextLength: 1_000_000, maxOutput: 16384 });
    assert.ok(b.input <= 100_000);
    assert.equal(b.output, 16384);
  });

  it('planBudget respeta un máximo de entrada configurado', () => {
    assert.ok(planBudget({ contextLength: 200_000, maxOutput: 8000, maxInput: 30_000 }).input <= 30_000);
  });

  it('truncateToTokens corta en un límite de palabra y marca el recorte', () => {
    const text = 'palabra '.repeat(200);
    const out = truncateToTokens(text, 20);
    assert.ok(estimateTokens(out) <= 24);
    assert.match(out, /…\[recortado\]$/);
    assert.equal(truncateToTokens('corto', 20), 'corto');
  });
});
