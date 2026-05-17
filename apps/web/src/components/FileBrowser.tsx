/**
 * FileBrowser.tsx — Explorador tipo “grid” (Finder-style)
 *
 * Objetivo UX:
 * - Ver carpetas/archivos como íconos en una grilla
 * - Acciones sin fricción: Agregar (upload), Descargar, Eliminar
 * - Cada item tiene botón ⋯ con menú (Agregar/Descargar/Eliminar)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiDelete, apiGet } from '../lib/api';
import type { DirEntry } from '../lib/api';

function splitPath(p: string) {
  const clean = (p || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return clean ? clean.split('/') : [];
}

function joinPath(parts: string[]) {
  return parts.filter(Boolean).join('/');
}

function FolderIcon() {
  return (
    <div className="h-16 w-20 rounded-2xl bg-brand-200/80">
      <div className="h-5 w-10 rounded-tl-2xl rounded-tr-2xl bg-brand-400" />
    </div>
  );
}

function FileIcon() {
  return (
    <div className="h-16 w-14 rounded-xl border border-ink-200 bg-white">
      <div className="h-4 rounded-t-xl bg-ink-100" />
      <div className="p-2">
        <div className="h-2 w-8 rounded bg-ink-100" />
        <div className="mt-1 h-2 w-6 rounded bg-ink-100" />
      </div>
    </div>
  );
}

export function FileBrowser({
  projectId,
  refreshKey,
  onOpenFile,
}: {
  projectId: string;
  refreshKey: number;
  onOpenFile: (path: string) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [status, setStatus] = useState('');

  const [menuPath, setMenuPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetDirRef = useRef<string>('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const crumbs = useMemo(() => splitPath(cwd), [cwd]);

  async function load(dir: string) {
    const { entries } = await apiGet<{ entries: DirEntry[] }>(
      `/api/projects/${projectId}/tree?path=${encodeURIComponent(dir)}`
    );
    setEntries(entries);
  }

  useEffect(() => {
    load(cwd).catch((e: any) => setStatus(e?.message ?? String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, cwd, refreshKey]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setMenuPath(null);
    }
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  function startUpload(targetDir: string) {
    uploadTargetDirRef.current = targetDir;
    fileInputRef.current?.click();
  }

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    const form = new FormData();
    form.append('file', file);
    form.append('path', uploadTargetDirRef.current ?? '');

    try {
      setStatus('Subiendo…');
      const res = await fetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      setStatus('Subido ✅');
      await load(cwd);
    } catch (e: any) {
      setStatus(`Error al subir: ${e?.message ?? String(e)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDelete(path: string) {
    const ok = confirm(`Eliminar ${path}?`);
    if (!ok) return;
    try {
      setStatus('Eliminando…');
      await apiDelete(`/api/projects/${projectId}/file`, { path });
      setSelected(null);
      setStatus('Eliminado ✅');
      await load(cwd);
    } catch (e: any) {
      setStatus(`Error al eliminar: ${e?.message ?? String(e)}`);
    }
  }

  function handleDownload(path: string) {
    const url = `/api/projects/${projectId}/download?path=${encodeURIComponent(path)}`;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }

  const ordered = useMemo(() => {
    // folders first (like Finder)
    const dirs = entries.filter((e) => e.type === 'dir');
    const files = entries.filter((e) => e.type === 'file');
    return [...dirs, ...files];
  }, [entries]);

  const selectedIsFile = selected?.type === 'file';
  const selectedDirForAdd = selected?.type === 'dir' ? selected.path : cwd;

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 bg-white px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink-700">
          <button
            onClick={() => {
              setCwd('');
              setSelected(null);
            }}
            className="rounded-lg border border-ink-200 bg-white px-2 py-1 hover:bg-ink-50"
            title="Ir a raíz"
          >
            /
          </button>
          {crumbs.map((c, idx) => {
            const p = joinPath(crumbs.slice(0, idx + 1));
            return (
              <button
                key={p}
                onClick={() => {
                  setCwd(p);
                  setSelected(null);
                }}
                className="max-w-[200px] truncate rounded-lg border border-ink-200 bg-white px-2 py-1 hover:bg-ink-50"
                title={p}
              >
                {c}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => void handleUpload(e.target.files)} />

          <button
            onClick={() => startUpload(selectedDirForAdd)}
            className="rounded-xl bg-ink-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-800"
            title="Agregar archivo (subir)"
          >
            Agregar
          </button>

          <button
            disabled={!selectedIsFile}
            onClick={() => selected && handleDownload(selected.path)}
            className="rounded-xl border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-900 hover:bg-ink-50 disabled:opacity-50"
            title="Descargar"
          >
            Descargar
          </button>

          <button
            disabled={!selected}
            onClick={() => selected && void handleDelete(selected.path)}
            className="rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            title="Eliminar"
          >
            Eliminar
          </button>

          <div className="ml-2 text-[11px] text-ink-500">{status}</div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto bg-ink-50 p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {ordered.map((e) => {
            const isSelected = selected?.path === e.path;
            const isDir = e.type === 'dir';

            return (
              <div
                key={e.path}
                className={
                  'group relative rounded-2xl p-3 transition ' +
                  (isSelected ? 'bg-white shadow-sm ring-2 ring-brand-400/50' : 'hover:bg-white/70')
                }
                onClick={() => setSelected(e)}
                onDoubleClick={() => {
                  if (isDir) {
                    setCwd(e.path);
                    setSelected(null);
                  } else {
                    onOpenFile(e.path);
                  }
                }}
              >
                {/* menu */}
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setMenuPath((p) => (p === e.path ? null : e.path));
                  }}
                  className="absolute right-2 top-2 rounded-lg px-2 py-1 text-xs font-semibold text-ink-500 opacity-0 transition hover:text-ink-900 group-hover:opacity-100"
                  title="Opciones"
                >
                  ⋯
                </button>

                {menuPath === e.path ? (
                  <div className="absolute right-2 top-9 z-20 w-44 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg">
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        startUpload(isDir ? e.path : cwd);
                        setMenuPath(null);
                      }}
                      className="w-full px-3 py-2 text-left text-xs font-semibold text-ink-900 hover:bg-ink-50"
                    >
                      Agregar
                    </button>
                    <button
                      disabled={e.type !== 'file'}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (e.type === 'file') handleDownload(e.path);
                        setMenuPath(null);
                      }}
                      className="w-full px-3 py-2 text-left text-xs font-semibold text-ink-900 hover:bg-ink-50 disabled:opacity-50"
                    >
                      Descargar
                    </button>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void handleDelete(e.path);
                        setMenuPath(null);
                      }}
                      className="w-full px-3 py-2 text-left text-xs font-semibold text-red-700 hover:bg-red-50"
                    >
                      Eliminar
                    </button>
                  </div>
                ) : null}

                <div className="flex flex-col items-center gap-3">
                  {isDir ? <FolderIcon /> : <FileIcon />}
                  <div className="w-full truncate text-center text-xs font-semibold text-ink-800">
                    {e.name}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Helper */}
      <div className="border-t border-ink-200 bg-white px-4 py-2 text-[11px] text-ink-500">
        Tip: click = seleccionar • doble click = abrir carpeta/archivo • ⋯ = opciones
      </div>
    </div>
  );
}
