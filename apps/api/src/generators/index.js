import { generateXlsx, readXlsxStructure, editXlsx } from './xlsx.js';
import { generateDocx, readDocxStructure, editDocx } from './docx.js';
import { generatePptx, readPptxStructure, editPptx } from './pptx.js';
import { generatePng, editPng } from './png.js';

const GENERATORS = {
  xlsx: { generate: generateXlsx, readStructure: readXlsxStructure, edit: editXlsx },
  docx: { generate: generateDocx, readStructure: readDocxStructure, edit: editDocx },
  pptx: { generate: generatePptx, readStructure: readPptxStructure, edit: editPptx },
  png: { generate: generatePng, readStructure: null, edit: editPng },
};

export function detectFileType(filename) {
  if (!filename) return null;
  const ext = filename.split('.').pop().toLowerCase();
  if (ext in GENERATORS) return ext;
  return null;
}

export async function generateFile({ type, outputDir, data, filename }) {
  const gen = GENERATORS[type];
  if (!gen) throw new Error(`Unsupported file type: ${type}`);
  return gen.generate({ outputDir, data, filename });
}

export async function readFileStructure(type, filePath) {
  const gen = GENERATORS[type];
  if (!gen?.readStructure) {
    return { note: `No se puede leer la estructura de archivos .${type} directamente.` };
  }
  return gen.readStructure(filePath);
}

export async function editFile({ type, inputPath, outputDir, changes, filename }) {
  const gen = GENERATORS[type];
  if (!gen) throw new Error(`Unsupported file type: ${type}`);
  if (!gen.edit) throw new Error(`Editing not supported for type: ${type}`);

  if (type === 'xlsx') return gen.edit({ inputPath, outputDir, changes, filename });
  if (type === 'docx') return gen.edit({ outputDir, data: changes, filename });
  if (type === 'pptx') return gen.edit({ outputDir, data: changes, filename });
  if (type === 'png') return gen.edit({ inputPath, outputDir, changes, filename });

  throw new Error(`Edit handler missing for type: ${type}`);
}
