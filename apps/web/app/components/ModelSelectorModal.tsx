"use client";

import { useEffect, useState } from "react";
import type { Provider, ProviderInfo, ModelInfo } from "@/app/lib/api";

const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
};

export interface ModelSelectorModalProps {
  open: boolean;
  providers: Record<Provider, ProviderInfo>;
  activeProvider: Provider;
  models: ModelInfo[];
  modelsLoading: boolean;
  selectedProvider?: Provider;
  selectedModel?: string;
  errorMessage?: string;
  isFirstRun?: boolean;
  pending?: boolean;
  onClose?: () => void;
  onSelectProvider: (p: Provider) => void;
  onChangeModel: (m: string) => void | Promise<void>;
  onFetchModels: (p: Provider) => void | Promise<void>;
  onSaveKey: (p: Provider, apiKey: string) => Promise<void> | void;
  onSaveSetup?: () => void | Promise<void>;
}

export default function ModelSelectorModal({
  open,
  providers,
  activeProvider,
  models,
  modelsLoading,
  selectedProvider,
  selectedModel,
  errorMessage,
  isFirstRun = false,
  pending = false,
  onClose,
  onSelectProvider,
  onChangeModel,
  onFetchModels,
  onSaveKey,
  onSaveSetup,
}: ModelSelectorModalProps) {
  const initialTab =
    selectedProvider && providers[selectedProvider]
      ? selectedProvider
      : activeProvider;
  const [tab, setTab] = useState<Provider>(initialTab);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open || isFirstRun || !onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, isFirstRun, onClose]);

  if (!open) return null;

  const current = providers[tab];
  if (!current) return null;

  const handleSaveKey = async () => {
    const key = (keyInputs[tab] || "").trim();
    if (!key) return;
    setSaving((s) => ({ ...s, [tab]: true }));
    try {
      await onSaveKey(tab, key);
      setKeyInputs((s) => ({ ...s, [tab]: "" }));
    } catch {
      /* surfaced vía parent */
    } finally {
      setSaving((s) => ({ ...s, [tab]: false }));
    }
  };

  const modelValue =
    tab === activeProvider
      ? selectedModel ?? current.model
      : current.model ?? "";

  const handleApply = () => {
    if (isFirstRun) {
      onSelectProvider(tab);
      onSaveSetup?.();
      return;
    }
    onSelectProvider(tab);
  };

  const applyDisabled =
    pending ||
    !current.configured ||
    (!isFirstRun && tab === activeProvider);

  const title = isFirstRun
    ? "Configura tu IA"
    : "Cambiar modelo / proveedor";

  return (
    <div
      className="msm-overlay"
      onClick={() => {
        if (!isFirstRun && onClose) onClose();
      }}
    >
      <div
        className="msm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="msm-header">
          <h2>{title}</h2>
          {!isFirstRun && onClose && (
            <button className="msm-close" onClick={onClose} aria-label="Cerrar">
              ×
            </button>
          )}
        </div>

        <div className="msm-tabs">
          {(Object.keys(providers) as Provider[]).map((p) => {
            const info = providers[p];
            if (!info) return null;
            const isActive = p === activeProvider;
            const isTab = tab === p;
            return (
              <button
                key={p}
                className={`msm-tab${isTab ? " active" : ""}${isActive ? " current" : ""}`}
                onClick={() => setTab(p)}
                disabled={isFirstRun && !info.configured}
              >
                {PROVIDER_LABELS[p] ?? info.label ?? p}
                {isActive && <span className="msm-tick"> ✓</span>}
              </button>
            );
          })}
        </div>

        <div className="msm-body">
          <div className="msm-status">
            Estado:{" "}
            <span className={current.configured ? "msm-ok" : "msm-no"}>
              {current.configured ? "Configurado" : "Sin configurar"}
            </span>
          </div>

          {!current.configured && (
            <div className="msm-field">
              <label>
                API Key de {PROVIDER_LABELS[tab] ?? current.label ?? tab}
              </label>
              <div className="msm-key-row">
                <input
                  type="password"
                  placeholder="••••••••"
                  value={keyInputs[tab] || ""}
                  onChange={(e) =>
                    setKeyInputs((s) => ({ ...s, [tab]: e.target.value }))
                  }
                />
                <button
                  className="msm-btn secondary"
                  onClick={handleSaveKey}
                  disabled={
                    saving[tab] || !(keyInputs[tab] || "").trim()
                  }
                >
                  {saving[tab] ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </div>
          )}

          <div className="msm-field">
            <label>Modelo</label>
            {modelsLoading ? (
              <div className="msm-loading">
                <span className="msm-spinner" />
                <span>Cargando modelos...</span>
              </div>
            ) : models.length > 0 ? (
              <select
                value={modelValue}
                onChange={(e) => onChangeModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.isFree ? " (free)" : ""} — {m.id}
                  </option>
                ))}
              </select>
            ) : (
              <div className="msm-model-row">
                <input
                  type="text"
                  value={modelValue}
                  onChange={(e) => onChangeModel(e.target.value)}
                  placeholder={
                    tab === "openrouter"
                      ? "openai/gpt-oss-120b:free"
                      : "meta/llama-3.1-405b-instruct"
                  }
                />
                <button
                  className="msm-btn secondary"
                  onClick={() => onFetchModels(tab)}
                  disabled={
                    modelsLoading || (!current.configured && !(keyInputs[tab] || "").trim())
                  }
                >
                  Cargar modelos
                </button>
              </div>
            )}
          </div>

          {errorMessage && <p className="msm-error">{errorMessage}</p>}

          <div className="msm-actions">
            {!isFirstRun && (
              <button
                className="msm-btn secondary"
                onClick={() => onFetchModels(tab)}
                disabled={modelsLoading}
              >
                Refrescar modelos
              </button>
            )}
            <button
              className="msm-btn primary"
              onClick={handleApply}
              disabled={applyDisabled}
            >
              {pending
                ? "Guardando..."
                : isFirstRun
                  ? "Comenzar"
                  : tab === activeProvider
                    ? "En uso"
                    : "Usar este proveedor"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
