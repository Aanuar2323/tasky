"use client";

import { useEffect, useRef, useState } from "react";
import type { Area } from "@/app/lib/api";

interface SidebarProps {
  collapsed: boolean;
  areas: Area[];
  activeAreaId: string;
  onSelectArea: (id: string) => void;
  onOpenPanel: (areaId: string, tab: "info" | "historial" | "reglas") => void;
  onAddArea: () => void;
  onRenameArea: (areaId: string, name: string) => void | Promise<void>;
  onDeleteArea: (areaId: string) => void | Promise<void>;
}

const INFO_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <circle cx="6" cy="6" r="4.5" />
    <path d="M6 5.2v3M6 3.7v.1" strokeLinecap="round" />
  </svg>
);

const HIST_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <circle cx="6" cy="6" r="4.5" />
    <path d="M6 3.5v2.7l1.6 1" strokeLinecap="round" />
  </svg>
);

const RULES_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M3 2h4l2 2v6H3V2z" strokeLinejoin="round" />
    <path d="M4.5 6h3M4.5 7.5h2" strokeLinecap="round" />
  </svg>
);

const HOME_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M2 6l4-4 4 4v5H2V6z" strokeLinejoin="round" />
  </svg>
);

const RENAME_SVG = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d="M2 12h4l6.5-6.5a1.5 1.5 0 0 0-2-2L4 10v2z" strokeLinejoin="round" />
    <path d="M8.5 4l2 2" strokeLinecap="round" />
  </svg>
);

const DELETE_SVG = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d="M3 4h8M5.5 4V3a.5.5 0 0 1 .5-.5h2A.5.5 0 0 1 8.5 3v1M4 4l.5 7h5L10 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface ContextMenuState {
  areaId: string;
  areaName: string;
  x: number;
  y: number;
}

function AreaMark({ area }: { area: Area }) {
  const initial = area.name.charAt(0).toUpperCase();
  return (
    <div className="area-mark">
      {area.name === "General" ? HOME_SVG : initial}
    </div>
  );
}

export default function Sidebar({
  collapsed,
  areas,
  activeAreaId,
  onSelectArea,
  onOpenPanel,
  onAddArea,
  onRenameArea,
  onDeleteArea,
}: SidebarProps) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [confirmArea, setConfirmArea] = useState<Area | null>(null);
  const [deleting, setDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setCtxMenu(null);
        setConfirmArea(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const handleRename = (area: Area) => {
    setCtxMenu(null);
    const name = window.prompt("Nuevo nombre del área", area.name);
    if (!name || !name.trim() || name.trim() === area.name) return;
    void onRenameArea(area.id, name.trim());
  };

  const handleAskDelete = (area: Area) => {
    setCtxMenu(null);
    setConfirmArea(area);
  };

  const handleConfirmDelete = async () => {
    if (!confirmArea) return;
    setDeleting(true);
    try {
      await onDeleteArea(confirmArea.id);
    } catch (err) {
      console.error("Delete area failed:", err);
    } finally {
      setDeleting(false);
      setConfirmArea(null);
    }
  };

  return (
    <aside className="sidebar" style={{ width: collapsed ? 48 : 200 }}>
      <div className="sb-head">
        <span className="label">Áreas</span>
        <button
          className="add-area"
          data-tip="Nueva área"
          aria-label="Nueva área"
          onClick={onAddArea}
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor">
            <path d="M7 2v10M2 7h10" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="area-list">
        {areas.map((area) => (
          <div
            key={area.id}
            className="area-row"
            aria-current={area.id === activeAreaId ? "true" : undefined}
            data-name={area.name}
            onClick={() => onSelectArea(area.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({
                areaId: area.id,
                areaName: area.name,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          >
            <AreaMark area={area} />
            {!collapsed && <span className="area-name">{area.name}</span>}
            {!collapsed && (
              <div className="area-actions">
                <button
                  className="mini-btn"
                  data-tip="Información"
                  aria-label="Información"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPanel(area.id, "info");
                  }}
                >
                  {INFO_SVG}
                </button>
                <button
                  className="mini-btn"
                  data-tip="Historial"
                  aria-label="Historial"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPanel(area.id, "historial");
                  }}
                >
                  {HIST_SVG}
                </button>
                <button
                  className="mini-btn"
                  data-tip="Reglas"
                  aria-label="Reglas"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPanel(area.id, "reglas");
                  }}
                >
                  {RULES_SVG}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="sb-foot">
        <span className="foot-icon">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 4.2v3M7 8.6v.1" strokeLinecap="round" />
          </svg>
        </span>
      </div>

      {ctxMenu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{
            position: "fixed",
            left: Math.min(ctxMenu.x, window.innerWidth - 170),
            top: Math.min(ctxMenu.y, window.innerHeight - 110),
          }}
          role="menu"
        >
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              const area = areas.find((a) => a.id === ctxMenu.areaId);
              if (area) handleRename(area);
            }}
          >
            <span className="ctx-item-icon">{RENAME_SVG}</span>
            Renombrar
          </button>
          <button
            className="ctx-item ctx-item-danger"
            role="menuitem"
            onClick={() => {
              const area = areas.find((a) => a.id === ctxMenu.areaId);
              if (area) handleAskDelete(area);
            }}
          >
            <span className="ctx-item-icon">{DELETE_SVG}</span>
            Eliminar
          </button>
        </div>
      )}

      {confirmArea && (
        <div
          className="ctx-confirm-overlay"
          onClick={() => !deleting && setConfirmArea(null)}
        >
          <div
            className="ctx-confirm"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirmar eliminación de área"
          >
            <div className="ctx-confirm-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path
                  d="M12 3.5l9 16H3l9-16z"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                />
                <path
                  d="M12 9.5v4M12 16.5v.1"
                  strokeLinecap="round"
                  strokeWidth="1.8"
                />
              </svg>
            </div>
            <h3 className="ctx-confirm-title">¿Eliminar área?</h3>
            <p className="ctx-confirm-body">
              Estás por eliminar <strong>{confirmArea.name}</strong> con todos
              sus chats, historial, reglas y archivos de contexto asociados.
              Esta acción no se puede deshacer.
            </p>
            <div className="ctx-confirm-actions">
              <button
                className="ctx-btn ctx-btn-secondary"
                onClick={() => setConfirmArea(null)}
                disabled={deleting}
              >
                Cancelar
              </button>
              <button
                className="ctx-btn ctx-btn-danger"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? "Eliminando..." : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
