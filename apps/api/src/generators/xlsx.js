import ExcelJS from 'exceljs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';

export async function generateXlsx({ outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const safeName = filename
    ? (filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
    : `documento-${nanoid(8)}.xlsx`;

  for (const sheetDef of data.sheets ?? []) {
    const sheet = workbook.addWorksheet(sheetDef.name ?? 'Hoja 1');

    sheet.columns = (sheetDef.columns ?? []).map((col) => ({
      header: col.header ?? col.key,
      key: col.key,
      width: col.width ?? 15,
    }));

    for (const row of sheetDef.rows ?? []) {
      sheet.addRow(row);
    }

    if (sheetDef.styles?.headerBold || sheetDef.styles?.headerBgColor) {
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: sheetDef.styles?.headerBold ?? true };
      if (sheetDef.styles.headerBgColor) {
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: sheetDef.styles.headerBgColor },
        };
      }
      if (sheetDef.styles.headerFontColor) {
        headerRow.font = {
          ...headerRow.font,
          color: { argb: sheetDef.styles.headerFontColor },
        };
      }
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    }

    if (sheetDef.columns?.length) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheetDef.columns.length },
      };
    }
  }

  const filePath = path.join(outputDir, safeName);
  await workbook.xlsx.writeFile(filePath);

  return { filePath, filename: safeName };
}

export async function readXlsxStructure(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const columns = [];
    const rows = [];

    worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
      columns.push({
        header: cell.value?.toString() ?? `Col${colNumber}`,
        key: `col${colNumber}`,
        width: worksheet.getColumn(colNumber).width ?? 15,
      });
    });

    const rowCount = worksheet.rowCount;
    for (let r = 2; r <= rowCount; r++) {
      const row = {};
      worksheet.getRow(r).eachCell({ includeEmpty: true }, (cell, colNumber) => {
        row[`col${colNumber}`] = cell.value;
      });
      if (Object.keys(row).length > 0) rows.push(row);
    }

    sheets.push({ name: worksheet.name, columns, rows });
  });

  return { sheets };
}

export async function editXlsx({ inputPath, outputDir, changes }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);

  for (const change of changes.sheets ?? []) {
    if (change.addSheet) {
      const newSheet = workbook.addWorksheet(change.addSheet.name);
      newSheet.columns = change.addSheet.columns.map((c) => ({
        header: c.header ?? c.key,
        key: c.key,
        width: c.width ?? 15,
      }));
      for (const row of change.addSheet.rows ?? []) {
        newSheet.addRow(row);
      }
      continue;
    }

    const sheet = workbook.getWorksheet(change.name);
    if (!sheet) continue;

    for (const row of change.addRows ?? []) {
      sheet.addRow(row);
    }

    for (const cellChange of change.updateCells ?? []) {
      const row = sheet.getRow(cellChange.row);
      row.getCell(cellChange.col).value = cellChange.value;
      row.commit();
    }
  }

  const safeName = `editado-${nanoid(8)}.xlsx`;
  const filePath = path.join(outputDir, safeName);
  await workbook.xlsx.writeFile(filePath);

  return { filePath, filename: safeName };
}
