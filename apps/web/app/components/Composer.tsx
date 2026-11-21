"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes } from "../lib/messages";
import { FileTile } from "./FileCard";
import { ArrowUpIcon, PaperclipIcon, StopIcon, XIcon } from "./icons";

const MAX_FILES = 10;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_HEIGHT = 220;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
  sending: boolean;
  disabled?: boolean;
  /** Falso mientras carga el historial: se puede escribir pero no enviar. */
  canSubmit?: boolean;
  modelSlot?: ReactNode;
  /** Selector de razonamiento, pegado al botón de enviar. */
  effortSlot?: ReactNode;
  focusKey?: number;
}

export default function Composer({ value, onChange, onSend, onStop, sending, disabled = false, canSubmit = true, modelSlot, effortSlot, focusKey }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState("");

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (focusKey === undefined) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);

  const addFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list);
    const accepted = incoming.filter((f) => f.size <= MAX_BYTES);
    const room = MAX_FILES - files.length;
    const kept = accepted.slice(0, Math.max(0, room));
    setFiles((prev) => [...prev, ...kept]);
    setNote(kept.length < incoming.length ? `Máximo ${MAX_FILES} archivos de 50 MB` : "");
  };

  const canSend = !disabled && canSubmit && !sending && (value.trim().length > 0 || files.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim(), files);
    setFiles([]);
    setNote("");
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div className="composer">
      <div className="composer-inner">
        <div
          className="composer-box"
          data-dragging={dragging ? "true" : "false"}
          onDragEnter={(e) => {
            if (!hasFiles(e)) return;
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDragOver={(e) => {
            if (hasFiles(e)) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {files.length > 0 && (
            <ul className="att-list" aria-label="Archivos adjuntos">
              {files.map((f, i) => (
                <li key={`${f.name}-${f.size}-${i}`} className="att-chip">
                  <FileTile name={f.name} size="sm" />
                  <span className="att-name">{f.name}</span>
                  <span className="att-size">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    className="att-remove"
                    aria-label={`Quitar ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <XIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <textarea
            ref={textareaRef}
            className="composer-field"
            rows={1}
            placeholder="Escribí un mensaje…"
            aria-label="Mensaje"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && sending) {
                e.preventDefault();
                onStop();
              }
            }}
            onPaste={(e) => {
              // Copiar celdas de Excel trae texto y además una imagen: el texto tiene prioridad.
              if (e.clipboardData.files.length && !e.clipboardData.getData("text/plain")) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
          />

          <div className="composer-bar">
            <button
              type="button"
              className="icon-btn"
              data-tip="Adjuntar archivos"
              aria-label="Adjuntar archivos"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {modelSlot}
            <span className="cb-spacer" />
            {note && (
              <span className="composer-note" role="status">
                {note}
              </span>
            )}
            {effortSlot}
            {sending ? (
              <button type="button" className="send-btn" data-state="stop" aria-label="Detener respuesta" onClick={onStop}>
                <StopIcon />
              </button>
            ) : (
              <button type="button" className="send-btn" aria-label="Enviar" disabled={!canSend} onClick={submit}>
                <ArrowUpIcon />
              </button>
            )}
          </div>

          {dragging && (
            <div className="drop-hint" aria-hidden="true">
              Soltá para adjuntar
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
