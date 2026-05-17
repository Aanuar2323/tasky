/**
 * SectionFilesGrid.tsx — Grid de archivos para una carpeta fija
 *
 * No permite navegar carpetas. Solo muestra el contenido de una ruta fija
 * y ofrece acciones directas: Agregar, Descargar, Eliminar.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiDelete, apiGet } from '../lib/api';
import type { DirEntry } from '../lib/api';

function FolderIcon() {
  return (
    <div className="h-16 w-20 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(65% 0.08 195 / 0.12)' }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--ui-accent)' }}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    </div>
  );
}

function FileIcon() {
  return (
    <div className="h-16 w-14 rounded-xl border flex flex-col items-center justify-center gap-1" style={{ borderColor: 'var(--ui-line)', background: 'oklch(100% 0 0 / 0.8)' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--ui-muted)' }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    </div>
  );
}

export function SectionFilesGrid({
  projectId,
  rootPath,
  title,
  description,
}: {
  projectId: string;
  rootPath: string;
  title: string;
  description: string;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  async function load() {
    const { entries } = await apiGet<{ entries: DirEntry[] }>(
      `/api/projects/${projectId}/tree?path=${encodeURIComponent(rootPath)}`
    );
    setEntries(entries);
  }

  useEffect(() => {
    load().catch((e: any) => setStatus(e?.message ?? String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rootPath]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setMenuPath(null);
    }
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const ordered = useMemo(() => {
    const dirs = entries.filter((e) => e.type === 'dir');
    const files = entries.filter((e) => e.type === 'file');
    return [...dirs, ...files];
  }, [entries]);

  async function upload(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    const form = new FormData();
    form.append('file', file);
    form.append('path', rootPath);
    try {
      setStatus('Subiendo…');
      const res = await fetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      setStatus('Subido ✅');
      await load();
    } catch (e: any) {
      setStatus(`Error al subir: ${e?.message ?? String(e)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function startUpload() {
    fileInputRef.current?.click();
  }

  function download(path: string) {
    const a = document.createElement('a');
    a.href = `/api/projects/${projectId}/download?path=${encodeURIComponent(path)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }

  async function remove(path: string) {
    const ok = confirm(`Eliminar ${path}?`);
    if (!ok) return;
    try {
      setStatus('Eliminando…');
      await apiDelete(`/api/projects/${projectId}/file`, { path });
      setSelected(null);
      setStatus('Eliminado ✅');
      await load();
    } catch (e: any) {
      setStatus(`Error al eliminar: ${e?.message ?? String(e)}`);
    }
  }

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--ui-line)', background: 'oklch(100% 0 0 / 0.6)', backdropFilter: 'blur(12px)' }}>
        <div>
          <div className="text-sm font-semibold text-[color:var(--ui-text)]" style={{ fontFamily: 'var(--font-body)' }}>{title}</div>
          <div className="text-xs text-[color:var(--ui-muted)]">{description}</div>
        </div>

        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => void upload(e.target.files)} />
          <button onClick={startUpload} className="ui-button ui-button--primary">Agregar</button>
          <button
            disabled={!selected || selected.type !== 'file'}
            onClick={() => selected?.type === 'file' && download(selected.path)}
            className="ui-button ui-button--secondary disabled:opacity-50"
          >
            Descargar
          </button>
          <button
            disabled={!selected}
            onClick={() => selected && void remove(selected.path)}
            className="ui-button ui-button--danger disabled:opacity-50"
          >
            Eliminar
          </button>
          <div className="ml-2 text-[11px] text-[color:var(--ui-muted)]">{status}</div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4" style={{ background: 'oklch(98% 0.005 240 / 0.5)' }}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {ordered.map((e) => {
            const isSelected = selected?.path === e.path;
            const isDir = e.type === 'dir';
            return (
              <div
                key={e.path}
                className="group relative rounded-[22px] p-3 transition hover-lift ui-file-tile"
                style={isSelected ? { borderColor: 'oklch(65% 0.12 195 / 0.5)', background: 'oklch(100% 0 0 / 0.95)' } : {}}
                onClick={() => setSelected(e)}
              >
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setMenuPath((p) => (p === e.path ? null : e.path));
                  }}
                  className="absolute right-2 top-2 rounded-lg px-2 py-1 text-xs font-semibold opacity-0 transition hover:text-[color:var(--ui-text)] group-hover:opacity-100"
                  style={{ background: 'oklch(100% 0 0 / 0.9)', color: 'var(--ui-muted)' }}
                  title="Opciones"
                >
                  ⋯
                </button>

                {menuPath === e.path ? (
                  <div className="ui-menu absolute right-2 top-9 z-20 w-44 overflow-hidden">
                    <button
                      onClick={(ev) => { ev.stopPropagation(); startUpload(); setMenuPath(null); }}
                      className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]"
                    >
                      Agregar
                    </button>
                    <button
                      disabled={e.type !== 'file'}
                      onClick={(ev) => { ev.stopPropagation(); if (e.type === 'file') download(e.path); setMenuPath(null); }}
                      className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)] disabled:opacity-50"
                    >
                      Descargar
                    </button>
                    <button
                      onClick={(ev) => { ev.stopPropagation(); void remove(e.path); setMenuPath(null); }}
                      className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-danger)] hover:bg-[#fff0ec]"
                    >
                      Eliminar
                    </button>
                  </div>
                ) : null}

                <div className="flex flex-col items-center gap-3">
                  {isDir ? <FolderIcon /> : <FileIcon />}
                  <div className="w-full truncate text-center text-xs font-semibold text-[color:var(--ui-text)]">
                    {e.name}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
