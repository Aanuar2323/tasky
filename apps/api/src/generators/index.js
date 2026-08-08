/**
 * index.js — Fachada de generación/edición de archivos.
 *
 * Toda generación se delega al microservicio Python (FastAPI, uvicorn)
 * vía src/generators/docengine.js. Este módulo expone la misma firma
 * pública que antes { generateFile, readFileStructure, editFile,
 * detectFileType } para que src/index.js y storage no cambien.
 */

import { generateFile, editFile, readFileStructure, detectFileType } from './docengine.js';

export { generateFile, editFile, readFileStructure, detectFileType };
