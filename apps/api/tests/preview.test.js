import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildPreview } from '../src/preview.js';
import { generateFile } from '../src/generators/docengine.js';

describe('preview', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-preview-'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('las planillas se ven como en Excel: miles es-AR y totales calculados', async () => {
    const res = await generateFile({
      type: 'xlsx',
      outputDir: dir,
      filename: 'ventas.xlsx',
      data: {
        sheets: [{
          name: 'Ventas',
          headers: ['Región', 'Julio'],
          rows: [['Centro', 3900000], ['Norte', 2100000]],
          summary_row: { label: 'Total' },
        }],
      },
    });
    const preview = await buildPreview(res.filePath);
    assert.equal(preview.kind, 'sheets');
    const rows = preview.sheets[0].rows;
    assert.deepEqual(rows.find((r) => r[0] === 'Centro'), ['Centro', '3.900.000']);
    assert.deepEqual(rows.find((r) => r[0] === 'Total'), ['Total', '6.000.000']);
  });

  it('docx: las tablas se ven como tablas y el título como encabezado', async () => {
    const res = await generateFile({
      type: 'docx',
      outputDir: dir,
      filename: 'informe.docx',
      data: {
        title: 'Informe Q3',
        markdown: '## Resumen\n\nTexto **clave** y *matiz*.\n\n| Región | Ventas |\n|---|---:|\n| Centro | $ 12.450.000 |\n| Norte | $ 6.180.000 |\n\n- Punto uno\n- Punto dos',
      },
    });
    const preview = await buildPreview(res.filePath);
    assert.equal(preview.kind, 'markdown');
    const md = preview.markdown;
    assert.match(md, /^# Informe Q3$/m);
    assert.match(md, /^#{1,3} Resumen$/m);
    assert.match(md, /\*\*clave\*\*/);
    assert.match(md, /^\| Región \| Ventas \|$/m);
    assert.match(md, /^\| --- \| ---: \|$/m);
    assert.match(md, /^\| Centro \| \$ 12\.450\.000 \|$/m);
    assert.match(md, /^- Punto uno$/m);
  });

  it('pptx: el pie y el número de diapositiva no aparecen como contenido', async () => {
    const res = await generateFile({
      type: 'pptx',
      outputDir: dir,
      filename: 'deck.pptx',
      data: {
        footer: 'Confidencial',
        show_slide_numbers: true,
        slides: [
          { layout: 'title', title: 'Plan', subtitle: 'Q4' },
          { layout: 'content', title: 'Objetivos', bullets: ['Crecer', 'Ahorrar'] },
        ],
      },
    });
    const preview = await buildPreview(res.filePath);
    assert.equal(preview.kind, 'slides');
    assert.deepEqual(preview.slides.map((s) => [s.title, s.lines]), [['Plan', ['Q4']], ['Objetivos', ['Crecer', 'Ahorrar']]]);
  });
});
