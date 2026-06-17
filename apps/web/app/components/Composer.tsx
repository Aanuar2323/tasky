"use client";

import { useRef, useCallback, useEffect } from "react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onAttach: () => void;
}

export default function Composer({
  value,
  onChange,
  onSend,
  onAttach,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, []);

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (value.trim()) onSend();
      }
    },
    [value, onSend]
  );

  return (
    <div className="composer">
      <div className="frame">
        <button
          className="attach"
          data-tip="Adjuntar archivo"
          aria-label="Adjuntar"
          onClick={onAttach}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <path
              d="M11.5 6.5l-4.2 4.2a2 2 0 0 1-2.8-2.8l4.7-4.7a3 3 0 0 1 4.2 4.2l-5 5a4 4 0 0 1-5.6-5.6L7 2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          className="field"
          rows={1}
          placeholder="Escribe un mensaje…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={autoResize}
        />
        <button
          className="send"
          data-tip="Enviar"
          aria-label="Enviar"
          onClick={onSend}
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor">
            <path
              d="M2 7l10-5-3.5 12L6 8.5 2 7z"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="meta">
        <span>Tasky</span>
        <span className="right" />
      </div>
    </div>
  );
}
