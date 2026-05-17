/**
 * FileExplorer.tsx — Explorador de archivos en árbol
 *
 * Muestra la estructura de archivos y carpetas del proyecto
 * como un árbol colapsable. El usuario puede:
 *  - Expandir/cerrar carpetas (clic en la carpeta)
 *  - Abrir archivos (clic en el archivo) para verlos en Preview o Chat
 *
 * Funcionamiento:
 *  - Al montar, carga el contenido de la raíz del proyecto
 *  - Al expandir una carpeta, carga sus contenidos bajo demanda
 *  - Los contenidos se cachean para no repetir peticiones
 *  - refreshKey fuerza recarga completa (se usa al crear/completar tareas)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiDelete, apiGet } from '../lib/api';
import type { DirEntry } from '../lib/api';

/* ==========================================================
   Subcomponentes de fila
   ========================================================== */

/**
 * Fila que representa una carpeta en el árbol.
 * Al hacer clic, expande o cierra la carpeta.
 */
function FolderRow({
  entry,
  depth,
  expanded,
  selected,
  onToggle,
}: {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm transition hover-lift"
      style={{
        paddingLeft: 12 + depth * 14,
        background: selected ? 'oklch(65% 0.08 195 / 0.08)' : 'transparent',
        color: 'var(--ui-text)',
        fontFamily: 'var(--font-body)',
      }}
    >
      <span className="w-4 text-[color:var(--ui-accent)]" style={{ transition: 'transform 0.3s ease' }}>
        {expanded ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        )}
      </span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--ui-accent)' }}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span className="font-medium" style={{ fontWeight: 500 }}>{entry.name}</span>
    </button>
  );
}

/**
 * Fila que representa un archivo en el árbol.
 * Al hacer clic, se selecciona y se abre (Preview o Chat según el tipo).
 */
function FileRow({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: DirEntry;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm transition hover-lift"
      style={{
        paddingLeft: 12 + depth * 14,
        background: selected ? 'oklch(65% 0.08 195 / 0.08)' : 'transparent',
        color: 'var(--ui-text)',
        fontFamily: 'var(--font-body)',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--ui-muted)' }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span style={{ color: selected ? 'var(--ui-accent)' : 'var(--ui-text-soft)' }}>{entry.name}</span>
    </button>
  );
}

/* ==========================================================
   Componente principal: FileExplorer
   ========================================================== */

export function FileExplorer({
  projectId,     // ID del proyecto a explorar
  refreshKey,    // Clave para forzar recarga (cambia al crear/completar tareas)
  onOpenFile,    // Callback al abrir un archivo (pasa la ruta relativa)
}: {
  projectId: string;
  refreshKey: number;
  onOpenFile: (path: string) => void;
}) {
  /* ── Estado ─────────────────────────────────────────────── */

  /** Registro de carpetas expandidas: { ruta: true/false } */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': true });

  /** Cache de entradas por directorio: { ruta: DirEntry[] } */
  const [cache, setCache] = useState<Record<string, DirEntry[]>>({});

  /** Ruta del archivo actualmente seleccionado */
  const [selected, setSelected] = useState<{ path: string; type: 'dir' | 'file' } | null>(null);
  const [currentDir, setCurrentDir] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** Raíces a renderizar (MVP: solo la raíz del proyecto) */
  const rootsToRender = useMemo(() => [''], []);

  /* ── Carga inicial: contenido de la raíz ─────────────────── */

  useEffect(() => {
    (async () => {
      const { entries } = await apiGet<{ entries: DirEntry[] }>(
        `/api/projects/${projectId}/tree?path=`
      );
      setCache((c) => ({ ...c, '': entries }));
    })().catch(console.error);
  }, [projectId, refreshKey]);

  async function reloadDir(dirPath: string) {
    const { entries } = await apiGet<{ entries: DirEntry[] }>(
      `/api/projects/${projectId}/tree?path=${encodeURIComponent(dirPath)}`
    );
    setCache((c) => ({ ...c, [dirPath]: entries }));
  }


  /* ── Expandir/cerrar carpeta ────────────────────────────── */

  /**
   * Al expandir una carpeta:
   *  1. Marca la carpeta como expandida en el estado
   *  2. Si no está en cache, carga sus contenidos desde el backend
   */
  async function toggleDir(dirPath: string) {
    const next = !expanded[dirPath];
    setExpanded((e) => ({ ...e, [dirPath]: next }));
    setSelected({ path: dirPath, type: 'dir' });
    setCurrentDir(dirPath);
    if (next && !cache[dirPath]) {
      const { entries } = await apiGet<{ entries: DirEntry[] }>(
        `/api/projects/${projectId}/tree?path=${encodeURIComponent(dirPath)}`
      );
      setCache((c) => ({ ...c, [dirPath]: entries }));
    }
  }


  /* ── Renderizado recursivo del árbol ────────────────────── */

  /**
   * Renderiza las entradas de un directorio recursivamente.
   * Las carpetas se muestran con flecha de expansión y se pueden abrir.
   * Los archivos se muestran con viñeta y al hacer clic se abren.
   */
  function renderEntries(dirPath: string, depth: number) {
    const entries = cache[dirPath] ?? [];
    return entries.map((e) => {
      if (e.type === 'dir') {
        const isOpen = !!expanded[e.path];
        return (
          <div key={e.path}>
            <FolderRow
              entry={e}
              depth={depth}
              expanded={isOpen}
              selected={selected?.path === e.path}
              onToggle={() => toggleDir(e.path)}
            />
            {/* Renderizar contenidos de la carpeta si está expandida */}
            {isOpen ? <div>{renderEntries(e.path, depth + 1)}</div> : null}
          </div>
        );
      }
      return (
        <FileRow
          key={e.path}
          entry={e}
          depth={depth}
          selected={selected?.path === e.path}
          onSelect={() => {
            setSelected({ path: e.path, type: 'file' });
            setCurrentDir(e.path.split('/').slice(0, -1).join('/'));
            onOpenFile(e.path);
          }}
        />
      );
    });
  }

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    const form = new FormData();
    form.append('file', file);
    form.append('path', currentDir ?? '');
    try {
      setStatus('Subiendo…');
      const res = await fetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      await reloadDir(currentDir ?? '');
      await reloadDir('');
      setStatus('Subido ✅');
    } catch (e: any) {
      setStatus(`Error al subir: ${e?.message ?? String(e)}`);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    const ok = confirm(`Eliminar ${selected.path}?`);
    if (!ok) return;
    try {
      setStatus('Eliminando…');
      await apiDelete(`/api/projects/${projectId}/file`, { path: selected.path });
      await reloadDir(currentDir ?? '');
      await reloadDir('');
      setSelected(null);
      setStatus('Eliminado ✅');
    } catch (e: any) {
      setStatus(`Error al eliminar: ${e?.message ?? String(e)}`);
    }
  }

  function handleDownload() {
    if (!selected || selected.type !== 'file') return;
    const url = `/api/projects/${projectId}/download?path=${encodeURIComponent(selected.path)}`;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }

  {/* ── Render ─────────────────────────────────────────────── */}

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--ui-line)', background: 'oklch(100% 0 0 / 0.7)' }}
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-[color:var(--ui-muted)]" style={{ fontFamily: 'var(--font-body)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>{currentDir || '/'}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="ui-button ui-button--secondary"
            style={{ minHeight: '2rem', padding: '0.4rem 0.8rem', fontSize: '0.72rem' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Subir
          </button>
          <button
            disabled={!selected || selected.type !== 'file'}
            onClick={handleDownload}
            className="ui-button ui-button--secondary disabled:opacity-50"
            style={{ minHeight: '2rem', padding: '0.4rem 0.8rem', fontSize: '0.72rem' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Descargar
          </button>
          <button
            disabled={!selected}
            onClick={() => void handleDelete()}
            className="ui-button ui-button--danger disabled:opacity-50"
            style={{ minHeight: '2rem', padding: '0.4rem 0.8rem', fontSize: '0.72rem' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Eliminar
          </button>
          <div className="ml-2 text-[11px] text-[color:var(--ui-muted)]">{status}</div>
        </div>
      </div>

      <div className="h-full overflow-auto p-3">
        <div className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-widest text-[color:var(--ui-muted)]" style={{ fontFamily: 'var(--font-body)' }}>
          Explorador
        </div>
        {rootsToRender.map((root) => (
          <div key={root}>{renderEntries(root, 0)}</div>
        ))}
      </div>
    </div>
  );
}
