"use client";

import { useState, useRef, useEffect } from "react";
import type { ModelInfo } from "@/app/lib/api";

interface ModelBarProps {
  currentModel: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  onFetchModels: () => void;
  onChangeModel: (model: string) => void;
}

const REFRESH_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M1.5 6a4.5 4.5 0 0 1 8-3M10.5 6a4.5 4.5 0 0 1-8 3" strokeLinecap="round" />
    <path d="M10.5 1.5v3h-3M1.5 10.5v-3h3" strokeLinejoin="round" />
  </svg>
);

function shortModelId(id: string) {
  const parts = id.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : id;
}

export default function ModelBar({
  currentModel,
  models,
  modelsLoading,
  onFetchModels,
  onChangeModel,
}: ModelBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div className="model-bar" ref={ref}>
      <button className="mb-badge" onClick={() => models.length && setOpen((v) => !v)}>
        {shortModelId(currentModel)}
      </button>
      <button
        className="mb-refresh"
        onClick={onFetchModels}
        disabled={modelsLoading}
        data-tip="Cargar modelos de OpenRouter"
      >
        {REFRESH_SVG}
      </button>
      {modelsLoading && <span className="mb-spinner" />}
      {open && models.length > 0 && (
        <div className="mb-dropdown">
          {models.map((m) => (
            <button
              key={m.id}
              className={`mb-opt${m.id === currentModel ? " active" : ""}`}
              onClick={() => {
                onChangeModel(m.id);
                setOpen(false);
              }}
            >
              <span className="mb-opt-name">{m.name}</span>
              <span className="mb-opt-id">{m.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
