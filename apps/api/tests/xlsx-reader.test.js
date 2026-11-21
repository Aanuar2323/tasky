import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { readXlsx } from '../src/context/xlsx-reader.js';
import { generateFile } from '../src/generators/docengine.js';

describe('context/xlsx-reader', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasky-xlsx-'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lee archivos de openpyxl con tablas de Excel, fechas, porcentajes y hojas ocultas', async () => {
    const res = await generateFile({
      type: 'xlsx',
      outputDir: dir,
      filename: 'ventas.xlsx',
      data: {
        sheets: [{
          name: 'Ventas',
          headers: ['Mes', 'Total', 'Var', 'Fecha'],
          rows: [['Ene', '1.500', '15%', '2026-01-31'], ['Feb', 2300.5, '-3%', '2026-02-28']],
          summary_row: true,
          chart: { type: 'pie', labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] },
        }],
      },
    });
    const { sheets } = await readXlsx(await fs.readFile(res.filePath));
    assert.deepEqual(sheets.map((s) => s.name), ['Ventas']);
    const rows = sheets[0].rows;
    assert.deepEqual(rows[0], ['Mes', 'Total', 'Var', 'Fecha']);
    assert.deepEqual(rows[1], ['Ene', '1500', '15%', '2026-01-31']);
    assert.deepEqual(rows[2], ['Feb', '2300.5', '-3%', '2026-02-28']);
    assert.equal(rows[3][0], 'Total');
    assert.equal(rows[3][1], '=SUM(B2:B3)');
  });

  it('lee archivos de ExcelJS con resultado de fórmulas y texto enriquecido', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Datos');
    ws.addRow(['Item', 'Monto']);
    ws.addRow([{ richText: [{ text: 'Caf' }, { text: 'é', font: { bold: true } }] }, 10]);
    ws.addRow(['Total', { formula: 'SUM(B2:B2)', result: 10 }]);
    ws.getCell('C1').value = true;
    const { sheets } = await readXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.deepEqual(sheets[0].rows[0], ['Item', 'Monto', 'TRUE']);
    assert.deepEqual(sheets[0].rows[1], ['Café', '10']);
    assert.deepEqual(sheets[0].rows[2], ['Total', '10']);
  });

  it('respeta límites de filas y columnas', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Grande');
    for (let i = 0; i < 50; i += 1) ws.addRow(Array.from({ length: 40 }, (_, c) => `${i}-${c}`));
    const { sheets } = await readXlsx(Buffer.from(await wb.xlsx.writeBuffer()), { maxRows: 10, maxCols: 5 });
    assert.equal(sheets[0].rows.length, 10);
    assert.equal(sheets[0].rows[0].length, 5);
    assert.equal(sheets[0].totalRows, 50);
  });

  it('modo display: formatos es-AR, fechas locales y totales calculados', async () => {
    const res = await generateFile({
      type: 'xlsx',
      outputDir: dir,
      filename: 'display.xlsx',
      data: {
        sheets: [{
          name: 'Ventas',
          title: 'Ventas Q3',
          headers: ['Región', 'Julio', 'Margen', 'Cierre', 'Precio'],
          rows: [['Centro', 3900000, '12,5%', '2026-07-31', '$ 1.250,50'], ['Norte', 2100000, '8%', '2026-07-31', '$ 980']],
          summary_row: { label: 'Total' },
        }],
      },
    });
    const buf = await fs.readFile(res.filePath);
    const { sheets } = await readXlsx(buf, { display: true });
    const rows = sheets[0].rows;
    const centro = rows.find((r) => r[0] === 'Centro');
    assert.deepEqual(centro, ['Centro', '3.900.000', '12,5%', '31/07/2026', '$1.250,50']);
    assert.equal(rows.find((r) => r[0] === 'Total')[1], '6.000.000');
    // El modo por defecto (texto para la IA) no cambia.
    const raw = await readXlsx(buf);
    assert.equal(raw.sheets[0].rows.find((r) => r[0] === 'Centro')[1], '3900000');
    assert.match(raw.sheets[0].rows.find((r) => r[0] === 'Total')[1], /^=SUM\(/);
  });

  it('modo display: evalúa aritmética simple y deja como texto lo que no entiende', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Calc');
    ws.addRow(['Precio', 'Cant', 'Resultado']);
    ws.addRow([1250.5, 3, { formula: 'A2*B2' }]);
    ws.addRow([100, 2, { formula: 'ROUND((A3-A2)/A2,2)' }]);
    ws.addRow([4, 'x', { formula: 'Otra!A1+1' }]);
    ws.addRow([10, 5, { formula: 'AVERAGE(A2:A3)+MAX(B2:B3)' }]);
    ws.getCell('C2').numFmt = '#,##0.00';
    const { sheets } = await readXlsx(Buffer.from(await wb.xlsx.writeBuffer()), { display: true });
    const rows = sheets[0].rows;
    assert.equal(rows[1][2], '3.751,50');
    assert.equal(rows[2][2], '-0,92');
    assert.equal(rows[3][2], '=Otra!A1+1');
    assert.equal(rows[4][2], '678,25');
  });

  it('archivo inválido lanza error', async () => {
    await assert.rejects(readXlsx(Buffer.from('no es zip')));
  });
});
