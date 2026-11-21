"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { KeyProvider, ModelInfo, Provider, ProviderInfo } from "../lib/api";
import type { ChatgptController } from "../hooks/useModels";
import ChatgptPanel from "./ChatgptPanel";
import { CheckIcon, ImageIcon, KeyIcon, SearchIcon, SparkIcon, ToolIcon, XIcon } from "./icons";

const PROVIDER_LABELS: Record<Provider, string> = { openrouter: "OpenRouter", nvidia: "NVIDIA NIM", chatgpt: "ChatGPT" };
const PROVIDERS: Provider[] = ["openrouter", "nvidia", "chatgpt"];
const MAX_ROWS = 200;

function formatContext(n?: number) {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  return `${Math.round(n / 1000)}K`;
}

export interface ModelSelectorModalProps {
  open: boolean;
  firstRun?: boolean;
  providers?: Record<Provider, ProviderInfo>;
  activeProvider: Provider;
  currentModel: string;
  loadModels: (provider: Provider, force?: boolean) => Promise<ModelInfo[]>;
  onSaveKey: (provider: KeyProvider, apiKey: string) => Promise<void>;
  chatgpt?: ChatgptController;
  onSelect: (provider: Provider, model: string) => Promise<void>;
  onClose?: () => void;
}

type Filters = { free: boolean; tools: boolean; vision: boolean };

export default function ModelSelectorModal({
  open,
  firstRun = false,
  providers,
  activeProvider,
  currentModel,
  loadModels,
  onSaveKey,
  chatgpt,
  onSelect,
  onClose,
}: ModelSelectorModalProps) {
  const [tab, setTab] = useState<Provider>(activeProvider);
  const [models, setModels] = useState<Record<string, ModelInfo[] | undefined>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string | undefined>>({});
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>({ free: false, tools: false, vision: false });
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const modalRef = useFocusTrap<HTMLDivElement>(open);

  const info = providers?.[tab];
  const configured = !!info?.configured;
  const isChatgpt = tab === "chatgpt";
  const showKeyForm = !isChatgpt && (!configured || editingKey);
  // Otra cuenta o sesión, otro catálogo de modelos: la caché de ChatGPT depende de la sesión.
  const cacheKey = isChatgpt ? `chatgpt:${chatgpt?.status?.accountId ?? ""}:${configured ? 1 : 0}` : tab;
  const list = models[cacheKey];
  const loading = configured && !list && !loadErrors[cacheKey];

  useEffect(() => {
    if (!open || !configured || models[cacheKey] || loadErrors[cacheKey]) return;
    let cancelled = false;
    loadModels(tab)
      .then((m) => {
        if (!cancelled) setModels((prev) => ({ ...prev, [cacheKey]: m }));
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadErrors((prev) => ({ ...prev, [cacheKey]: e.message || "No se pudieron cargar los modelos" }));
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, cacheKey, configured, models, loadErrors, loadModels]);

  const refreshChatgpt = chatgpt?.refresh;
  useEffect(() => {
    if (open && isChatgpt) void refreshChatgpt?.();
  }, [open, isChatgpt, refreshChatgpt]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => (showKeyForm ? keyRef.current : searchRef.current)?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, tab, showKeyForm]);

  useEffect(() => {
    if (!open || firstRun || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, firstRun, onClose]);

  const selectedId = pending || (tab === activeProvider ? currentModel : info?.model ?? "");

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = (list ?? []).filter((m) => {
      if (filters.free && !m.isFree) return false;
      if (filters.tools && !m.tools) return false;
      if (filters.vision && !m.vision) return false;
      const hay = `${m.id} ${m.name}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
    const current = all.findIndex((m) => m.id === selectedId);
    if (current > 0) all.unshift(...all.splice(current, 1));
    return all;
  }, [list, query, filters, selectedId]);

  const visible = filtered.slice(0, MAX_ROWS);

  if (!open) return null;

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key || tab === "chatgpt") return;
    setSavingKey(true);
    setError("");
    try {
      await onSaveKey(tab, key);
      setKeyInput("");
      setEditingKey(false);
      setLoadErrors((prev) => ({ ...prev, [cacheKey]: undefined }));
      setModels((prev) => ({ ...prev, [cacheKey]: undefined }));
    } catch (e) {
      setError((e as Error).message || "No se pudo guardar la clave");
    } finally {
      setSavingKey(false);
    }
  };

  const choose = async (id: string) => {
    if (firstRun) {
      setPending(id);
      return;
    }
    setApplying(true);
    setError("");
    try {
      await onSelect(tab, id);
      onClose?.();
    } catch (e) {
      setError((e as Error).message || "No se pudo cambiar el modelo");
    } finally {
      setApplying(false);
    }
  };

  const start = async () => {
    if (!pending) return;
    setApplying(true);
    setError("");
    try {
      await onSelect(tab, pending);
    } catch (e) {
      setError((e as Error).message || "No se pudo guardar la configuración");
      setApplying(false);
    }
  };

  const moveHighlight = (delta: number) => {
    if (!visible.length) return;
    const next = (highlight + delta + visible.length) % visible.length;
    setHighlight(next);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const toggle = (k: keyof Filters) => {
    setFilters((f) => ({ ...f, [k]: !f[k] }));
    setHighlight(0);
  };

  const title = firstRun ? "Configurá tu IA" : "Modelo";

  return (
    <div className="msm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !firstRun) onClose?.(); }}>
      <div ref={modalRef} className="msm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="msm-header">
          <h2>{title}</h2>
          {!firstRun && onClose && (
            <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
              <XIcon />
            </button>
          )}
        </header>

        <div className="msm-tabs" role="tablist" aria-label="Proveedor">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={tab === p}
              className="msm-tab"
              onClick={() => {
                setTab(p);
                setPending("");
                setHighlight(0);
                setError("");
                setEditingKey(false);
                setKeyInput("");
              }}
            >
              {PROVIDER_LABELS[p]}
              {!providers?.[p]?.configured && <span className="msm-tab-note">{p === "chatgpt" ? "sin sesión" : "sin clave"}</span>}
            </button>
          ))}
        </div>

        {isChatgpt && chatgpt && <ChatgptPanel chatgpt={chatgpt} />}

        {showKeyForm && (
          <form
            className="msm-key"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <label htmlFor="msm-key-input">API key de {PROVIDER_LABELS[tab]}</label>
            <div className="msm-key-row">
              <input
                id="msm-key-input"
                ref={keyRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button type="submit" className="btn" data-tone="primary" disabled={savingKey || !keyInput.trim()}>
                {savingKey ? "Guardando…" : "Guardar"}
              </button>
              {configured && (
                <button type="button" className="btn" onClick={() => { setEditingKey(false); setKeyInput(""); }}>
                  Cancelar
                </button>
              )}
            </div>
          </form>
        )}

        {configured && (
          <>
            <div className="msm-search">
              <SearchIcon />
              <input
                ref={searchRef}
                type="search"
                placeholder="Buscar modelo"
                aria-label="Buscar modelo"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveHighlight(1);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveHighlight(-1);
                  } else if (e.key === "Enter" && visible[highlight]) {
                    e.preventDefault();
                    void choose(visible[highlight].id);
                  }
                }}
              />
            </div>
            <div className="msm-filters">
              {!isChatgpt && <button type="button" className="chip" aria-pressed={filters.free} onClick={() => toggle("free")}>Gratis</button>}
              <button type="button" className="chip" aria-pressed={filters.tools} onClick={() => toggle("tools")}>
                <ToolIcon /> Herramientas
              </button>
              <button type="button" className="chip" aria-pressed={filters.vision} onClick={() => toggle("vision")}>
                <ImageIcon /> Visión
              </button>
              {!isChatgpt && <button
                type="button"
                className="icon-btn msm-key-toggle"
                aria-label="Cambiar API key"
                title="Cambiar API key"
                aria-pressed={editingKey}
                onClick={() => setEditingKey((v) => !v)}
              >
                <KeyIcon />
              </button>}
            </div>

            <div className="msm-list" ref={listRef} role="listbox" aria-label="Modelos">
              {loading && (
                <div className="msm-state">
                  <span className="spinner" aria-hidden="true" /> Cargando modelos
                </div>
              )}
              {loadErrors[cacheKey] && (
                <div className="msm-state" data-tone="danger">
                  {loadErrors[cacheKey]}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setLoadErrors((prev) => ({ ...prev, [cacheKey]: undefined }))}
                  >
                    Reintentar
                  </button>
                </div>
              )}
              {list && !visible.length && <div className="msm-state">Sin resultados</div>}
              {visible.map((m, i) => {
                const selected = m.id === selectedId;
                return (
                  <div
                    key={m.id}
                    role="option"
                    aria-selected={selected}
                    data-index={i}
                    data-highlight={i === highlight ? "true" : "false"}
                    className="msm-row"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void choose(m.id)}
                  >
                    <div className="msm-row-main">
                      <span className="msm-row-name">{m.name}</span>
                      <span className="msm-row-id">{m.id}</span>
                    </div>
                    <div className="msm-badges">
                      {m.isFree && <span className="badge" data-tone="free">Gratis</span>}
                      {formatContext(m.contextLength) && <span className="badge" title="Ventana de contexto">{formatContext(m.contextLength)}</span>}
                      {m.tools && <span className="badge-icon" title="Usa herramientas"><ToolIcon /></span>}
                      {m.vision && <span className="badge-icon" title="Acepta imágenes"><ImageIcon /></span>}
                      {m.reasoning && <span className="badge-icon" title="Razona antes de responder"><SparkIcon /></span>}
                    </div>
                    <span className="msm-check" aria-hidden="true">{selected && <CheckIcon />}</span>
                  </div>
                );
              })}
              {filtered.length > MAX_ROWS && (
                <div className="msm-state">{filtered.length - MAX_ROWS} modelos más: refiná la búsqueda</div>
              )}
            </div>
          </>
        )}

        {error && <p className="msm-error" role="alert">{error}</p>}

        {firstRun && (
          <div className="msm-actions">
            <button type="button" className="btn" data-tone="primary" disabled={!pending || applying} onClick={() => void start()}>
              {applying ? "Guardando…" : "Comenzar"}
            </button>
          </div>
        )}
        {!firstRun && applying && <div className="msm-applying" aria-live="polite">Aplicando…</div>}
      </div>
    </div>
  );
}
