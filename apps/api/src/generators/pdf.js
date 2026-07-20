import PDFDocument from 'pdfkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { nanoid } from 'nanoid';

export async function generatePdf({ outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });

  const safeName = filename
    ? (filename.endsWith('.pdf') ? filename : `${filename}.pdf`)
    : `documento-${nanoid(8)}.pdf`;

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const filePath = path.join(outputDir, safeName);
  const stream = createWriteStream(filePath);
  doc.pipe(stream);

  if (data.title) {
    doc.fontSize(22).font('Helvetica-Bold').text(data.title, { align: 'center' });
    doc.moveDown(1);
  }

  for (const section of data.sections ?? []) {
    switch (section.type) {
      case 'heading':
        doc.moveDown(0.5);
        const hSize = section.level === 1 ? 18 : section.level === 2 ? 15 : 13;
        doc.fontSize(hSize).font('Helvetica-Bold').text(section.text ?? '');
        doc.moveDown(0.3);
        break;

      case 'paragraph':
        doc.fontSize(section.fontSize ?? 11).font('Helvetica');
        if (section.bold) doc.font('Helvetica-Bold');
        doc.text(section.text ?? '', { align: section.alignment ?? 'left' });
        doc.moveDown(0.3);
        break;

      case 'bullet':
        doc.fontSize(section.fontSize ?? 11).font('Helvetica')
          .text(`  •  ${section.text ?? ''}`, { indent: 20 });
        doc.moveDown(0.2);
        break;

      case 'table': {
        const rows = section.rows ?? [];
        if (rows.length === 0) break;
        const colCount = Math.max(...rows.map(r => r.length), 1);
        const colWidth = (doc.page.width - 100) / colCount;

        doc.fontSize(9);
        for (const row of rows) {
          const cellHeight = 18;
          let yStart = doc.y;
          const xStart = 50;

          for (let c = 0; c < colCount; c++) {
            const text = String(row[c] ?? '');
            const x = xStart + c * colWidth;
            doc.rect(x, yStart, colWidth, cellHeight).stroke();
            doc.font('Helvetica').text(text, x + 3, yStart + 4, {
              width: colWidth - 6,
              lineBreak: false,
            });
          }
          doc.y = yStart + cellHeight;
          if (doc.y > doc.page.height - 60) doc.addPage();
        }
        doc.moveDown(0.5);
        break;
      }

      case 'image':
        if (section.imagePath) {
          try {
            const imgData = await fs.readFile(section.imagePath);
            const imgWidth = section.imageWidth ?? 400;
            const imgHeight = section.imageHeight ?? 250;
            if (doc.y + imgHeight > doc.page.height - 50) doc.addPage();
            doc.image(imgData, 50, doc.y, { width: imgWidth, height: imgHeight });
            doc.moveDown(imgHeight / doc.currentLineHeight() + 0.5);
          } catch {
            doc.fontSize(10).font('Helvetica').text(`[Imagen no encontrada: ${section.imagePath}]`);
          }
        }
        break;

      default:
        if (section.text) {
          doc.fontSize(11).font('Helvetica').text(section.text);
        }
    }
  }

  doc.end();
  await new Promise((resolve) => stream.on('finish', resolve));

  return { filePath, filename: safeName };
}

export async function readPdfStructure(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      filename: path.basename(filePath),
      size: stat.size,
      note: 'Archivo PDF binario. La IA necesita la estructura JSON original para editar.',
    };
  } catch {
    return { note: 'No se pudo leer la estructura del PDF.' };
  }
}

export async function editPdf({ outputDir, data, filename }) {
  return generatePdf({ outputDir, data, filename: filename ?? `editado-${nanoid(8)}.pdf` });
}