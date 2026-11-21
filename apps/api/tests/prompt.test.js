import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, PROMPT_DYNAMIC_MARKER } from '../src/chat/prompt.js';

const NOW = new Date('2026-09-28T15:00:00Z');
const PROJECT = { projectName: 'Finanzas', areaName: 'Ventas', summary: '', areaSummary: 'Área comercial.', rules: '- Tono: Formal', customInstructions: '' };

describe('chat/prompt', () => {
  it('modo tools menciona herramientas y no el protocolo de texto', () => {
    const p = buildSystemPrompt({ mode: 'tools', now: NOW, project: PROJECT, sections: {} });
    assert.match(p, /generate_file/);
    assert.match(p, /read_file/);
    assert.doesNotMatch(p, /tasky-file/);
  });

  it('modo texto explica el bloque tasky-file y no menciona herramientas', () => {
    const p = buildSystemPrompt({ mode: 'text', now: NOW, project: PROJECT, sections: {} });
    assert.match(p, /```tasky-file/);
    assert.doesNotMatch(p, /generate_file|read_file|edit_file/);
  });

  it('nunca usa "schema" como clave del contenido', () => {
    for (const mode of ['tools', 'text']) {
      const p = buildSystemPrompt({ mode, now: NOW, project: PROJECT, sections: {} });
      assert.doesNotMatch(p, /"schema"\s*:/);
      assert.match(p, /dentro de "data"/);
    }
  });

  it('incluye fecha, proyecto, área y reglas; omite secciones vacías', () => {
    const p = buildSystemPrompt({ mode: 'tools', now: NOW, project: PROJECT, sections: { fileIndex: '', snippets: '' } });
    assert.match(p, /2026/);
    assert.match(p, /septiembre/);
    assert.match(p, /Finanzas/);
    assert.match(p, /Ventas/);
    assert.match(p, /- Tono: Formal/);
    assert.match(p, /Área comercial\./);
    assert.doesNotMatch(p, /Resumen del proyecto/);
    assert.doesNotMatch(p, /Fragmentos relevantes/);
  });

  it('la parte estable es idéntica entre llamadas (cache de prefijo)', () => {
    const a = buildSystemPrompt({ mode: 'tools', now: NOW, project: PROJECT, sections: { snippets: 'uno' } });
    const b = buildSystemPrompt({ mode: 'tools', now: new Date('2026-10-01T10:00:00Z'), project: { ...PROJECT, areaName: 'Otra' }, sections: { snippets: 'dos', generated: '- x.docx' } });
    assert.equal(a.split(PROMPT_DYNAMIC_MARKER)[0], b.split(PROMPT_DYNAMIC_MARKER)[0]);
  });

  it('secciones de contexto aparecen cuando existen', () => {
    const p = buildSystemPrompt({
      mode: 'tools', now: NOW, project: PROJECT,
      sections: { fileIndex: '- ai/layer2/areas/a1/manual.pdf (PDF, 12 KB)', snippets: '<fragmento archivo="manual.pdf">texto</fragmento>', generated: '- files/generated/a.docx — Informe', conversationSummary: 'Se acordó X.' },
    });
    assert.match(p, /manual\.pdf \(PDF, 12 KB\)/);
    assert.match(p, /<fragmento archivo="manual\.pdf">/);
    assert.match(p, /files\/generated\/a\.docx/);
    assert.match(p, /Se acordó X\./);
  });

  it('modo compacto es más corto', () => {
    const full = buildSystemPrompt({ mode: 'tools', now: NOW, project: PROJECT, sections: {} });
    const compact = buildSystemPrompt({ mode: 'tools', now: NOW, project: PROJECT, sections: {}, compact: true });
    assert.ok(compact.length < full.length);
  });
});
