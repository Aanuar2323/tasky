"use client";

import { useEffect, useRef, useState } from "react";
import {
  deleteFile,
  getGenerated,
  getGeneratedHistory,
  getRules,
  getTree,
  updateRules,
  uploadFile,
  type Area,
  type GeneratedFile,
  type HistoryGroup,
  type TreeEntry,
} from "../lib/api";
import { parseRulesMarkdown, rulesToMarkdown, type RuleItem } from "../lib/rules-parser";
import type { ChatFile } from "../types/chat";
import { FileTile } from "./FileCard";
import { KebabMenu } from "./Menu";
import { DownloadIcon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "./icons";

export type PanelTab = "info" | "historial" | "reglas";

const HIDDEN_FILES = new Set(["rules(ajkwygebfickuvaulwakfjbscfa).md", "summary(ajkwygebfickuvaulwakfjbscfa).md"]);
const EMPTY_DESC = "Sin descripcion";

type HistoryFilter = "all" | "week" | "month";

interface SidePanelProps {
  open: boolean;
  tab: PanelTab;
  area: Area | null;
  projectId: string;
  refreshKey: string;
  onChangeTab: (tab: PanelTab) => void;
  onClose: () => void;
  onPreview: (file: ChatFile) => void;
  onDownload: (file: ChatFile) => void;
}

interface AreaData {
  areaId: string;
  tree: TreeEntry[];
  generated: GeneratedFile[];
  history: HistoryGroup[];
  rules: RuleItem[];
}

async function fetchAreaData(projectId: string, areaId: string): Promise<AreaData> {
  const [tree, generated, history, rules] = await Promise.all([
    getTree(projectId, undefined, areaId).catch(() => ({ entries: [] as TreeEntry[] })),
    getGenerated(projectId, areaId).catch(() => ({ files: [] as GeneratedFile[] })),
    getGeneratedHistory(projectId, areaId).catch(() => [] as HistoryGroup[]),
    getRules(projectId, areaId).catch(() => ({ content: "" })),
  ]);
  return {
    areaId,
    tree: tree.entries,
    generated: generated.files,
    history,
    rules: parseRulesMarkdown(rules.content),
  };
}

function toFile(path: string, name: string, summary?: string | null): ChatFile {
  return { name, url: path, type: name.split(".").pop()?.toLowerCase() ?? "", summary: summary ?? null };
}

function RuleForm({ initial, onSave, onCancel }: { initial?: RuleItem; onSave: (name: string, desc: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [desc, setDesc] = useState(initial?.desc && initial.desc !== EMPTY_DESC ? initial.desc : "");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  return (
    <form
      className="rule-form"
      onSubmit={(e) => {
        e.preventDefault();
        // El formato de reglas guarda nombre y descripción en una sola línea.
        if (name.trim()) onSave(name.trim().replace(/\s+/g, " "), desc.trim().replace(/\s*\n\s*/g, " "));
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="field">
        <span>Nombre</span>
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label className="field">
        <span>Qué debe hacer la IA</span>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} maxLength={600} />
      </label>
      <div className="rule-form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn" data-tone="primary" disabled={!name.trim()}>
          Guardar
        </button>
      </div>
    </form>
  );
}

function FileActions({ onDownload, onDelete }: { onDownload: () => void; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <>
      <button type="button" role="menuitem" className="menu-item" onClick={onDownload}>
        <DownloadIcon /> Descargar
      </button>
      <button type="button" role="menuitem" className="menu-item" data-tone="danger" onClick={() => (armed ? onDelete() : setArmed(true))}>
        <TrashIcon /> {armed ? "Confirmar eliminación" : "Eliminar"}
      </button>
    </>
  );
}

export default function SidePanel({ open, tab, area, projectId, refreshKey, onChangeTab, onClose, onPreview, onDownload }: SidePanelProps) {
  const [data, setData] = useState<AreaData | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const areaId = area?.id ?? "";

  useEffect(() => {
    if (!open || !projectId || !areaId) return;
    let cancelled = false;
    fetchAreaData(projectId, areaId).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, areaId, refreshKey, reloadKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Los datos de otra área no se muestran mientras llegan los nuevos.
  const current = data?.areaId === areaId ? data : null;
  const rules = current?.rules ?? [];
  const files = (current?.tree ?? []).filter((e) => e.type === "file" && !HIDDEN_FILES.has(e.name));
  const generated = current?.generated ?? [];
  const history = current?.history ?? [];
  const historyCount = history.reduce((n, g) => n + g.items.length, 0);
  const activeRules = rules.filter((r) => r.enabled).length;
  const visibleHistory = history.filter((g) => (filter === "week" ? g.days <= 7 : filter === "month" ? g.days <= 30 : true));

  const saveRules = async (next: RuleItem[]) => {
    setData((d) => (d && d.areaId === areaId ? { ...d, rules: next } : d));
    try {
      await updateRules(projectId, rulesToMarkdown(next), areaId);
    } catch {
      setNotice("No se pudieron guardar las reglas");
      setReloadKey((k) => k + 1);
    }
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length || !areaId) return;
    setUploading(true);
    setNotice("");
    try {
      for (const file of Array.from(list)) await uploadFile(projectId, file, `ai/layer2/areas/${areaId}`);
    } catch {
      setNotice("No se pudo subir el archivo");
    } finally {
      setUploading(false);
      setReloadKey((k) => k + 1);
    }
  };

  const removeFile = async (path: string) => {
    try {
      await deleteFile(projectId, path);
    } catch {
      setNotice("No se pudo eliminar el archivo");
    } finally {
      setReloadKey((k) => k + 1);
    }
  };

  return (
    <>
      <div className="sp-backdrop" data-open={open ? "true" : "false"} onClick={onClose} />
      <aside className="side-panel" data-open={open ? "true" : "false"} aria-label={`Panel de ${area?.name ?? "área"}`} inert={!open}>
        <header className="sp-head">
          <h2 className="sp-name">{area?.name ?? ""}</h2>
          <button type="button" className="icon-btn" aria-label="Cerrar panel" onClick={onClose}>
            <XIcon />
          </button>
        </header>

        <div className="sp-tabs" role="tablist" aria-label="Secciones del área">
          <button type="button" role="tab" className="sp-tab" aria-selected={tab === "info"} onClick={() => onChangeTab("info")}>
            Archivos
          </button>
          <button type="button" role="tab" className="sp-tab" aria-selected={tab === "historial"} onClick={() => onChangeTab("historial")}>
            Historial {historyCount > 0 && <span className="sp-count">{historyCount}</span>}
          </button>
          <button type="button" role="tab" className="sp-tab" aria-selected={tab === "reglas"} onClick={() => onChangeTab("reglas")}>
            Reglas {activeRules > 0 && <span className="sp-count">{activeRules}</span>}
          </button>
        </div>

        <div className="sp-body" role="tabpanel">
          {notice && (
            <p className="sp-notice" role="alert">
              {notice}
              <button type="button" className="icon-btn" aria-label="Descartar aviso" onClick={() => setNotice("")}>
                <XIcon />
              </button>
            </p>
          )}

          {tab === "info" && (
            <>
              <section className="sp-section">
                <div className="sp-section-head">
                  <h3>Contexto</h3>
                  <button type="button" className="btn" data-size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    <PlusIcon /> {uploading ? "Subiendo…" : "Agregar"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      void upload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>
                {current && files.length === 0 ? (
                  <p className="sp-empty">Documentos que la IA consulta al responder en esta área.</p>
                ) : (
                  <ul className="file-list">
                    {files.map((f) => (
                      <li key={f.path} className="file-row">
                        <button type="button" className="fr-main" onClick={() => onPreview(toFile(f.path, f.name))}>
                          <FileTile name={f.name} size="sm" />
                          <span className="fr-name">{f.name}</span>
                        </button>
                        <KebabMenu label={f.name}>
                          {(close) => (
                            <FileActions
                              onDownload={() => {
                                close();
                                onDownload(toFile(f.path, f.name));
                              }}
                              onDelete={() => {
                                close();
                                void removeFile(f.path);
                              }}
                            />
                          )}
                        </KebabMenu>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="sp-section">
                <div className="sp-section-head">
                  <h3>Generados</h3>
                </div>
                {current && generated.length === 0 ? (
                  <p className="sp-empty">Todavía no hay archivos creados en esta área.</p>
                ) : (
                  <ul className="file-list">
                    {generated.map((g) => (
                      <li key={g.path} className="file-row">
                        <button type="button" className="fr-main" onClick={() => onPreview(toFile(g.path, g.filename, g.summary))}>
                          <FileTile name={g.filename} size="sm" />
                          <span className="fr-text">
                            <span className="fr-name">{g.filename}</span>
                            {g.summary && <span className="fr-meta">{g.summary}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="icon-btn row-kebab"
                          aria-label={`Descargar ${g.filename}`}
                          onClick={() => onDownload(toFile(g.path, g.filename))}
                        >
                          <DownloadIcon />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {tab === "historial" && (
            <>
              <div className="segmented" role="group" aria-label="Período">
                {(
                  [
                    ["all", "Todo"],
                    ["week", "7 días"],
                    ["month", "30 días"],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                    {label}
                  </button>
                ))}
              </div>
              {current && visibleHistory.length === 0 ? (
                <p className="sp-empty">Los archivos que guardes desde el chat quedan acá.</p>
              ) : (
                visibleHistory.map((g) => (
                  <section key={g.date} className="hist-group">
                    <h3 className="hist-date">{g.date}</h3>
                    <ul className="file-list">
                      {g.items.map((it) => (
                        <li key={`${g.date}-${it.title}`} className="file-row">
                          <button
                            type="button"
                            className="fr-main"
                            disabled={!it.path}
                            onClick={() => it.path && onPreview(toFile(it.path, it.title, it.summary))}
                          >
                            <FileTile name={it.title} size="sm" />
                            <span className="fr-text">
                              <span className="fr-name">{it.title}</span>
                              {it.summary && <span className="fr-meta">{it.summary}</span>}
                            </span>
                          </button>
                          <span className="fr-time">{it.time}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </>
          )}

          {tab === "reglas" && (
            <section className="sp-section">
              {current && rules.length === 0 && editing !== "new" && (
                <p className="sp-empty">Indicaciones que la IA sigue en cada respuesta de esta área.</p>
              )}
              <ul className="rule-list">
                {rules.map((r, i) =>
                  editing === i ? (
                    <li key={`edit-${i}`}>
                      <RuleForm
                        initial={r}
                        onCancel={() => setEditing(null)}
                        onSave={(name, desc) => {
                          setEditing(null);
                          void saveRules(rules.map((x, j) => (j === i ? { ...x, name, desc } : x)));
                        }}
                      />
                    </li>
                  ) : (
                    <li key={`${r.name}-${i}`} className="rule-row" data-enabled={r.enabled ? "true" : "false"}>
                      <div className="rr-body">
                        <div className="rr-name">{r.name}</div>
                        {r.desc && r.desc !== EMPTY_DESC && <div className="rr-desc">{r.desc}</div>}
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.enabled}
                        aria-label={r.name}
                        className="switch"
                        onClick={() => void saveRules(rules.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))}
                      />
                      <KebabMenu label={r.name}>
                        {(close) => (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              className="menu-item"
                              onClick={() => {
                                close();
                                setEditing(i);
                              }}
                            >
                              <PencilIcon /> Editar
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="menu-item"
                              data-tone="danger"
                              onClick={() => {
                                close();
                                void saveRules(rules.filter((_, j) => j !== i));
                              }}
                            >
                              <TrashIcon /> Eliminar
                            </button>
                          </>
                        )}
                      </KebabMenu>
                    </li>
                  )
                )}
              </ul>
              {editing === "new" ? (
                <RuleForm
                  onCancel={() => setEditing(null)}
                  onSave={(name, desc) => {
                    setEditing(null);
                    void saveRules([...rules, { name, desc, tags: [], enabled: true }]);
                  }}
                />
              ) : (
                <button type="button" className="rule-add" onClick={() => setEditing("new")}>
                  <PlusIcon /> Agregar regla
                </button>
              )}
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
