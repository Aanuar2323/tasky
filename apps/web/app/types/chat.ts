export type FileKind = "docx" | "xlsx" | "pptx" | "pdf" | "image" | "text" | "other";

export interface ChatFile {
  name: string;
  url: string;
  type: string;
  summary?: string | null;
  size?: number;
  saved?: boolean;
}

export interface ChatAttachment {
  name: string;
  size?: number;
  type?: string | null;
  path?: string;
}

export interface HumanError {
  title: string;
  hint: string;
  codes: number[];
  retriable?: boolean;
  /** Código de error del proveedor y request ID, tal cual los devolvió. */
  code?: string;
  requestId?: string;
  /** Acción sugerida por la API (p. ej. abrir el uso de ChatGPT). */
  action?: "signin" | "usage";
}

export interface ChatStatus {
  phase: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts?: number;
  files?: ChatFile[];
  attachments?: ChatAttachment[];
  error?: HumanError;
  streaming?: boolean;
  stopped?: boolean;
  status?: ChatStatus | null;
  reasoning?: string;
  reasoningMs?: number;
  model?: string;
}
