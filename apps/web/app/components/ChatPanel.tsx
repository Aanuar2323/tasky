"use client";

import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ChatFile, ChatMessage } from "../types/chat";
import EmptyState from "./EmptyState";
import MessageItem from "./MessageItem";
import { ArrowDownIcon } from "./icons";

interface ChatPanelProps {
  areaName: string;
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  onPickSuggestion: (prompt: string) => void;
  onRegenerate: () => void;
  onPreview: (file: ChatFile) => void;
  onDownload: (file: ChatFile) => void;
  onSaveFile: (messageId: string, file: ChatFile) => void;
}

const STICK_DISTANCE = 96;

function ChatPanel({
  areaName,
  messages,
  loading,
  sending,
  onPickSuggestion,
  onRegenerate,
  onPreview,
  onDownload,
  onSaveFile,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id;

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  // Al enviar un mensaje nuevo, volver a seguir el final (antes de ajustar el scroll).
  useLayoutEffect(() => {
    stickRef.current = true;
  }, [lastUserId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  };

  const lastIndex = messages.length - 1;

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-inner">
        {loading ? (
          <div className="chat-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState areaName={areaName} onPick={onPickSuggestion} />
        ) : (
          messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={i === lastIndex && m.role === "assistant"}
              busy={sending}
              onRegenerate={onRegenerate}
              onPreview={onPreview}
              onDownload={onDownload}
              onSaveFile={onSaveFile}
            />
          ))
        )}
      </div>
      {showJump && messages.length > 0 && (
        <button type="button" className="jump-bottom" onClick={jump} aria-label="Ir al final">
          <ArrowDownIcon />
        </button>
      )}
    </div>
  );
}

export default memo(ChatPanel);
