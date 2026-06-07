const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
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

export async function sendMessageStream(
  projectId: string,
  data: {
    messages: { role: string; content: string }[];
    areaId: string;
    chatId: string;
    activeTaskPath?: string;
  },
  onChunk: (delta: string) => void
): Promise<ChatResponse> {
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No stream body available");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: ChatResponse | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const line = event
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!line) continue;

      const payload = line.slice(6);
      if (payload === "[DONE]") continue;

      let chunk: { type: string; delta?: string; content?: string; id?: string; meta?: object | null; file?: object | null };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      if (chunk.type === "chunk" && chunk.delta) {
        onChunk(chunk.delta);
      }
      if (chunk.type === "done") {
        finalResponse = {
          id: chunk.id || crypto.randomUUID(),
          content: chunk.content || "",
          meta: chunk.meta ?? null,
          file: chunk.file ?? null,
        };
      }
    }
  }

  if (!finalResponse) {
    throw new Error("Stream ended without final response");
  }

  return finalResponse;
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
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
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

export async function getProviders(): Promise<unknown> {
  return request("/api/provider");
}

export async function setProvider(
  provider: "openrouter" | "nvidia"
): Promise<void> {
  return request("/api/provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

export async function healthCheck(): Promise<unknown> {
  return request("/health");
}
