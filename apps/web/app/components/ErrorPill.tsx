"use client";

import { memo } from "react";

interface ErrorPillProps {
  title: string;
  hint: string;
  codes: number[];
  retriable?: boolean;
  onRetry?: () => void;
}

const ALERT_SVG = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" className="size-4 shrink-0">
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
  </svg>
);

function ErrorPill({ title, hint, codes, retriable, onRetry }: ErrorPillProps) {
  return (
    <div className="my-1 flex justify-start">
      <div className="max-w-md rounded-xl border border-red-500/30 bg-red-500/10 backdrop-blur-sm shadow-sm px-4 py-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-red-100">
          {ALERT_SVG}
          {title}
        </div>
        <p className="mt-1 text-xs leading-snug text-red-200/70">{hint}</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          {retriable !== false && onRetry ? (
            <button
              onClick={onRetry}
              className="rounded-md bg-red-500/15 border border-red-500/30 px-2 py-0.5 text-xs text-red-100 hover:bg-red-500/25 transition"
            >
              ↻ Reintentar
            </button>
          ) : (
            <span />
          )}
          <span className="font-mono text-[10px] text-red-300/50">
            {codes.filter(Boolean).join(' · ')}
          </span>
        </div>
      </div>
    </div>
  );
}

export default memo(ErrorPill);
