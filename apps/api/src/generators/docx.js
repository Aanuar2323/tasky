import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, ImageRun,
} from 'docx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

const alignmentMap = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

const headingLevelMap = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

export async function generateDocx({ outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });

  const safeName = filename
    ? (filename.endsWith('.docx') ? filename : `${filename}.docx`)
    : `documento-${nanoid(8)}.docx`;

  const children = [];

  if (data.title) {
    children.push(
      new Paragraph({
        text: data.title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
      })
    );
    children.push(new Paragraph({ text: '' }));
  }

  for (const section of data.sections ?? []) {
    switch (section.type) {
      case 'heading':
        children.push(
          new Paragraph({
            text: section.text ?? '',
            heading: headingLevelMap[section.level ?? 1] ?? HeadingLevel.HEADING_1,
          })
        );
        break;

      case 'paragraph':
        children.push(
          new Paragraph({
            alignment: alignmentMap[section.alignment ?? 'left'],
            children: [
              new TextRun({
                text: section.text ?? '',
                bold: section.bold ?? false,
                italics: section.italic ?? false,
                size: (section.fontSize ?? 11) * 2,
              }),
            ],
          })
        );
        break;

      case 'bullet':
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [
              new TextRun({
                text: section.text ?? '',
                size: (section.fontSize ?? 11) * 2,
              }),
            ],
          })
        );
        break;

      case 'table': {
        const noBorder = {
          top: { style: BorderStyle.SINGLE, size: 1 },
          bottom: { style: BorderStyle.SINGLE, size: 1 },
          left: { style: BorderStyle.SINGLE, size: 1 },
          right: { style: BorderStyle.SINGLE, size: 1 },
        };

        const tableRows = (section.rows ?? []).map(
          (row) =>
            new TableRow({
              children: row.map(
                (cell) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: String(cell ?? ''),
                            bold: false,
                            size: 20,
                          }),
                        ],
                      }),
                    ],
                    borders: noBorder,
                    width: { size: Math.floor(9000 / Math.max(row.length, 1)), type: WidthType.DXA },
                  })
              ),
            })
        );

        if (tableRows.length > 0) {
          children.push(
            new Table({
              rows: tableRows,
              width: { size: 9000, type: WidthType.DXA },
            })
          );
        }
        break;
      }

      case 'image': {
        if (section.imagePath) {
          try {
            const imageBuffer = await fs.readFile(section.imagePath);
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new ImageRun({
                    data: imageBuffer,
                    transformation: {
                      width: section.imageWidth ?? 500,
                      height: section.imageHeight ?? 300,
                    },
                  }),
                ],
              })
            );
          } catch {
            children.push(new Paragraph({ text: `[Imagen no encontrada: ${section.imagePath}]` }));
          }
        }
        break;
      }

      default:
        if (section.text) {
          children.push(new Paragraph({ text: section.text }));
        }
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join(outputDir, safeName);
  await fs.writeFile(filePath, buffer);

  return { filePath, filename: safeName };
}

export async function readDocxStructure(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      filename: path.basename(filePath),
      size: stat.size,
      note: 'Archivo DOCX binario. La IA necesita la estructura JSON original para editar. Si se generó en esta app, buscar el JSON asociado en el chatlog.',
    };
  } catch {
    return { note: 'No se pudo leer la estructura del DOCX.' };
  }
}

export async function editDocx({ outputDir, data, filename }) {
  return generateDocx({ outputDir, data, filename: filename ?? `editado-${nanoid(8)}.docx` });
}
