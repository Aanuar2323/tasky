"use client";

import { memo, useState } from "react";
import type { ChatFile, ChatMessage } from "../types/chat";
import { fileKind } from "../lib/messages";
import ErrorPill from "./ErrorPill";
import FileCard, { FileTile } from "./FileCard";
import MarkdownRenderer from "./MarkdownRenderer";
import { shortModelId } from "./ModelBar";
import StatusChip from "./StatusChip";
import { CheckIcon, CopyIcon, RefreshIcon } from "./icons";

interface MessageItemProps {
  message: ChatMessage;
  isLast: boolean;
  busy: boolean;
  onRegenerate: () => void;
  onPreview: (file: ChatFile) => void;
  onDownload: (file: ChatFile) => void;
  onSaveFile: (messageId: string, file: ChatFile) => void;
}

function MessageItem({ message, isLast, busy, onRegenerate, onPreview, onDownload, onSaveFile }: MessageItemProps) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <article className="msg" data-role="user">
        <div className="msg-user">
          {!!message.attachments?.length && (
            <ul className="att-list" aria-label="Adjuntos">
              {message.attachments.map((a, i) => (
                <li key={`${a.name}-${i}`} className="att-chip" data-kind={fileKind(a.name)}>
                  <FileTile name={a.name} size="sm" />
                  <span className="att-name">{a.name}</span>
                </li>
              ))}
            </ul>
          )}
          {message.content && <div className="msg-bubble">{message.content}</div>}
        </div>
      </article>
    );
  }

  const { content, streaming, status, files, error, stopped, reasoning } = message;
  const waiting = streaming && !content;
  const seconds = message.reasoningMs ? Math.max(1, Math.round(message.reasoningMs / 1000)) : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* portapapeles no disponible */
    }
  };

  return (
    <article className="msg" data-role="assistant" data-streaming={streaming ? "true" : "false"} aria-busy={streaming || undefined}>
      <div className="msg-assistant">
        {reasoning && (
          <details className="msg-reasoning">
            <summary>{streaming && !content ? "Pensando…" : seconds ? `Razonó durante ${seconds} s` : "Razonamiento"}</summary>
            <div className="mr-body">{reasoning}</div>
          </details>
        )}

        {content && <MarkdownRenderer content={content} />}

        {streaming && status && <StatusChip status={status} />}
        {waiting && !status && <StatusChip status={{ phase: "thinking", label: "Pensando" }} />}

        {!!files?.length && (
          <div className="msg-files">
            {files.map((f) => (
              <FileCard
                key={f.url}
                file={f}
                onPreview={onPreview}
                onDownload={onDownload}
                onSave={(file) => onSaveFile(message.id, file)}
              />
            ))}
          </div>
        )}

        {error && <ErrorPill error={error} onRetry={isLast && !busy ? onRegenerate : undefined} />}
        {stopped && !error && <p className="msg-note">Respuesta detenida</p>}

        {!streaming && !error && (!!content || !!files?.length) && (
          <div className="msg-actions">
            {content && (
              <button type="button" className="icon-btn" data-tip={copied ? "Copiado" : "Copiar"} aria-label={copied ? "Copiado" : "Copiar respuesta"} onClick={copy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            )}
            {isLast && (
              <button type="button" className="icon-btn" data-tip="Regenerar" aria-label="Regenerar respuesta" onClick={onRegenerate} disabled={busy}>
                <RefreshIcon />
              </button>
            )}
            {message.model && <span className="msg-model">{shortModelId(message.model)}</span>}
          </div>
        )}
      </div>
    </article>
  );
}

export default memo(MessageItem);
