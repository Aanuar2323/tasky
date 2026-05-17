import PptxGenJS from 'pptxgenjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

const PRIMARY = '0D95A1';
const DARK = '0F172A';
const WHITE = 'FFFFFF';

export async function generatePptx({ outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });

  const safeName = filename
    ? (filename.endsWith('.pptx') ? filename : `${filename}.pptx`)
    : `presentacion-${nanoid(8)}.pptx`;

  const pptx = new PptxGenJS();
  pptx.layout = data.layout ?? 'LAYOUT_WIDE';
  pptx.author = data.author ?? 'Task App';
  pptx.title = data.title ?? 'Presentación';

  for (const slideDef of data.slides ?? []) {
    const slide = pptx.addSlide();

    switch (slideDef.type) {
      case 'title':
        slide.background = { color: PRIMARY };
        slide.addText(slideDef.title ?? '', {
          x: 0.8, y: 1.5, w: '80%', h: 1.5,
          fontSize: 36, fontFace: 'Arial',
          color: WHITE, bold: true,
        });
        if (slideDef.subtitle) {
          slide.addText(slideDef.subtitle, {
            x: 0.8, y: 3.2, w: '80%', h: 0.8,
            fontSize: 18, fontFace: 'Arial',
            color: WHITE, italic: true,
          });
        }
        break;

      case 'content':
        slide.background = { color: WHITE };
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: '100%', h: 0.08,
          fill: { color: PRIMARY },
        });
        if (slideDef.title) {
          slide.addText(slideDef.title, {
            x: 0.6, y: 0.3, w: '88%', h: 0.8,
            fontSize: 24, fontFace: 'Arial',
            color: DARK, bold: true,
          });
        }
        if (slideDef.body) {
          slide.addText(slideDef.body, {
            x: 0.6, y: 1.3, w: '88%', h: '60%',
            fontSize: 16, fontFace: 'Arial',
            color: DARK,
          });
        }
        break;

      case 'bullets':
        slide.background = { color: WHITE };
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: '100%', h: 0.08,
          fill: { color: PRIMARY },
        });
        if (slideDef.title) {
          slide.addText(slideDef.title, {
            x: 0.6, y: 0.3, w: '88%', h: 0.8,
            fontSize: 24, fontFace: 'Arial',
            color: DARK, bold: true,
          });
        }
        if (slideDef.bullets?.length) {
          slide.addText(
            slideDef.bullets.map((b) => ({
              text: b,
              options: { bullet: { type: 'bullet' }, fontSize: 16, color: DARK },
            })),
            { x: 0.8, y: 1.3, w: '85%', h: '60%' }
          );
        }
        break;

      case 'table': {
        slide.background = { color: WHITE };
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: '100%', h: 0.08,
          fill: { color: PRIMARY },
        });
        if (slideDef.title) {
          slide.addText(slideDef.title, {
            x: 0.6, y: 0.3, w: '88%', h: 0.6,
            fontSize: 20, fontFace: 'Arial',
            color: DARK, bold: true,
          });
        }
        if (slideDef.rows?.length) {
          const headerRow = slideDef.rows[0];
          const dataRows = slideDef.rows.slice(1);
          slide.addTable(
            [
              headerRow.map((cell) => ({
                text: String(cell ?? ''),
                options: { bold: true, color: WHITE, fill: { color: PRIMARY }, fontSize: 12 },
              })),
              ...dataRows.map((row) =>
                row.map((cell) => ({
                  text: String(cell ?? ''),
                  options: { fontSize: 11, color: DARK },
                }))
              ),
            ],
            { x: 0.5, y: 1.1, w: '90%', border: { pt: 0.5, color: 'CFCFCF' } }
          );
        }
        break;
      }

      case 'image':
        slide.background = { color: WHITE };
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: '100%', h: 0.08,
          fill: { color: PRIMARY },
        });
        if (slideDef.title) {
          slide.addText(slideDef.title, {
            x: 0.6, y: 0.3, w: '88%', h: 0.6,
            fontSize: 20, fontFace: 'Arial',
            color: DARK, bold: true,
          });
        }
        if (slideDef.imagePath) {
          try {
            const imgData = await fs.readFile(slideDef.imagePath);
            slide.addImage({
              data: `image/png;base64,${imgData.toString('base64')}`,
              x: 1, y: 1.1, w: 7, h: 4,
            });
          } catch {
            slide.addText('[Imagen no encontrada]', {
              x: 1, y: 1.5, w: 7, h: 2,
              fontSize: 16, color: '999999',
            });
          }
        }
        break;

      default:
        if (slideDef.title) {
          slide.addText(slideDef.title, {
            x: 0.6, y: 0.6, w: '88%', h: 0.8,
            fontSize: 24, color: DARK, bold: true,
          });
        }
    }

    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }

  const filePath = path.join(outputDir, safeName);
  await pptx.writeFile({ fileName: filePath });

  return { filePath, filename: safeName };
}

export async function readPptxStructure(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      filename: path.basename(filePath),
      size: stat.size,
      note: 'Archivo PPTX binario. La IA necesita la estructura JSON original para editar. Buscar en el chatlog del área.',
    };
  } catch {
    return { note: 'No se pudo leer el archivo PPTX.' };
  }
}

export async function editPptx({ outputDir, data, filename }) {
  return generatePptx({ outputDir, data, filename: filename ?? `editado-${nanoid(8)}.pptx` });
}
