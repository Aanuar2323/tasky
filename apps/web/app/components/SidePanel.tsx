"use client";

import { useState, useEffect, useCallback } from "react";
import type { Area, TreeEntry } from "@/app/lib/api";
import { downloadFile } from "@/app/lib/api";
import { parseRulesMarkdown, rulesToMarkdown } from "@/app/lib/rules-parser";

interface SidePanelProps {
  open: boolean;
  tab: "info" | "historial" | "reglas";
  area: Area | null;
  projectId: string;
  treeEntries: TreeEntry[];
  generatedHistory: unknown;
  rulesContent: string;
  onChangeTab: (tab: "info" | "historial" | "reglas") => void;
  onClose: () => void;
  onUpdateRules: (markdown: string) => Promise<void>;
  onRefreshInfo: () => Promise<void>;
  onUploadContextFile: () => Promise<void>;
  onDeleteContextFile: (path: string) => Promise<void>;
}

interface FileEntry {
  name: string;
  meta: string;
  type: string;
  path?: string;
}

interface HistoryGroup {
  date: string;
  days: number;
  items: { title: string; time: string; meta: string }[];
}

interface Rule {
  name: string;
  desc: string;
  tags: string[];
  enabled: boolean;
}

const HIDDEN_FILES = new Set([
  "rules(ajkwygebfickuvaulwakfjbscfa).md",
  "summary(ajkwygebfickuvaulwakfjbscfa).md",
]);

const FILE_ICON_DOC = (
  <svg viewBox="0 0 13 13" fill="none" stroke="currentColor">
    <path d="M3 1.5h4l2 2v7.5H3V1.5z" strokeLinejoin="round" />
    <path d="M5 6.5h3M5 8h2" strokeLinecap="round" />
  </svg>
);

const FILE_ICON_PDF = (
  <svg viewBox="0 0 13 13" fill="none" stroke="currentColor">
    <path d="M3 1.5h4l2 2v7.5H3V1.5z" strokeLinejoin="round" />
    <path d="M7 3.5v-2l2 2h-2z" strokeLinejoin="round" />
  </svg>
);

const FILE_ICON_TABLE = (
  <svg viewBox="0 0 13 13" fill="none" stroke="currentColor">
    <rect x="2.5" y="2.5" width="8" height="8" rx="1" />
    <path d="M2.5 5.5h8M2.5 8.5h8M5.5 2.5v8M8.5 2.5v8" strokeLinecap="round" />
  </svg>
);

const FILE_ICON_MD = (
  <svg viewBox="0 0 13 13" fill="none" stroke="currentColor">
    <path d="M3 2.5h7v8H3v-8z" strokeLinejoin="round" />
    <path d="M5 5v3M5 5l1.5 1.5M6.5 6.5L8 5M8 5v3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ICON_CHAT = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M2 3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H5l-2 2v-2H3a1 1 0 0 1-1-1V3.5z" strokeLinejoin="round" />
  </svg>
);

const ICON_EMPTY = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M5 4h11l3 3v13H5V4z" strokeLinejoin="round" />
    <path d="M9 11h6M9 14h4" strokeLinecap="round" />
  </svg>
);

const ADD_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M6 2v8M2 6h8" strokeLinecap="round" />
  </svg>
);

const DOWNLOAD_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M6 1.5v6M3.5 5L6 7.5 8.5 5M2 10h8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const DELETE_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M3 3h6M4.5 3V2a.5.5 0 0 1 .5-.5h2A.5.5 0 0 1 7.5 2v1M5 5.5v3M7 5.5v3M3.5 3l.5 6.5h4l.5-6.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function fileIcon(type: string) {
  if (type === "pdf") return FILE_ICON_PDF;
  if (type === "csv") return FILE_ICON_TABLE;
  if (type === "md") return FILE_ICON_MD;
  return FILE_ICON_DOC;
}

function fileTypeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv" || ext === "xlsx") return "csv";
  if (ext === "md" || ext === "markdown") return "md";
  return "docx";
}

function fileTypeFromTreeEntry(type: string): string {
  if (type === "pdf") return "pdf";
  if (type === "csv" || type === "tsv" || type === "xlsx") return "csv";
  if (type === "md" || type === "markdown") return "md";
  return "docx";
}

type FilterKey = "recent" | "week" | "month" | "all";

export default function SidePanel({
  open,
  tab,
  area,
  projectId,
  treeEntries,
  generatedHistory,
  rulesContent,
  onChangeTab,
  onClose,
  onUpdateRules,
  onRefreshInfo,
  onUploadContextFile,
  onDeleteContextFile,
}: SidePanelProps) {
  const [filter, setFilter] = useState<FilterKey>("recent");
  const [rules, setRules] = useState<Rule[]>([]);
  const [menuOpenIdx, setMenuOpenIdx] = useState<number | null>(null);
  const [fileMenuIdx, setFileMenuIdx] = useState<number | null>(null);

  const files: FileEntry[] = treeEntries
    .filter((e) => e.type === "file" && !HIDDEN_FILES.has(e.name))
    .map((e) => ({
      name: e.name,
      meta: fileTypeFromTreeEntry(e.type).toUpperCase(),
      type: fileTypeFromName(e.name),
      path: e.path,
    }));

  useEffect(() => {
    setRules(parseRulesMarkdown(rulesContent));
  }, [rulesContent]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const toggleRule = async (idx: number) => {
    const nextRules = rules.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r));
    setRules(nextRules);
    await onUpdateRules(rulesToMarkdown(nextRules));
  };

  const handleAddRule = async () => {
    const name = window.prompt("Nombre de la regla");
    if (!name?.trim()) return;
    const desc = window.prompt("Descripcion corta", "") ?? "";
    const nextRules = [
      ...rules,
      { name: name.trim(), desc: desc.trim(), tags: ["manual"], enabled: true },
    ];
    setRules(nextRules);
    await onUpdateRules(rulesToMarkdown(nextRules));
  };

  const handleEditRule = async (idx: number) => {
    const rule = rules[idx];
    const name = window.prompt("Nombre de la regla", rule.name);
    if (!name?.trim()) return;
    const desc = window.prompt("Descripcion corta", rule.desc) ?? "";
    const nextRules = rules.map((r, i) =>
      i === idx ? { ...r, name: name.trim(), desc: desc.trim() } : r
    );
    setRules(nextRules);
    await onUpdateRules(rulesToMarkdown(nextRules));
  };

  const handleDeleteRule = async (idx: number) => {
    const nextRules = rules.filter((_, i) => i !== idx);
    setRules(nextRules);
    await onUpdateRules(rulesToMarkdown(nextRules));
  };

  const downloadFileEntry = useCallback(async (entry: FileEntry) => {
    if (!projectId || !entry.path) return;
    try {
      const blob = await downloadFile(projectId, entry.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("File download failed:", err);
    }
  }, [projectId]);

  const handleDownloadContext = useCallback(async () => {
    if (!projectId || files.length === 0) return;
    await downloadFileEntry(files[0]);
  }, [projectId, files, downloadFileEntry]);

  const deleteFileEntry = useCallback(async (entry: FileEntry) => {
    if (!entry.path) return;
    await onDeleteContextFile(entry.path);
    await onRefreshInfo();
  }, [onDeleteContextFile, onRefreshInfo]);

  const historyGroups: HistoryGroup[] = Array.isArray(generatedHistory)
    ? (generatedHistory as HistoryGroup[])
    : [];

  const totalHistory = historyGroups.reduce(
    (n, g) => n + g.items.length,
    0
  );

  const filteredHistory = historyGroups.filter((g) => {
    if (filter === "week") return g.days <= 7;
    if (filter === "month") return g.days <= 30;
    return true;
  });

  const areaName = area?.name || "";

  const tabLabel =
    tab === "info"
      ? "Info"
      : tab === "historial"
        ? "Historial"
        : "Reglas";

  return (
    <>
      <div
        className="sp-backdrop"
        style={open ? { opacity: 1, pointerEvents: "auto" } : undefined}
        onClick={onClose}
      />
      <aside
        className="side-panel"
        aria-hidden={!open}
        aria-label="Panel de área"
        style={open ? { transform: "translateX(0)" } : undefined}
      >
        <div className="sp-head">
          <div className="sp-title">
            <span className="sp-eyebrow">Panel · {tabLabel}</span>
            <span className="sp-name">{areaName}</span>
          </div>
          <button
            className="icon-btn"
            data-tip="Cerrar"
            aria-label="Cerrar panel"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="sp-tabs" role="tablist">
          <button
            className="sp-tab"
            role="tab"
            aria-selected={tab === "info" ? "true" : "false"}
            onClick={() => onChangeTab("info")}
          >
            Info
          </button>
          <button
            className="sp-tab"
            role="tab"
            aria-selected={tab === "historial" ? "true" : "false"}
            onClick={() => onChangeTab("historial")}
          >
            Historial{" "}
            <span className="sp-tab-count">{totalHistory}</span>
          </button>
          <button
            className="sp-tab"
            role="tab"
            aria-selected={tab === "reglas" ? "true" : "false"}
            onClick={() => onChangeTab("reglas")}
          >
            Reglas{" "}
            <span className="sp-tab-count">{rules.length}</span>
          </button>
        </div>

        <div className="sp-body">
          {/* INFO TAB */}
          <div
            className="sp-pane"
            aria-current={tab === "info" ? "true" : "false"}
          >
           
            <div className="sp-card">
              <div className="sp-card-eyebrow">Contexto del área</div>
              <p
                style={{
                  font: "400 12px/1.5 var(--font)",
                  color: "var(--muted)",
                  marginBottom: 6,
                }}
              >
                Agregar, descargar o eliminar archivos de contexto del área
                activa.
              </p>
              <div className="sp-card-actions">
                <button className="sp-act" data-tone="primary" onClick={() => void onUploadContextFile()}>
                  {ADD_SVG} Agregar
                </button>
              </div>

              {files.length === 0 ? (
                <div className="sp-empty">
                  {ICON_EMPTY}
                  Esta área no tiene archivos de contexto todavía.
                </div>
              ) : (
                files.map((f, i) => (
                  <div key={i} className="file-row" data-type={f.type}>
                    <div className="fr-icon">{fileIcon(f.type)}</div>
                    <div className="fr-body">
                      <div className="fr-name">{f.name}</div>
                      <div className="fr-meta">{f.meta}</div>
                    </div>
                    <div className="fr-kebab-wrap">
                      <button
                        className="fr-kebab"
                        aria-label="Más opciones"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFileMenuIdx(fileMenuIdx === i ? null : i);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="7" cy="2.5" r="1.3" fill="currentColor" />
                          <circle cx="7" cy="7" r="1.3" fill="currentColor" />
                          <circle cx="7" cy="11.5" r="1.3" fill="currentColor" />
                        </svg>
                      </button>
                      {fileMenuIdx === i && (
                        <>
                          <div
                            className="fr-menu-backdrop"
                            onClick={() => setFileMenuIdx(null)}
                          />
                          <div className="fr-menu" role="menu">
                            <button
                              className="fr-menu-item"
                              role="menuitem"
                              onClick={() => {
                                setFileMenuIdx(null);
                                void downloadFileEntry(f);
                              }}
                            >
                              <span className="fr-menu-icon">{DOWNLOAD_SVG}</span>
                              Descargar
                            </button>
                            <button
                              className="fr-menu-item fr-menu-item-danger"
                              role="menuitem"
                              onClick={() => {
                                setFileMenuIdx(null);
                                void deleteFileEntry(f);
                              }}
                            >
                              <span className="fr-menu-icon">{DELETE_SVG}</span>
                              Eliminar
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* HISTORIAL TAB */}
          <div
            className="sp-pane"
            aria-current={tab === "historial" ? "true" : "false"}
          >
            <div className="hist-filter" role="tablist">
              {(
                [
                  ["recent", "Recientes"],
                  ["week", "Esta semana"],
                  ["month", "Este mes"],
                  ["all", "Todo"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className="hf-chip"
                  aria-selected={filter === key ? "true" : "false"}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {filteredHistory.length === 0 ? (
              <div className="sp-empty">
                {ICON_EMPTY}
                Sin sesiones en este rango.
              </div>
            ) : (
              filteredHistory.map((g, gi) => (
                <div key={gi} className="hist-group">
                  <div className="hist-date">{g.date}</div>
                  {g.items.map((it, ii) => (
                    <div key={ii} className="hist-item">
                      <div className="hi-mark">{ICON_CHAT}</div>
                      <div className="hi-body">
                        <div className="hi-title">{it.title}</div>
                        <div className="hi-meta">{it.meta}</div>
                      </div>
                      <div className="hi-time">{it.time}</div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* REGLAS TAB */}
          <div
            className="sp-pane"
            aria-current={tab === "reglas" ? "true" : "false"}
          >
            <div className="sp-card">
              <div className="sp-card-eyebrow">Reglas del área</div>
              <p
                style={{
                  font: "400 12px/1.5 var(--font)",
                  color: "var(--muted)",
                  marginBottom: 10,
                }}
              >
                Configura cómo responde la IA cuando trabaja dentro de esta
                área. Las reglas se aplican solo a esta sección.
              </p>

              {rules.length === 0 ? (
                <div className="sp-empty">
                  {ICON_EMPTY}
                  No hay reglas configuradas. Agrega una para guiar las
                  respuestas de la IA en esta área.
                </div>
              ) : (
                rules.map((r, i) => (
                  <div
                    key={i}
                    className="rule-row"
                    data-enabled={r.enabled ? "true" : "false"}
                  >
                    <div className="rr-body">
                      <div className="rr-name">{r.name}</div>
                      <div className="rr-desc">{r.desc}</div>
                      {r.tags.length > 0 && (
                        <div className="rr-tags">
                          {r.tags.map((t) => (
                            <span key={t} className="rr-tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className="rr-toggle"
                      aria-label="Activar regla"
                      onClick={() => {
                        void toggleRule(i);
                      }}
                    />
                    <div className="rr-kebab-wrap">
                      <button
                        className="rr-kebab"
                        aria-label="Más opciones"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpenIdx(menuOpenIdx === i ? null : i);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="7" cy="2.5" r="1.3" fill="currentColor" />
                          <circle cx="7" cy="7" r="1.3" fill="currentColor" />
                          <circle cx="7" cy="11.5" r="1.3" fill="currentColor" />
                        </svg>
                      </button>
                      {menuOpenIdx === i && (
                        <>
                          <div
                            className="rr-menu-backdrop"
                            onClick={() => setMenuOpenIdx(null)}
                          />
                          <div className="rr-menu">
                            <button
                              className="rr-menu-item"
                              onClick={() => {
                                setMenuOpenIdx(null);
                                void handleEditRule(i);
                              }}
                            >
                              Editar regla
                            </button>
                            <button
                              className="rr-menu-item rr-menu-item-danger"
                              onClick={() => {
                                setMenuOpenIdx(null);
                                void handleDeleteRule(i);
                              }}
                            >
                              Eliminar regla
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}

              <button className="rule-add" onClick={() => void handleAddRule()}>
                {ADD_SVG} Agregar regla
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
