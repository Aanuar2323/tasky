"use client";

import type { Area } from "@/app/lib/api";

interface SidebarProps {
  collapsed: boolean;
  areas: Area[];
  activeAreaId: string;
  onSelectArea: (id: string) => void;
  onOpenPanel: (areaId: string, tab: "info" | "historial" | "reglas") => void;
  onAddArea: () => void;
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
}: SidebarProps) {
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
    </aside>
  );
}
