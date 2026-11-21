import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNumericCell, splitSheet } from '../app/lib/sheet.ts';

describe('splitSheet', () => {
  it('separa el título de la hoja del encabezado real', () => {
    const out = splitSheet([
      ['Ventas Q3 por región'],
      ['Región', 'Julio', 'Agosto'],
      ['Centro', '3.900.000', '4.150.000'],
    ]);
    assert.equal(out.title, 'Ventas Q3 por región');
    assert.deepEqual(out.header, ['Región', 'Julio', 'Agosto']);
    assert.deepEqual(out.body, [['Centro', '3.900.000', '4.150.000']]);
  });

  it('saltea filas vacías entre título y encabezado', () => {
    const out = splitSheet([['Informe', '', ''], ['', '', ''], ['A', 'B', 'C'], ['1', '2', '3']]);
    assert.equal(out.title, 'Informe');
    assert.deepEqual(out.header, ['A', 'B', 'C']);
    assert.deepEqual(out.body, [['1', '2', '3']]);
  });

  it('sin título usa la primera fila como encabezado', () => {
    const out = splitSheet([['Mes', 'Total'], ['Ene', '10']]);
    assert.equal(out.title, null);
    assert.deepEqual(out.header, ['Mes', 'Total']);
    assert.deepEqual(out.body, [['Ene', '10']]);
  });

  it('una hoja de una sola columna no pierde su encabezado', () => {
    const out = splitSheet([['Nombres'], ['Ana'], ['Luis']]);
    assert.equal(out.title, null);
    assert.deepEqual(out.header, ['Nombres']);
  });
});

describe('isNumericCell', () => {
  it('reconoce números, monedas y porcentajes', () => {
    for (const v of ['3.900.000', '-0,92', '12,5%', '$1.250,50', '$ 980', 'US$ 12', '-$3.900', '1.5']) {
      assert.equal(isNumericCell(v), true, v);
    }
  });

  it('no confunde texto ni fechas con números', () => {
    for (const v of ['Centro', '', '31/07/2026', '=SUM(B2:B3)', 'Q3', '2026-07-31']) {
      assert.equal(isNumericCell(v), false, v);
    }
  });
});
