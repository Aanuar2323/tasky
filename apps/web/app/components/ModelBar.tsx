"use client";

import type { Provider } from "../lib/api";
import { ChevronDownIcon } from "./icons";

export function shortModelId(id: string) {
  const last = id.split("/").pop() ?? id;
  return last.replace(/:free$/, "");
}

export default function ModelTrigger({
  provider,
  model,
  onOpen,
}: {
  provider: Provider;
  model: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="model-trigger" onClick={onOpen} aria-label={`Modelo ${model || "sin elegir"}. Cambiar modelo`}>
      <span className="mt-dot" data-provider={provider} aria-hidden="true" />
      <span className="mt-name">{shortModelId(model) || "Elegir modelo"}</span>
      <ChevronDownIcon className="mt-chevron" />
    </button>
  );
}
