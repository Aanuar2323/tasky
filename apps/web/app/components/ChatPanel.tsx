"use client";

import { memo, useRef, useEffect } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import type { ChatMessage } from "../types/chat";

interface ChatPanelProps {
  areaName: string;
  chatName: string;
  messages: ChatMessage[];
  loading?: boolean;
  onConfirm?: () => void;
  onDeny?: () => void;
  onDownload?: (file: ChatMessage["file"]) => void;
}

function formatTime(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

const FILE_DOC_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M3 1.5h4l2 2v6.5a.5.5 0 0 1-.5.5h-5.5a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" strokeLinejoin="round" />
    <path d="M5 6h2M5 7.5h1.5" strokeLinecap="round" />
  </svg>
);

const DL_SVG = (
  <svg viewBox="0 0 11 11" fill="none" stroke="currentColor">
    <path d="M5.5 1.5v6M3 5l2.5 2.5L8 5M2 9.5h7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function ChatPanel({
  areaName,
  chatName,
  messages,
  loading,
  onConfirm,
  onDeny,
  onDownload,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldAutoScrollRef.current = distanceToBottom < 48;
    };

    el.addEventListener("scroll", onScroll);
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (scrollRef.current && shouldAutoScrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  return (
    <div className="chat-scroll" ref={scrollRef}>
      {messages.map((msg, i) => {
        const isUser = msg.role === "user";
        const time = formatTime(msg.ts);

        return (
          <div key={i} className={`msg ${isUser ? "user" : "ai"}`}>
            <div className="avatar">{isUser ? "M" : "T"}</div>
            <div style={{ minWidth: 0 }}>
              <div
                className="role"
                style={isUser ? { justifyContent: "flex-end" } : undefined}
              >
                  {isUser ? "María" : "Tasky"}
                {time && (
                  <span className="when">· {time}</span>
                )}
              </div>
              <div className="bubble">
                {isUser ? (
                  msg.content
                ) : (
                  <div className="content">
                    <MarkdownRenderer content={msg.content} />

                    {msg.file && (
                      <div style={{ marginTop: 10 }}>
                        <div className="file-pill">
                          <div className="fp-icon">{FILE_DOC_SVG}</div>
                          <div className="fp-text">
                            <div className="fp-name">{msg.file.name}</div>
                            <div className="fp-meta">{msg.file.meta}</div>
                          </div>
                          <button
                            className="fp-dl"
                            onClick={() => onDownload?.(msg.file)}
                          >
                            {DL_SVG}
                            Descargar
                          </button>
                        </div>
                      </div>
                    )}

                    {msg.meta?.complete && (
                      <div style={{ marginTop: 10 }}>
                        <div className="confirm">
                          <span className="q">
                            ¿Agregar este análisis al historial del área?
                          </span>
                          <button className="yes" onClick={onConfirm}>
                            Confirmar
                          </button>
                          <button className="no" onClick={onDeny}>
                            Denegar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {loading && (
        <div className="msg ai">
          <div className="avatar">T</div>
          <div>
            <div className="role">Tasky</div>
            <div className="typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ChatPanel);
