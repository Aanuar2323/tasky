import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

import {
  decodeXmlEntities,
  extractText,
  extractTextFromBuffer,
  extractStats,
  kindOf,
  CONTEXT_EXTS,
} from '../src/context/extract.js';

async function pptxBuffer(slides) {
  const zip = new JSZip();
  slides.forEach((xmlBody, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`,
      '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:txBody>' + xmlBody + '</p:txBody></p:sld>');
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('context/extract', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-extract-'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('decodifica entidades XML', () => {
    assert.equal(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233;&#xE9;'), 'a & b <c> "d" \'e\' éé');
  });

  it('kindOf clasifica por extensión', () => {
    assert.equal(kindOf('a.PDF'), 'pdf');
    assert.equal(kindOf('a.docx'), 'docx');
    assert.equal(kindOf('a.pptx'), 'pptx');
    assert.equal(kindOf('a.xlsx'), 'xlsx');
    assert.equal(kindOf('a.md'), 'text');
    assert.equal(kindOf('foto.PNG'), 'image');
    assert.equal(kindOf('a.exe'), 'binary');
    assert.ok(CONTEXT_EXTS.test('x.csv'));
  });

  it('PPTX: reconoce <a:t> con atributos y entidades', async () => {
    const buf = await pptxBuffer([
      '<a:p><a:r><a:t xml:space="preserve">Hola &amp; chau</a:t></a:r></a:p>',
      '<a:p><a:r><a:t>Segunda</a:t></a:r></a:p>',
    ]);
    const text = await extractTextFromBuffer(buf, 'x.pptx');
    assert.match(text, /\[Slide 1\]\nHola & chau/);
    assert.match(text, /\[Slide 2\]\nSegunda/);
  });

  it('XLSX: muestra el resultado de fórmulas, no "="', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Datos');
    ws.addRow(['Item', 'Monto']);
    ws.addRow(['a', 10]);
    ws.addRow(['Total', { formula: 'SUM(B2:B2)', result: 10 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const text = await extractTextFromBuffer(buf, 'x.xlsx');
    assert.match(text, /\[Hoja: Datos\]/);
    assert.match(text, /Total\t10/);
    assert.doesNotMatch(text, /=/);
  });

  it('texto plano y binarios', async () => {
    assert.equal(await extractTextFromBuffer(Buffer.from('hola'), 'n.txt'), 'hola');
    assert.equal(await extractTextFromBuffer(Buffer.from([0, 1, 2]), 'f.png'), '');
  });

  it('cachea por mtime/tamaño e invalida al cambiar el archivo', async () => {
    const p = path.join(dir, 'notas.md');
    await fs.writeFile(p, 'uno', 'utf8');
    const s0 = extractStats();
    assert.equal(await extractText(p), 'uno');
    assert.equal(await extractText(p), 'uno');
    const s1 = extractStats();
    assert.equal(s1.misses - s0.misses, 1);
    assert.equal(s1.hits - s0.hits, 1);
    await fs.writeFile(p, 'dos más largo', 'utf8');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(p, future, future);
    assert.equal(await extractText(p), 'dos más largo');
  });

  it('archivo inexistente o ilegible devuelve cadena vacía', async () => {
    assert.equal(await extractText(path.join(dir, 'no-existe.md')), '');
    await fs.writeFile(path.join(dir, 'roto.docx'), 'no es zip');
    assert.equal(await extractText(path.join(dir, 'roto.docx')), '');
  });
});
