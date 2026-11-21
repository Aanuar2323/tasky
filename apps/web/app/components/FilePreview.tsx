"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { downloadFile, getPreview, type Preview } from "../lib/api";
import { isNumericCell, splitSheet } from "../lib/sheet";
import type { ChatFile } from "../types/chat";
import { FileTile } from "./FileCard";
import MarkdownRenderer from "./MarkdownRenderer";
import { DownloadIcon, XIcon } from "./icons";

function SheetView({ sheets }: { sheets: Extract<Preview, { kind: "sheets" }>["sheets"] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active];
  if (!sheet) return <p className="pv-empty">La planilla está vacía.</p>;
  const { title, header, body } = splitSheet(sheet.rows);
  return (
    <div className="pv-sheets">
      {sheets.length > 1 && (
        <div className="pv-tabs" role="tablist" aria-label="Hojas">
          {sheets.map((s, i) => (
            <button key={s.name} type="button" role="tab" aria-selected={i === active} className="pv-tab" onClick={() => setActive(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="pv-table-wrap">
        <table className="pv-table">
          {title && <caption>{title}</caption>}
          {header && (
            <thead>
              <tr>
                {header.map((c, i) => (
                  <th key={i} data-numeric={i > 0 && body.some((r) => isNumericCell(r[i] ?? "")) ? "true" : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri} data-total={/^totale?s?$/i.test(r[0]?.trim() ?? "") ? "true" : undefined}>
                {r.map((c, ci) => (
                  <td key={ci} data-numeric={isNumericCell(c) ? "true" : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated && <p className="pv-note">Vista parcial: {sheet.rows.length} de {sheet.totalRows} filas.</p>}
    </div>
  );
}

function SlidesView({ slides }: { slides: Extract<Preview, { kind: "slides" }>["slides"] }) {
  if (!slides.length) return <p className="pv-empty">La presentación no tiene texto.</p>;
  return (
    <ol className="pv-slides">
      {slides.map((s) => (
        <li key={s.index} className="pv-slide">
          <span className="pv-slide-num">{s.index}</span>
          <div className="pv-slide-title">{s.title}</div>
          {s.lines.length > 0 && (
            <ul>
              {s.lines.slice(0, 8).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

interface FilePreviewProps {
  projectId: string;
  file: ChatFile;
  onClose: () => void;
  onDownload: (file: ChatFile) => void;
}

export default function FilePreview({ projectId, file, onClose, onDownload }: FilePreviewProps) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useFocusTrap<HTMLElement>(true);

  useEffect(() => {
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    getPreview(projectId, file.url, ctrl.signal)
      .then(async (p) => {
        if (p.kind === "image") {
          const blob = await downloadFile(projectId, file.url);
          if (ctrl.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
        }
        if (!ctrl.signal.aborted) setPreview(p);
      })
      .catch((e: Error) => {
        if (!ctrl.signal.aborted) setError(e.message || "No se pudo cargar la vista previa");
      });
    return () => {
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, file.url]);

  useEffect(() => {
    closeRef.current?.focus();
    // En captura: la vista previa se cierra antes que los paneles de abajo.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  let body: React.ReactNode;
  if (error) body = <p className="pv-empty">{error}</p>;
  else if (!preview) body = <div className="pv-loading" aria-label="Cargando vista previa"><span /><span /><span /></div>;
  else if (preview.kind === "markdown") {
    body = (
      <>
        <div className="pv-paper">
          <MarkdownRenderer content={preview.markdown || "_Documento sin texto._"} className="md-paper" />
        </div>
        {preview.truncated && <p className="pv-note">Vista parcial del documento.</p>}
      </>
    );
  } else if (preview.kind === "sheets") body = <SheetView sheets={preview.sheets} />;
  else if (preview.kind === "slides") body = <SlidesView slides={preview.slides} />;
  else if (preview.kind === "text") body = <pre className="pv-text">{preview.text || "Sin texto legible."}</pre>;
  else if (preview.kind === "image" && imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    body = <img className="pv-image" src={imageUrl} alt={file.name} />;
  } else {
    body = (
      <div className="pv-empty">
        <p>Este archivo no tiene vista previa.</p>
        <button type="button" className="btn" onClick={() => onDownload(file)}>
          <DownloadIcon /> Descargar
        </button>
      </div>
    );
  }

  return (
    <div className="preview-layer">
      <div className="preview-backdrop" onClick={onClose} />
      <aside ref={drawerRef} className="preview-drawer" role="dialog" aria-modal="true" aria-label={`Vista previa de ${file.name}`}>
        <header className="pv-head">
          <FileTile name={file.name} />
          <div className="pv-heading">
            <div className="pv-title">{file.name}</div>
            {file.summary && <div className="pv-sub">{file.summary}</div>}
          </div>
          <button type="button" className="btn" onClick={() => onDownload(file)}>
            <DownloadIcon /> <span className="btn-label">Descargar</span>
          </button>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Cerrar vista previa" onClick={onClose}>
            <XIcon />
          </button>
        </header>
        <div className="pv-body">{body}</div>
      </aside>
    </div>
  );
}
