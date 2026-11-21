"use client";

import { memo } from "react";
import { fileKind, formatBytes } from "../lib/messages";
import type { ChatFile, FileKind } from "../types/chat";
import { BookmarkIcon, CheckIcon, DownloadIcon } from "./icons";

export const KIND_LABEL: Record<FileKind, string> = {
  docx: "DOCX",
  xlsx: "XLSX",
  pptx: "PPTX",
  pdf: "PDF",
  image: "IMG",
  text: "TXT",
  other: "FILE",
};

/** Etiqueta con la extensión real (CSV, PNG…); el color indica el tipo de archivo. */
function tileLabel(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() ?? "" : "";
  return /^[A-Z0-9]{1,4}$/.test(ext) ? ext : KIND_LABEL[fileKind(name)];
}

export function FileTile({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span className="fc-tile" data-kind={fileKind(name)} data-size={size} aria-hidden="true">
      {tileLabel(name)}
    </span>
  );
}

interface FileCardProps {
  file: ChatFile;
  onPreview: (file: ChatFile) => void;
  onDownload: (file: ChatFile) => void;
  onSave?: (file: ChatFile) => void;
}

function FileCard({ file, onPreview, onDownload, onSave }: FileCardProps) {
  const detail = file.summary || formatBytes(file.size);
  return (
    <div className="file-card" data-kind={fileKind(file.name)}>
      <button type="button" className="fc-main" onClick={() => onPreview(file)} aria-label={`Vista previa de ${file.name}`}>
        <FileTile name={file.name} />
        <span className="fc-body">
          <span className="fc-name">{file.name}</span>
          {detail && <span className="fc-meta">{detail}</span>}
        </span>
      </button>
      <div className="fc-actions">
        <button type="button" className="icon-btn" data-tip="Descargar" aria-label={`Descargar ${file.name}`} onClick={() => onDownload(file)}>
          <DownloadIcon />
        </button>
        {onSave && (
          <button
            type="button"
            className="icon-btn"
            data-tip={file.saved ? "En el historial" : "Guardar en historial"}
            aria-label={file.saved ? "Guardado en el historial" : `Guardar ${file.name} en el historial`}
            aria-pressed={!!file.saved}
            disabled={file.saved}
            onClick={() => onSave(file)}
          >
            {file.saved ? <CheckIcon /> : <BookmarkIcon />}
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(FileCard);
