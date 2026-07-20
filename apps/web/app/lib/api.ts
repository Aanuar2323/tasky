const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";

export interface ApiErrorBody {
  kind?: string;
  retriable?: boolean;
  upstreamStatus?: number | null;
  provider?: string | null;
  errorHuman?: { title: string; hint: string; codes: number[]; retriable?: boolean } | null;
}

type ApiError = Error & Required<ApiErrorBody>;

function enrichError(err: Error, body: ApiErrorBody | null): ApiError {
  return Object.assign(err, {
    kind: body?.kind ?? 'unknown',
    retriable: body?.retriable ?? false,
    upstreamStatus: body?.upstreamStatus ?? null,
    provider: body?.provider ?? null,
    errorHuman: body?.errorHuman ?? null,
  }) as ApiError;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: ApiErrorBody | null = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    throw enrichError(new Error(`API ${res.status}: ${text || res.statusText}`), body);
  }
  if (res.headers.get("content-type")?.includes("application/json")) {
    return res.json();
  }
  return res as unknown as T;
}

export interface Area {
  id: string;
  name: string;
  pinned?: boolean;
  chats: { id: string; name: string; pinned?: boolean }[];
  activeChatId: string;
}

export interface ChatLogEntry {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface ChatResponse {
  id: string;
  content: string;
  meta: object | null;
  file: object | null;
}

export interface TreeEntry {
  name: string;
  type: string;
  path: string;
}

export async function getProjects(): Promise<{
  projects: { id: string }[];
}> {
  return request("/api/projects");
}

export async function createProject(
  name?: string
): Promise<{ id: string }> {
  return request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
}

export async function getAreas(
  projectId: string
): Promise<{ areas: Area[]; activeAreaId: string }> {
  return request(`/api/projects/${projectId}/areas`);
}

export async function updateAreas(
  projectId: string,
  data: { areas: Area[]; activeAreaId: string }
): Promise<void> {
  return request(`/api/projects/${projectId}/areas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function getChatLog(
  projectId: string,
  areaId: string,
  chatId: string
): Promise<{ entries: ChatLogEntry[] }> {
  return request(
    `/api/projects/${projectId}/chatlog?areaId=${encodeURIComponent(areaId)}&chatId=${encodeURIComponent(chatId)}`
  );
}

export async function sendMessage(
  projectId: string,
  data: {
    messages: { role: string; content: string }[];
    areaId: string;
    chatId: string;
    activeTaskPath?: string;
  }
): Promise<ChatResponse> {
  return request(`/api/projects/${projectId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function getRules(
  projectId: string,
  areaId?: string
): Promise<{ content: string }> {
  const query = areaId ? `?areaId=${encodeURIComponent(areaId)}` : "";
  return request(`/api/projects/${projectId}/rules${query}`);
}

export async function updateRules(
  projectId: string,
  markdown: string,
  areaId?: string
): Promise<void> {
  return request(`/api/projects/${projectId}/rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, areaId }),
  });
}

export async function getTree(
  projectId: string,
  path?: string,
  areaId?: string
): Promise<{ entries: TreeEntry[] }> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (areaId) params.set("areaId", areaId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/projects/${projectId}/tree${query}`);
}

export async function readFile(
  projectId: string,
  path: string
): Promise<{ content: string }> {
  return request(
    `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`
  );
}

export async function writeFile(
  projectId: string,
  path: string,
  content: string
): Promise<void> {
  return request(`/api/projects/${projectId}/file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

export async function deleteFile(
  projectId: string,
  path: string
): Promise<void> {
  return request(`/api/projects/${projectId}/file`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function uploadFile(
  projectId: string,
  file: File,
  path?: string
): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  if (path) form.append("path", path);
  return request(`/api/projects/${projectId}/upload`, {
    method: "POST",
    body: form,
  });
}

export async function downloadFile(
  projectId: string,
  path: string
): Promise<Blob> {
  const res = await fetch(
    `${BASE_URL}/api/projects/${projectId}/download?path=${encodeURIComponent(path)}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: ApiErrorBody | null = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    throw enrichError(new Error(`API ${res.status}: ${text || res.statusText}`), body);
  }
  return res.blob();
}

export async function generateFile(
  projectId: string,
  data: Record<string, unknown>
): Promise<void> {
  return request(`/api/projects/${projectId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function addToHistory(
  projectId: string,
  data: Record<string, unknown>
): Promise<void> {
  return request(`/api/projects/${projectId}/add-to-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function getGeneratedHistory(
  projectId: string,
  areaId: string
): Promise<unknown> {
  return request(
    `/api/projects/${projectId}/generated-history?areaId=${encodeURIComponent(areaId)}`
  );
}

export async function deleteChat(
  projectId: string,
  areaId: string,
  chatId: string
): Promise<void> {
  return request(`/api/projects/${projectId}/chat`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ areaId, chatId }),
  });
}

export async function deleteArea(
  projectId: string,
  areaId: string
): Promise<void> {
  return request(`/api/projects/${projectId}/area`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ areaId }),
  });
}

export async function createTask(
  projectId: string,
  title: string,
  body?: string
): Promise<void> {
  return request(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
}

export async function completeTask(
  projectId: string,
  taskPath: string,
  note?: string
): Promise<void> {
  return request(`/api/projects/${projectId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskPath, note }),
  });
}

// ── Providers ─────────────────────────────────────────────

export type Provider = "openrouter" | "nvidia";

export interface ProviderInfo {
  label: string;
  model: string;
  configured: boolean;
}

export interface ProvidersResponse {
  providers: Record<Provider, ProviderInfo>;
  activeProvider: Provider;
}

export async function getProviders(): Promise<ProvidersResponse> {
  return request("/api/provider");
}

export async function setProvider(
  provider: Provider
): Promise<void> {
  return request("/api/provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

export async function setProviderKey(
  provider: Provider,
  apiKey: string
): Promise<void> {
  return request("/api/provider/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
}

export async function healthCheck(): Promise<unknown> {
  return request("/health");
}

// ── Status ────────────────────────────────────────────────

export interface ApiStatus {
  ok: boolean;
  configured: boolean;
  provider: string;
  model: string;
  providerId: Provider;
  availableProviders: Record<Provider, ProviderInfo>;
  openrouterConfigured: boolean;
  nvidiaConfigured: boolean;
}

export async function checkApiStatus(): Promise<ApiStatus> {
  return request("/api/status");
}

// ── Setup ─────────────────────────────────────────────────

export async function saveSetup(
  apiKey: string,
  model?: string,
  provider?: Provider
): Promise<{ ok: boolean; configured: boolean }> {
  return request("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, model, provider }),
  });
}

// ── Models ────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  isFree: boolean;
}

export async function fetchModels(
  provider?: Provider
): Promise<{ models: ModelInfo[] }> {
  const params = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return request(`/api/models${params}`);
}

export async function updateModel(
  model: string,
  provider?: Provider
): Promise<{ ok: boolean; model: string }> {
  return request("/api/model", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, provider }),
  });
}
