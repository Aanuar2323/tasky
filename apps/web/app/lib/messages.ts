import type { ChatAttachment, ChatFile, ChatMessage, FileKind, HumanError } from "../types/chat";

type LogEntry = Record<string, unknown>;

const KIND_BY_EXT: Record<string, FileKind> = {
  docx: "docx",
  doc: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  csv: "xlsx",
  pptx: "pptx",
  ppt: "pptx",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  md: "text",
  markdown: "text",
  txt: "text",
  json: "text",
};

/** Tipo visual de un archivo a partir de su nombre, extensión o mime. */
export function fileKind(nameOrType: string): FileKind {
  const value = String(nameOrType || "").toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value === "application/pdf") return "pdf";
  const ext = value.includes(".") ? value.split(".").pop() ?? "" : value;
  return KIND_BY_EXT[ext] ?? "other";
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/** Normaliza cualquier forma histórica de archivo a ChatFile. */
export function fileFromAny(raw: unknown): ChatFile | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const url = String(f.url ?? f.path ?? "");
  const name = String(f.name ?? f.filename ?? url.split("/").pop() ?? "");
  if (!url || !name) return null;
  const type = String(f.type ?? name.split(".").pop() ?? "").toLowerCase();
  return {
    name,
    url,
    type,
    summary: typeof f.summary === "string" ? f.summary : null,
    size: typeof f.size === "number" ? f.size : undefined,
  };
}

function filesOf(entry: LogEntry): ChatFile[] {
  const list = Array.isArray(entry.files) && entry.files.length ? entry.files : entry.file ? [entry.file] : [];
  return list.map(fileFromAny).filter((f): f is ChatFile => !!f);
}

function attachmentsOf(entry: LogEntry): ChatAttachment[] | undefined {
  if (!Array.isArray(entry.attachments) || !entry.attachments.length) return undefined;
  return entry.attachments
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      name: String(a.name ?? ""),
      size: typeof a.size === "number" ? a.size : undefined,
      type: typeof a.type === "string" ? a.type : null,
      path: typeof a.path === "string" ? a.path : undefined,
    }));
}

/** Entrada del historial persistido → mensaje de la UI (o null si no se muestra). */
export function fromLogEntry(entry: LogEntry, index: number): ChatMessage | null {
  const role = entry.role;
  const id = typeof entry.id === "string" && entry.id ? entry.id : `log-${index}-${String(entry.ts ?? "")}`;
  const ts = typeof entry.ts === "number" ? entry.ts : undefined;
  if (role === "user") {
    return { id, role: "user", content: String(entry.content ?? ""), ts, attachments: attachmentsOf(entry) };
  }
  if (role === "assistant") {
    const err = entry.error as HumanError | undefined;
    return {
      id,
      role: "assistant",
      content: String(entry.content ?? ""),
      ts,
      files: filesOf(entry),
      error: err?.title ? err : undefined,
      stopped: entry.stopped === true ? true : undefined,
      model: typeof entry.model === "string" ? entry.model : undefined,
    };
  }
  if (role === "system") {
    const files = filesOf(entry);
    if (!files.length) return null;
    return { id, role: "assistant", content: "", ts, files };
  }
  return null;
}

export function fromLogEntries(entries: LogEntry[]): ChatMessage[] {
  return entries.map(fromLogEntry).filter((m): m is ChatMessage => !!m);
}
