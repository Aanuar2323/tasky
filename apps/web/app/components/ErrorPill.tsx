"use client";

import { memo } from "react";
import type { HumanError } from "../types/chat";
import { AlertIcon, RefreshIcon } from "./icons";

function ErrorPill({ error, onRetry }: { error: HumanError; onRetry?: () => void }) {
  const codes = error.codes?.filter(Boolean) ?? [];
  return (
    <div className="error-pill" role="alert" title={codes.length ? `Código ${codes.join(", ")}` : undefined}>
      <AlertIcon className="ep-icon" />
      <div className="ep-body">
        <div className="ep-title">{error.title}</div>
        {error.hint && <div className="ep-hint">{error.hint}</div>}
        {error.action === "usage" && (
          <a className="ep-hint" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">
            Ver uso en ChatGPT
          </a>
        )}
      </div>
      {onRetry && error.retriable !== false && (
        <button type="button" className="ep-retry" onClick={onRetry}>
          <RefreshIcon />
          Reintentar
        </button>
      )}
    </div>
  );
}

export default memo(ErrorPill);
