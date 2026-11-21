"use client";

import { FileTile } from "./FileCard";

const SUGGESTIONS = [
  { label: "Informe en Word", prompt: "Redactá un informe en Word sobre ", file: "x.docx" },
  { label: "Planilla de Excel", prompt: "Armá una planilla de Excel con ", file: "x.xlsx" },
  { label: "Presentación", prompt: "Creá una presentación de 8 diapositivas sobre ", file: "x.pptx" },
  { label: "Resumir un archivo", prompt: "Resumí los puntos clave de ", file: "x.pdf" },
];

export default function EmptyState({ areaName, onPick }: { areaName: string; onPick: (prompt: string) => void }) {
  return (
    <div className="empty-state">
      <h1 className="es-title">{areaName || "Nuevo chat"}</h1>
      <div className="es-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.label} type="button" className="es-chip" onClick={() => onPick(s.prompt)}>
            <FileTile name={s.file} size="sm" />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
