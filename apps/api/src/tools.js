import { listDir, readTextFile, writeTextFile, deletePath, safeJoin } from './storage.js';
import fs from 'node:fs/promises';

export const toolsSchema = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Lee el contenido de un archivo de texto del proyecto. Útil para inspeccionar código o notas.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del archivo a leer." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Lista los archivos y carpetas dentro de un directorio relativo del proyecto.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del directorio (vacío para la raíz del proyecto)." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Crea o sobreescribe un archivo de texto en el proyecto.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del archivo a escribir." },
          content: { type: "string", description: "Contenido de texto a escribir." }
        },
        required: ["path", "content"]
      }
    }
  }
];

export async function executeTool(root, toolCall) {
  const name = toolCall.function.name;
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    return { error: `Invalid JSON arguments: ${e.message}` };
  }

  try {
    switch (name) {
      case 'read_file':
        return await readTextFile(root, args.path);
      case 'list_directory':
        const entries = await listDir(root, args.path);
        return JSON.stringify(entries.map(e => `${e.type === 'dir' ? '[DIR]' : '[FILE]'} ${e.name}`), null, 2);
      case 'write_file':
        await writeTextFile(root, args.path, args.content);
        return `Archivo ${args.path} guardado exitosamente.`;
      default:
        return { error: `Tool ${name} not found.` };
    }
  } catch (err) {
    return { error: `Execution failed: ${err.message}` };
  }
}
