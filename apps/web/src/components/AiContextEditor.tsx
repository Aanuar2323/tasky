/**
 * AiContextEditor.tsx — Editor de capas de contexto (IA)
 *
 * Permite al usuario editar las capas:
 *  - Capa 1 (rol + orden)
 *  - Capa 2 (resumen general)
 *  - Capa 2 (resumen del área activa)
 *  - Capa 3 (QA)
 *  - Archivos .md del área (crear/editar/eliminar)
 */

import { useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import type { DirEntry } from '../lib/api';

export function AiContextEditor({
  projectId,
  areaId,
}: {
  projectId: string;
  areaId: string;
}) {
  const baseDocs = useMemo(
    () => [
      { label: 'Capa 1 — Rol y orden', path: 'ai/layer1/00-role-and-flow.md' },
      { label: 'Capa 2 — Resumen general', path: 'ai/layer2/summary.md' },
      { label: `Capa 2 — Resumen área (${areaId})`, path: `ai/layer2/areas/${areaId}/summary.md` },
      { label: 'Capa 3 — QA/Testing', path: 'ai/layer3/qa.md' },
    ],
    [areaId]
  );

  const [areaFiles, setAreaFiles] = useState<DirEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState(baseDocs[0].path);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');

  async function loadAreaFiles() {
    const { entries } = await apiGet<{ entries: DirEntry[] }>(
      `/api/projects/${projectId}/tree?path=${encodeURIComponent(`ai/layer2/areas/${areaId}`)}`
    );
    const files = entries.filter(
      (e) => e.type === 'file' && e.name.toLowerCase().endsWith('.md') && e.name !== 'summary.md'
    );
    setAreaFiles(files);
  }

  useEffect(() => {
    loadAreaFiles().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, areaId]);

  useEffect(() => {
    (async () => {
      const { content } = await apiGet<{ content: string }>(
        `/api/projects/${projectId}/file?path=${encodeURIComponent(selectedPath)}`
      );
      setContent(content ?? '');
      setStatus('');
    })().catch((e: any) => setStatus(e?.message ?? String(e)));
  }, [projectId, selectedPath]);

  async function save() {
    setStatus('Guardando…');
    try {
      await apiPost(`/api/projects/${projectId}/file`, { path: selectedPath, content });
      setStatus('Guardado ✅');
      await loadAreaFiles();
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  async function createAreaDoc() {
    const name = prompt('Nombre del archivo (.md):', 'nota.md');
    if (!name) return;
    const fileName = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`;
    const path = `ai/layer2/areas/${areaId}/${fileName}`;
    await apiPost(`/api/projects/${projectId}/file`, { path, content: `# ${fileName}\n` });
    await loadAreaFiles();
    setSelectedPath(path);
  }

  async function deleteSelected() {
    if (baseDocs.some((d) => d.path === selectedPath)) return;
    const ok = confirm(`Eliminar ${selectedPath}?`);
    if (!ok) return;
    await apiDelete(`/api/projects/${projectId}/file`, { path: selectedPath });
    await loadAreaFiles();
    setSelectedPath(baseDocs[0].path);
  }

  const allOptions = [
    ...baseDocs.map((d) => ({ label: d.label, path: d.path })),
    ...areaFiles.map((f) => ({ label: `Área: ${f.name}`, path: f.path })),
  ];

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="ui-panel flex flex-wrap items-center gap-2 px-4 py-4">
          <select
            value={selectedPath}
            onChange={(e) => setSelectedPath(e.target.value)}
            className="ui-select min-w-[18rem] flex-1 text-sm font-semibold"
          >
            {allOptions.map((o) => (
              <option key={o.path} value={o.path}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            onClick={() => void save()}
            className="ui-button ui-button--primary"
          >
            Guardar
          </button>

          <button
            onClick={() => void createAreaDoc()}
            className="ui-button ui-button--secondary"
          >
            + Archivo área
          </button>

          <button
            disabled={baseDocs.some((d) => d.path === selectedPath)}
            onClick={() => void deleteSelected()}
            className="ui-button ui-button--danger disabled:opacity-50"
          >
            Eliminar
          </button>

          <div className="text-xs text-[color:var(--ui-muted)]">{status}</div>
        </div>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="ui-textarea h-[60vh] w-full p-4 text-sm leading-6"
        />
      </div>
    </div>
  );
}
