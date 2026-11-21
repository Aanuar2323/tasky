import { parseSse, type SseEvent } from "./sse.ts";
import type { ChatFile, HumanError } from "../types/chat";
import type { ReasoningLevel } from "./reasoning.ts";

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";

export interface ApiErrorBody {
  error?: string;
  kind?: string;
  retriable?: boolean;
  upstreamStatus?: number | null;
  provider?: string | null;
  errorHuman?: HumanError | null;
}

export type ApiError = Error & { status: number; body: ApiErrorBody | null; errorHuman: HumanError };

function humanFromStatus(status: number, message?: string): HumanError {
  if (status === 429) return { title: "Límite de mensajes", hint: message || "Esperá unos minutos antes de seguir.", codes: [429], retriable: true };
  if (status === 404) return { title: "No encontrado", hint: message || "El chat o el archivo ya no existe.", codes: [404], retriable: false };
  if (status === 400) return { title: "Solicitud inválida", hint: message || "Revisá el mensaje e intentá de nuevo.", codes: [400], retriable: false };
  if (status === 0) return { title: "Sin conexión con el servidor", hint: "Verificá que la API de Tasky esté funcionando.", codes: [], retriable: true };
  return { title: "Error inesperado", hint: message || "Algo salió mal. Reintentá o cambiá de modelo.", codes: status ? [status] : [], retriable: true };
}

function apiError(status: number, body: ApiErrorBody | null, fallback: string): ApiError {
  const err = new Error(body?.error || fallback) as ApiError;
  err.status = status;
  err.body = body;
  err.errorHuman = body?.errorHuman?.title ? body.errorHuman : humanFromStatus(status, body?.error);
  return err;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, options);
  } catch (e) {
    // Una cancelación no es un problema de conexión: quien la pidió la ignora.
    if ((e as Error)?.name === "AbortError") throw e;
    throw apiError(0, null, "Sin conexión con el servidor");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: ApiErrorBody | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* no es JSON */
    }
    throw apiError(res.status, body, `API ${res.status}`);
  }
  if (res.headers.get("content-type")?.includes("application/json")) {
    return res.json();
  }
  return undefined as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ── Proyectos, áreas y chats ─────────────────────────────

export interface Area {
  id: string;
  name: string;
  pinned?: boolean;
  chats: { id: string; name: string; pinned?: boolean }[];
  activeChatId: string;
}

export type ChatLogEntry = Record<string, unknown>;

export interface TreeEntry {
  name: string;
  type: string;
  path: string;
}

export const getProjects = () => request<{ projects: { id: string }[] }>("/api/projects");

export const createProject = (name?: string) => request<{ id: string }>("/api/projects", json("POST", name ? { name } : {}));

export const getAreas = (projectId: string) => request<{ areas: Area[]; activeAreaId: string }>(`/api/projects/${projectId}/areas`);

export const updateAreas = (projectId: string, data: { areas: Area[]; activeAreaId: string }) =>
  request<void>(`/api/projects/${projectId}/areas`, json("PUT", data));

export const getChatLog = (projectId: string, areaId: string, chatId: string) =>
  request<{ entries: ChatLogEntry[] }>(
    `/api/projects/${projectId}/chatlog?areaId=${encodeURIComponent(areaId)}&chatId=${encodeURIComponent(chatId)}`
  );

export const deleteChat = (projectId: string, areaId: string, chatId: string) =>
  request<void>(`/api/projects/${projectId}/chat`, json("DELETE", { areaId, chatId }));

export const deleteArea = (projectId: string, areaId: string) =>
  request<void>(`/api/projects/${projectId}/area`, json("DELETE", { areaId }));

// ── Chat en streaming ─────────────────────────────────────

export type ChatStreamEvent =
  | { event: "start"; data: { messageId: string; userMessageId?: string; provider: string; model: string; mode: string } }
  | { event: "status"; data: { phase: string; label: string; file?: string } }
  | { event: "reasoning"; data: { text: string } }
  | { event: "delta"; data: { text: string } }
  | { event: "file"; data: { file: ChatFile } }
  | { event: "done"; data: { message: ChatLogEntry } }
  | { event: "error"; data: { error: HumanError; kind: string; retriable: boolean; message?: ChatLogEntry } };

export interface StreamChatInput {
  areaId: string;
  chatId: string;
  message?: string;
  regenerate?: boolean;
  attachments?: File[];
  /** Nivel de razonamiento elegido; ausente = automático (no se envía override). */
  reasoningEffort?: string;
}

/**
 * Envía un mensaje y recibe la respuesta por Server-Sent Events.
 * Lanza ApiError si el servidor rechaza la solicitud antes de empezar a transmitir.
 */
export async function streamChat(
  projectId: string,
  input: StreamChatInput,
  { signal, onEvent }: { signal?: AbortSignal; onEvent: (e: ChatStreamEvent) => void }
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  let body: BodyInit;
  if (input.attachments?.length) {
    const form = new FormData();
    form.append("areaId", input.areaId);
    form.append("chatId", input.chatId);
    if (input.message) form.append("message", input.message);
    if (input.regenerate) form.append("regenerate", "true");
    if (input.reasoningEffort) form.append("reasoningEffort", input.reasoningEffort);
    for (const file of input.attachments) form.append("attachments", file, file.name);
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      areaId: input.areaId,
      chatId: input.chatId,
      message: input.message,
      regenerate: input.regenerate,
      reasoningEffort: input.reasoningEffort,
    });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/projects/${projectId}/chat`, { method: "POST", headers, body, signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw apiError(0, null, "Sin conexión con el servidor");
  }
  if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    let parsed: ApiErrorBody | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* no es JSON */
    }
    throw apiError(res.status, parsed, `API ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (events: SseEvent[]) => {
    for (const e of events) onEvent(e as ChatStreamEvent);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    emit(events);
  }
  buffer += decoder.decode();
  if (buffer.trim()) emit(parseSse(`${buffer}\n\n`).events);
}

// ── Archivos ──────────────────────────────────────────────

export const getTree = (projectId: string, path?: string, areaId?: string) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (areaId) params.set("areaId", areaId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<{ entries: TreeEntry[] }>(`/api/projects/${projectId}/tree${query}`);
};

export const deleteFile = (projectId: string, path: string) =>
  request<void>(`/api/projects/${projectId}/file`, json("DELETE", { path }));

export async function uploadFile(projectId: string, file: File, path?: string): Promise<{ path: string; name: string }> {
  const form = new FormData();
  form.append("file", file);
  if (path) form.append("path", path);
  return request(`/api/projects/${projectId}/upload`, { method: "POST", body: form });
}

export async function downloadFile(projectId: string, path: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/projects/${projectId}/download?path=${encodeURIComponent(path)}`);
  } catch {
    throw apiError(0, null, "Sin conexión con el servidor");
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = await res.json();
    } catch {
      /* no es JSON */
    }
    throw apiError(res.status, body, `API ${res.status}`);
  }
  return res.blob();
}

/** Descarga un archivo del proyecto con su nombre original. */
export async function saveFileToDisk(projectId: string, path: string, name: string): Promise<void> {
  const blob = await downloadFile(projectId, path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type Preview =
  | { kind: "markdown"; markdown: string; truncated?: boolean }
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "sheets"; sheets: { name: string; rows: string[][]; totalRows: number; truncated: boolean }[] }
  | { kind: "slides"; slides: { index: number; title: string; lines: string[] }[] }
  | { kind: "image" }
  | { kind: "none" };

export const getPreview = (projectId: string, path: string, signal?: AbortSignal) =>
  request<Preview>(`/api/projects/${projectId}/preview?path=${encodeURIComponent(path)}`, { signal });

export interface GeneratedFile {
  path: string;
  filename: string;
  type: string;
  summary: string | null;
  createdAt: string | null;
  chatId: string | null;
}

export const getGenerated = (projectId: string, areaId: string) =>
  request<{ files: GeneratedFile[] }>(`/api/projects/${projectId}/generated?areaId=${encodeURIComponent(areaId)}`);

export const addToHistory = (projectId: string, data: { filePath: string; areaId: string; summary?: string }) =>
  request<{ ok: boolean; historyPath: string }>(`/api/projects/${projectId}/add-to-history`, json("POST", data));

export interface HistoryGroup {
  date: string;
  days: number;
  items: { title: string; time: string; meta: string; path?: string; summary?: string }[];
}

export const getGeneratedHistory = (projectId: string, areaId: string) =>
  request<HistoryGroup[]>(`/api/projects/${projectId}/generated-history?areaId=${encodeURIComponent(areaId)}`);

// ── Reglas ────────────────────────────────────────────────

export const getRules = (projectId: string, areaId?: string) => {
  const query = areaId ? `?areaId=${encodeURIComponent(areaId)}` : "";
  return request<{ content: string }>(`/api/projects/${projectId}/rules${query}`);
};

export const updateRules = (projectId: string, markdown: string, areaId?: string) =>
  request<void>(`/api/projects/${projectId}/rules`, json("PUT", { markdown, areaId }));

// ── Proveedores y modelos ─────────────────────────────────

export type Provider = "openrouter" | "nvidia" | "chatgpt";
/** Proveedores que se configuran con API key (ChatGPT usa inicio de sesión). */
export type KeyProvider = Exclude<Provider, "chatgpt">;

export interface ProviderInfo {
  label: string;
  model: string;
  configured: boolean;
}

export interface ModelCapabilities {
  contextLength: number;
  maxOutput?: number;
  tools: boolean | null;
  vision: boolean;
  reasoning: boolean;
  /** Niveles de razonamiento que declara el modelo (vacío o ausente = no configurable). */
  reasoningLevels: ReasoningLevel[];
  /** Nivel que usa el modelo cuando no se elige ninguno. */
  defaultReasoningLevel: string | null;
}

export interface ModelInfo extends Partial<ModelCapabilities> {
  id: string;
  name: string;
  isFree: boolean;
}

export const getProviders = () => request<{ providers: Record<Provider, ProviderInfo>; activeProvider: Provider }>("/api/provider");

export const setProvider = (provider: Provider) => request<void>("/api/provider", json("POST", { provider }));

export const setProviderKey = (provider: KeyProvider, apiKey: string) =>
  request<void>("/api/provider/keys", json("POST", { provider, apiKey }));

export interface ApiStatus {
  ok: boolean;
  configured: boolean;
  provider: string;
  model: string;
  providerId: Provider | "none";
  availableProviders: Record<Provider, ProviderInfo>;
  openrouterConfigured: boolean;
  nvidiaConfigured: boolean;
  chatgptConfigured?: boolean;
  capabilities: ModelCapabilities | null;
}

export const checkApiStatus = () => request<ApiStatus>("/api/status");

export const saveSetup = (apiKey: string, model?: string, provider?: KeyProvider) =>
  request<{ ok: boolean; configured: boolean }>("/api/setup", json("POST", { apiKey, model, provider }));

export const fetchModels = (provider?: Provider) =>
  request<{ models: ModelInfo[] }>(`/api/models${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`);

export const updateModel = (model: string, provider?: Provider) =>
  request<{ ok: boolean; model: string }>("/api/model", json("PATCH", { model, provider }));

// ── ChatGPT (inicio de sesión con el plan) ────────────────
// Los tokens viven en la API de Tasky: el navegador solo ve este estado.

export interface ChatgptLoginState {
  state: "idle" | "pending" | "success" | "error";
  code?: string;
  message?: string;
  planUsage?: boolean;
}

export interface ChatgptAccount {
  id: string;
  label: string;
  email: string | null;
  active: boolean;
  signedIn: boolean;
}

export interface ChatgptStatus {
  available: boolean;
  unavailableReason: "container" | null;
  signedIn: boolean;
  planUsage: boolean;
  reauthRequired: boolean;
  email: string | null;
  accountId: string | null;
  accounts: ChatgptAccount[];
  login: ChatgptLoginState;
}

export interface ChatgptLoginResult {
  status: "pending";
  opened: boolean;
  /** Solo si la API no pudo abrir el navegador: URL de ChatGPT sin datos de sesión. */
  authorizeUrl?: string;
}

export const getChatgptStatus = () => request<ChatgptStatus>("/api/chatgpt/status");

export const startChatgptLogin = (opts: { newAccount?: boolean; reconsent?: boolean } = {}) =>
  request<ChatgptLoginResult>("/api/chatgpt/login", json("POST", opts));

export const cancelChatgptLogin = () => request<{ ok: boolean }>("/api/chatgpt/login/cancel", json("POST", {}));

export const chatgptLogout = () => request<{ ok: boolean; revoked: boolean | null }>("/api/chatgpt/logout", json("POST", {}));

export const selectChatgptAccount = (id: string) => request<{ ok: boolean }>("/api/chatgpt/account", json("POST", { id }));
