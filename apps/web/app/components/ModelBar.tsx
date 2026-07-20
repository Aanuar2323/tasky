"use client";

import type { Provider, ProviderInfo, ModelInfo } from "@/app/lib/api";

interface ModelBarProps {
  activeProvider: Provider;
  providers: Record<Provider, ProviderInfo>;
  currentModel: string;
  onOpen: () => void;
}

function shortModelId(id: string) {
  const parts = id.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : id;
}

const PROVIDER_ICONS: Record<Provider, string> = {
  openrouter: "◉",
  nvidia: "▣",
};

export default function ModelBar({
  activeProvider,
  providers,
  currentModel,
  onOpen,
}: ModelBarProps) {
  const label = providers[activeProvider]?.label ?? activeProvider;
  const modelShort = shortModelId(currentModel || "");
  return (
    <div className="model-bar">
      <button
        className="mb-trigger"
        onClick={onOpen}
        title="Change model/provider"
        aria-label="Change model/provider"
      >
        <span className={`mb-trigger-icon mb-trigger-icon--${activeProvider}`}>
          {PROVIDER_ICONS[activeProvider] ?? "●"}
        </span>
        <span className="mb-trigger-content">
          <span className="mb-trigger-provider">{label}</span>
          <span className="mb-trigger-model">{modelShort || "—"}</span>
        </span>
        <span className="mb-trigger-chevron">▾</span>
      </button>
    </div>
  );
}

export { ModelBar };
export type { Provider, ProviderInfo, ModelInfo };
