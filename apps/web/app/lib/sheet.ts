/** Utilidades para mostrar hojas de cálculo en la vista previa. */

const filled = (row: string[] | undefined) => (row ?? []).filter((c) => c.trim() !== "").length;

/**
 * Separa el título de la hoja (una sola celda arriba de la tabla, como escribe
 * el generador) del encabezado real.
 */
export function splitSheet(rows: string[][]): { title: string | null; header: string[] | undefined; body: string[][] } {
  if (filled(rows[0]) === 1) {
    let next = 1;
    while (next < rows.length && filled(rows[next]) === 0) next += 1;
    if (filled(rows[next]) > 1) {
      return { title: rows[0].find((c) => c.trim() !== "") ?? null, header: rows[next], body: rows.slice(next + 1) };
    }
  }
  const [header, ...body] = rows;
  return { title: null, header, body };
}

const NUMERIC = /^[-−]?(?:(?:US)?\$|€|£)?\s?[-−]?\d[\d.,]*\s?%?$/;

/** Celdas numéricas (incluye moneda y porcentaje) se alinean a la derecha. */
export function isNumericCell(text: string): boolean {
  return NUMERIC.test(text.trim());
}
