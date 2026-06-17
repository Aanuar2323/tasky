export interface ChatFile {
  name: string;
  meta: string;
  type?: string;
  url?: string;
}

export interface ChatMeta {
  complete?: boolean;
  summary?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  file?: ChatFile;
  meta?: ChatMeta;
}
