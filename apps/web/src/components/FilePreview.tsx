/**
 * FilePreview.tsx — Vista previa de archivos
 *
 * Muestra el contenido de un archivo de texto del proyecto
 * en formato de solo lectura. Se usa cuando el usuario abre
 * un archivo que NO es una tarea (las tareas se muestran en el Chat).
 *
 * Flujo:
 *  1. Al montar o cambiar la ruta, carga el contenido del archivo
 *     desde GET /api/projects/:id/file?path=<ruta>
 *  2. Muestra el contenido en un bloque <pre> con formato preservado
 *  3. Si hay error (archivo no encontrado, etc.), lo muestra en rojo
 */

import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

export function FilePreview({
  projectId,   // ID del proyecto
  path,        // Ruta relativa del archivo a previsualizar
}: {
  projectId: string;
  path: string;
}) {
  /** Contenido de texto del archivo */
  const [content, setContent] = useState<string>('');

  /** Mensaje de error si la carga falla */
  const [err, setErr] = useState<string>('');

  /* ── Cargar contenido del archivo ───────────────────────── */

  /**
   * Cada vez que cambia el proyecto o la ruta del archivo,
   * hace una petición GET para obtener el contenido.
   */
  useEffect(() => {
    (async () => {
      const res = await apiGet<{ content: string }>(
        `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`
      );
      setContent(res.content);
      setErr('');
    })().catch((e: any) => {
      setErr(e?.message ?? String(e));
      setContent('');
    });
  }, [projectId, path]);

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="flex h-full flex-col">
      {/* Barra superior con la ruta del archivo */}
      <div className="border-b border-[color:var(--ui-line)] bg-white/75 px-4 py-3 text-xs text-[color:var(--ui-muted)] backdrop-blur">
        Preview: <span className="font-mono text-[color:var(--ui-text)]">{path}</span>
      </div>

      {/* Contenido del archivo o mensaje de error */}
      <div className="flex-1 overflow-auto p-4">
        {err ? (
          <div className="ui-panel p-4 text-sm text-[color:var(--ui-danger)]">
            {err}
          </div>
        ) : (
          <div className="ui-preview-frame">
            <pre className="whitespace-pre-wrap p-4 text-sm leading-6 text-[color:var(--ui-text)]">
              {content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
