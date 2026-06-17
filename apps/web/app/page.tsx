"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Topbar from "./components/Topbar";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import Composer from "./components/Composer";
import SidePanel from "./components/SidePanel";
import ModelBar from "./components/ModelBar";
import {
  getProjects,
  createProject,
  getAreas,
  updateAreas,
  getChatLog,
  sendMessage,
  createTask,
  addToHistory,
  getTree,
  getGeneratedHistory,
  getRules,
  updateRules,
  checkApiStatus,
  saveSetup,
  fetchModels,
  updateModel,
  deleteFile,
  uploadFile,
  downloadFile,
  deleteChat,
  deleteArea,
} from "./lib/api";
import type { Area, ChatLogEntry, TreeEntry, ModelInfo } from "./lib/api";
import type { ChatMessage } from "./types/chat";

export default function Home() {
  const [projectId, setProjectId] = useState<string>("");
  const [areas, setAreas] = useState<Area[]>([]);
  const [activeAreaId, setActiveAreaId] = useState<string>("");
  const [activeChatId, setActiveChatId] = useState<string>("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<"info" | "historial" | "reglas">("info");
  const [loading, setLoading] = useState(false);

  const [setupMode, setSetupMode] = useState(true);
  const [setupApiKey, setSetupApiKey] = useState("");
  const [setupModel, setSetupModel] = useState("");
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);

  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [generatedHistory, setGeneratedHistory] = useState<unknown>(null);
  const [rulesContent, setRulesContent] = useState<string>("");
  const sidePanelCacheRef = useRef<Map<string, { tree?: TreeEntry[]; history?: unknown; rules?: string }>>(new Map());

  const loadChatLog = useCallback(
    async (pId: string, aId: string, cId: string) => {
      try {
        const { entries } = await getChatLog(pId, aId, cId);
        setChatMessages(
          entries.map((e: ChatLogEntry) => {
            const rawFile = e.file as Record<string, unknown> | undefined;
            const file = rawFile?.name
              ? rawFile as unknown as ChatMessage["file"]
              : rawFile
                ? { name: String(rawFile.filename ?? ""), url: String(rawFile.path ?? ""), type: String(rawFile.type ?? ""), meta: String(rawFile.type ?? "").toUpperCase() }
                : undefined;
            return {
              role: e.role as "user" | "assistant",
              content: e.content,
              ts: e.ts as number | undefined,
              file,
              meta: e.meta as ChatMessage["meta"],
            } as ChatMessage;
          })
        );
      } catch {
        setChatMessages([]);
      }
    },
    []
  );

  const loadSidePanelData = useCallback(
    async (pId: string, aId: string, tab: "info" | "historial" | "reglas") => {
      const cacheKey = `${pId}:${aId}`;
      const cached = sidePanelCacheRef.current.get(cacheKey) ?? {};
      if (tab === "info") {
        if (cached.tree) {
          setTreeEntries(cached.tree);
          return;
        }
        try {
          const { entries } = await getTree(pId, undefined, aId);
          setTreeEntries(entries);
          sidePanelCacheRef.current.set(cacheKey, { ...cached, tree: entries });
        } catch {
          setTreeEntries([]);
        }
      }
      if (tab === "historial") {
        try {
          const hist = await getGeneratedHistory(pId, aId);
          setGeneratedHistory(hist);
          sidePanelCacheRef.current.set(cacheKey, { ...cached, history: hist });
        } catch {
          setGeneratedHistory(null);
        }
      }
      if (tab === "reglas") {
        if (typeof cached.rules === "string") {
          setRulesContent(cached.rules);
          return;
        }
        try {
          const { content } = await getRules(pId, aId);
          setRulesContent(content);
          sidePanelCacheRef.current.set(cacheKey, { ...cached, rules: content });
        } catch {
          setRulesContent("");
        }
      }
    },
    []
  );

  useEffect(() => {
    async function init() {
      try {
        const status = await checkApiStatus();
        if (!status.configured) {
          setSetupMode(true);
          return;
        }
        setCurrentModel(status.model || "");
      } catch {
        setSetupMode(true);
        return;
      }

      setSetupMode(false);

      try {
      const { projects: projs } = await getProjects();
      let pId: string;

      if (!projs.length) {
        const created = await createProject("Tasky");
        pId = created.id;
      } else {
        pId = projs[0].id;
      }

      setProjectId(pId);

        const { areas: areaList, activeAreaId: aAreaId } = await getAreas(pId);
        setAreas(areaList);
        setActiveAreaId(aAreaId);

        const activeArea =
          areaList.find((a) => a.id === aAreaId) || areaList[0];
        const cId =
          activeArea?.activeChatId || activeArea?.chats?.[0]?.id || "";
        setActiveChatId(cId);

        if (cId) {
          await loadChatLog(pId, aAreaId, cId);
        }
      } catch (err) {
        console.error("Init failed:", err);
      }
    }

    const saved = localStorage.getItem("sidebarCollapsed");
    if (saved !== null) {
      setSidebarCollapsed(saved === "true");
    }

    init();
  }, [loadChatLog]);

  useEffect(() => {
    localStorage.setItem("sidebarCollapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const handleSelectArea = useCallback(
    async (areaId: string) => {
      if (!projectId) return;
      setActiveAreaId(areaId);
      const area = areas.find((a) => a.id === areaId);
      const cId = area?.activeChatId || area?.chats?.[0]?.id || "";
      setActiveChatId(cId);
      const nextAreas = areas.map((a) => (a.id === areaId ? { ...a, activeChatId: cId || a.activeChatId } : a));
      setAreas(nextAreas);
      setSidePanelOpen(false);
      await updateAreas(projectId, { areas: nextAreas, activeAreaId: areaId });
      if (cId) {
        await loadChatLog(projectId, areaId, cId);
      } else {
        setChatMessages([]);
      }
    },
    [projectId, areas, loadChatLog]
  );

  const handleAddArea = useCallback(async () => {
    if (!projectId) return;
    const name = `Área ${areas.length + 1}`;
    const newArea: Area = {
      id: crypto.randomUUID(),
      name,
      pinned: false,
      chats: [{ id: crypto.randomUUID(), name: "Chat 1", pinned: false }],
      activeChatId: "",
    };
    newArea.activeChatId = newArea.chats[0].id;
    const updatedAreas = [...areas, newArea];
    setAreas(updatedAreas);
    setActiveAreaId(newArea.id);
    setActiveChatId(newArea.activeChatId);
    setChatMessages([]);
    try {
      await updateAreas(projectId, {
        areas: updatedAreas,
        activeAreaId: newArea.id,
      });
    } catch (err) {
      console.error("Add area failed:", err);
    }
  }, [projectId, areas]);

  const handleSelectChat = useCallback(
    async (areaId: string, chatId: string) => {
      if (!projectId) return;
      setActiveAreaId(areaId);
      setActiveChatId(chatId);
      const updatedAreas = areas.map((a) =>
        a.id === areaId ? { ...a, activeChatId: chatId } : a
      );
      setAreas(updatedAreas);
      setSidePanelOpen(false);
      await updateAreas(projectId, { areas: updatedAreas, activeAreaId: areaId });
      await loadChatLog(projectId, areaId, chatId);
    },
    [projectId, areas, loadChatLog]
  );

  const handleAddChat = useCallback(
    async (areaId: string) => {
      if (!projectId) return;
      const area = areas.find((a) => a.id === areaId);
      if (!area) return;
      const chatNum = area.chats.length + 1;
      const newChat = { id: crypto.randomUUID(), name: `Chat ${chatNum}`, pinned: false };
      const updatedChats = [...area.chats, newChat];
      const updatedAreas = areas.map((a) =>
        a.id === areaId ? { ...a, chats: updatedChats, activeChatId: newChat.id } : a
      );
      setAreas(updatedAreas);
      setActiveAreaId(areaId);
      setActiveChatId(newChat.id);
      setChatMessages([]);
      try {
        await updateAreas(projectId, { areas: updatedAreas, activeAreaId });
      } catch (err) {
        console.error("Add chat failed:", err);
      }
    },
    [projectId, areas]
  );

  const handleRenameChat = useCallback(
    async (areaId: string, chatId: string, name: string) => {
      if (!projectId) return;
      const updatedAreas = areas.map((a) =>
        a.id === areaId
          ? { ...a, chats: a.chats.map((c) => (c.id === chatId ? { ...c, name } : c)) }
          : a
      );
      setAreas(updatedAreas);
      try {
        await updateAreas(projectId, { areas: updatedAreas, activeAreaId });
      } catch (err) {
        console.error("Rename chat failed:", err);
      }
    },
    [projectId, areas, activeAreaId]
  );

  const handleDeleteChat = useCallback(
    async (areaId: string, chatId: string) => {
      if (!projectId) return;
      const area = areas.find((a) => a.id === areaId);
      if (!area || area.chats.length <= 1) return;
      const updatedChats = area.chats.filter((c) => c.id !== chatId);
      let newActiveChatId = activeChatId;
      if (chatId === activeChatId) {
        newActiveChatId = updatedChats[0]?.id || "";
      }
      const updatedAreas = areas.map((a) =>
        a.id === areaId
          ? { ...a, chats: updatedChats, activeChatId: newActiveChatId }
          : a
      );
      setAreas(updatedAreas);
      if (areaId === activeAreaId) {
        setActiveChatId(newActiveChatId);
        if (chatId === activeChatId && newActiveChatId) {
          await loadChatLog(projectId, areaId, newActiveChatId);
        }
      }
      try {
        await updateAreas(projectId, { areas: updatedAreas, activeAreaId });
      } catch (err) {
        console.error("Delete chat failed:", err);
      }
    },
    [projectId, areas, activeAreaId, activeChatId, loadChatLog]
  );

  const handleOpenPanel = useCallback(
    (areaId: string, tab: "info" | "historial" | "reglas") => {
      if (areaId !== activeAreaId) {
        setActiveAreaId(areaId);
        const area = areas.find((a) => a.id === areaId);
        const cId = area?.activeChatId || area?.chats?.[0]?.id || "";
        setActiveChatId(cId);
        if (projectId && cId) {
          loadChatLog(projectId, areaId, cId);
        }
      }
      setSidePanelTab(tab);
      setSidePanelOpen(true);
      if (projectId && areaId) {
        loadSidePanelData(projectId, areaId, tab);
      }
    },
    [projectId, activeAreaId, areas, loadChatLog, loadSidePanelData]
  );

  const handleOpenPanelFromTopbar = useCallback(
    (tab: "info" | "historial" | "reglas") => {
      setSidePanelTab(tab);
      setSidePanelOpen(true);
      if (projectId && activeAreaId) {
        loadSidePanelData(projectId, activeAreaId, tab);
      }
    },
    [projectId, activeAreaId, loadSidePanelData]
  );

  const handleSend = useCallback(() => {
    if (!projectId || !activeAreaId || !activeChatId || !inputText.trim()) return;

    const userMsg: ChatMessage = {
      role: "user",
      content: inputText.trim(),
      ts: Date.now(),
    };

    setInputText("");
    setLoading(true);

    const allMessages = [...chatMessages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setChatMessages((prev) => [...prev, userMsg]);
    sendMessage(projectId, {
      messages: allMessages,
      areaId: activeAreaId,
      chatId: activeChatId,
    })
      .then((res) => {
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: res.content,
          ts: Date.now(),
          file: res.file as ChatMessage["file"],
          meta: res.meta as ChatMessage["meta"],
        };
        setChatMessages((prev) => [...prev, assistantMsg]);
      })
      .catch((err) => {
        console.error("Send failed:", err);
        const kind = (err as any).kind;
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: kind === "unauthorized"
              ? "API key inválida o sin fondos."
              : `Error: ${err instanceof Error ? err.message : "Error del servidor"}`,
            ts: Date.now(),
          },
        ]);
      })
      .finally(() => setLoading(false));
  }, [projectId, activeAreaId, activeChatId, chatMessages, inputText]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleCloseSidePanel = useCallback(() => {
    setSidePanelOpen(false);
  }, []);

  const handleChangeSidePanelTab = useCallback(
    (tab: "info" | "historial" | "reglas") => {
      setSidePanelTab(tab);
      if (projectId && activeAreaId) {
        loadSidePanelData(projectId, activeAreaId, tab);
      }
    },
    [projectId, activeAreaId, loadSidePanelData]
  );

  const handleUpdateRules = useCallback(
    async (markdown: string) => {
      if (!projectId || !activeAreaId) return;
      try {
        const { updateRules } = await import("./lib/api");
        await updateRules(projectId, markdown, activeAreaId);
        setRulesContent(markdown);
        const key = `${projectId}:${activeAreaId}`;
        const cached = sidePanelCacheRef.current.get(key) ?? {};
        sidePanelCacheRef.current.set(key, { ...cached, rules: markdown });
      } catch (err) {
        console.error("Update rules failed:", err);
      }
    },
    [projectId, activeAreaId]
  );

  const handleAttach = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !projectId) return;
      try {
        const { uploadFile } = await import("./lib/api");
        await uploadFile(projectId, file);
      } catch (err) {
        console.error("Upload failed:", err);
      }
    };
    input.click();
  }, [projectId]);

  const handleUploadContextFile = useCallback(async () => {
    if (!projectId || !activeAreaId) return;
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const { uploadFile } = await import("./lib/api");
        await uploadFile(projectId, file, `ai/layer2/areas/${activeAreaId}`);
        const key = `${projectId}:${activeAreaId}`;
        const cached = sidePanelCacheRef.current.get(key) ?? {};
        sidePanelCacheRef.current.set(key, { ...cached, tree: undefined });
        await loadSidePanelData(projectId, activeAreaId, "info");
      } catch (err) {
        console.error("Upload context failed:", err);
      }
    };
    input.click();
  }, [projectId, activeAreaId, loadSidePanelData]);

  const handleDeleteContextFile = useCallback(
    async (filePath: string) => {
      if (!projectId || !activeAreaId) return;
      try {
        await deleteFile(projectId, filePath);
        const key = `${projectId}:${activeAreaId}`;
        const cached = sidePanelCacheRef.current.get(key) ?? {};
        sidePanelCacheRef.current.set(key, { ...cached, tree: undefined });
        await loadSidePanelData(projectId, activeAreaId, "info");
      } catch (err) {
        console.error("Delete context failed:", err);
      }
    },
    [projectId, activeAreaId, loadSidePanelData]
  );

  const handleRefreshInfo = useCallback(async () => {
    if (!projectId || !activeAreaId) return;
    const key = `${projectId}:${activeAreaId}`;
    const cached = sidePanelCacheRef.current.get(key) ?? {};
    sidePanelCacheRef.current.set(key, { ...cached, tree: undefined });
    await loadSidePanelData(projectId, activeAreaId, "info");
  }, [projectId, activeAreaId, loadSidePanelData]);

  const handleDownload = useCallback(
    async (file: ChatMessage["file"]) => {
      if (!file || !projectId) return;
      try {
        const path = file.url || file.name;
        const blob = await downloadFile(projectId, path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("Download failed:", err);
      }
    },
    [projectId]
  );

  const handleConfirm = useCallback(async (msgIndex?: number) => {
    if (!projectId || !activeAreaId) return;
    const idx = msgIndex ?? chatMessages.length - 1;
    const msg = chatMessages[idx];
    const filePath = msg?.file?.url || msg?.file?.name;
    if (!filePath) return;
    try {
      await addToHistory(projectId, {
        filePath,
        areaId: activeAreaId,
        summary: msg?.meta?.summary ?? '',
      });
      setChatMessages((prev) =>
        prev.map((m, i) =>
          i === idx && m.meta?.complete
            ? { ...m, meta: { ...m.meta, complete: false } }
            : m
        )
      );
    } catch (err) {
      console.error("Confirm failed:", err);
    }
  }, [projectId, activeAreaId, chatMessages]);

  const handleDeny = useCallback((msgIndex?: number) => {
    setChatMessages((prev) => {
      const idx = msgIndex ?? prev.length - 1;
      return prev.map((m, i) =>
        i === idx && m.meta?.complete
          ? { ...m, meta: { ...m.meta, complete: false } }
          : m
      );
    });
  }, []);

  const handleFetchModels = useCallback(async () => {
    if (!setupApiKey.trim()) {
      setSetupError("Ingresa una API key primero");
      return;
    }
    setModelsLoading(true);
    setSetupError("");
    try {
      const { models: modelList } = await fetchModels(setupApiKey.trim());
      setModels(modelList);
      setModelsFetched(true);
      if (modelList.length > 0) {
        setSetupModel(modelList[0].id);
      }
    } catch (err) {
      setSetupError(`Error al cargar modelos: ${err instanceof Error ? err.message : "API key inválida"}`);
    } finally {
      setModelsLoading(false);
    }
  }, [setupApiKey]);

  const handleSaveSetup = useCallback(async () => {
    if (!setupApiKey.trim()) {
      setSetupError("Ingresa una API key");
      return;
    }
    setSetupSaving(true);
    setSetupError("");
    try {
      await saveSetup(setupApiKey.trim(), setupModel || undefined);
      setSetupMode(false);
      window.location.reload();
    } catch (err) {
      setSetupError(`Error: ${err instanceof Error ? err.message : "No se pudo guardar la config"}`);
    } finally {
      setSetupSaving(false);
    }
  }, [setupApiKey, setupModel]);

  const handleChangeModel = useCallback(async (model: string) => {
    try {
      await updateModel(model);
      setCurrentModel(model);
    } catch (err) {
      console.error("Error cambiando modelo:", err);
    }
  }, []);

  const handleFetchModelsInApp = useCallback(async () => {
    setModelsLoading(true);
    try {
      const { models: modelList } = await fetchModels("");
      setModels(modelList);
      setModelsFetched(true);
    } catch (err) {
      console.error("Error cargando modelos:", err);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  if (setupMode) {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <h1 className="setup-title">Tasky</h1>
          <p className="setup-subtitle">
            Para usar la app necesitás una API key de OpenRouter.
          </p>
          <div className="setup-field">
            <label htmlFor="apiKey">API Key de OpenRouter</label>
            <input
              id="apiKey"
              type="password"
              placeholder="sk-or-v1-..."
              value={setupApiKey}
              onChange={(e) => setSetupApiKey(e.target.value)}
            />
          </div>
          <div className="setup-field">
            <label htmlFor="model">Modelo</label>
            {modelsFetched && models.length > 0 ? (
              <select
                id="model"
                value={setupModel}
                onChange={(e) => setSetupModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.isFree ? ' (free)' : ''} — {m.id}
                  </option>
                ))}
              </select>
            ) : (
              <div className="setup-model-row">
                <input
                  id="model"
                  type="text"
                  placeholder="openai/gpt-oss-120b:free"
                  value={setupModel}
                  onChange={(e) => setSetupModel(e.target.value)}
                />
                <button
                  className="setup-fetch-btn"
                  onClick={handleFetchModels}
                  disabled={modelsLoading || !setupApiKey.trim()}
                >
                  {modelsLoading ? "Cargando..." : "Cargar modelos"}
                </button>
              </div>
            )}
          </div>
          {setupError && <p className="setup-error">{setupError}</p>}
          <button
            className="setup-btn"
            onClick={handleSaveSetup}
            disabled={setupSaving}
          >
            {setupSaving ? "Guardando..." : "Comenzar"}
          </button>
        </div>
        <style>{`
          .setup-screen {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: #0a0a0a;
            font-family: system-ui, sans-serif;
          }
          .setup-card {
            background: #1a1a1a;
            padding: 2.5rem;
            border-radius: 1rem;
            width: 100%;
            max-width: 420px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.4);
          }
          .setup-title {
            font-size: 1.8rem;
            font-weight: 700;
            text-align: center;
            color: #fff;
            margin: 0 0 0.5rem;
          }
          .setup-subtitle {
            text-align: center;
            color: #999;
            font-size: 0.9rem;
            margin: 0 0 1.5rem;
            line-height: 1.4;
          }
          .setup-field {
            margin-bottom: 1rem;
          }
          .setup-field label {
            display: block;
            font-size: 0.85rem;
            color: #ccc;
            margin-bottom: 0.35rem;
          }
          .setup-field input {
            width: 100%;
            padding: 0.65rem 0.75rem;
            border-radius: 0.5rem;
            border: 1px solid #333;
            background: #111;
            color: #fff;
            font-size: 0.95rem;
            box-sizing: border-box;
          }
          .setup-field input::placeholder {
            color: #555;
          }
          .setup-field select {
            width: 100%;
            padding: 0.65rem 0.75rem;
            border-radius: 0.5rem;
            border: 1px solid #333;
            background: #111;
            color: #fff;
            font-size: 0.95rem;
            box-sizing: border-box;
            appearance: none;
            cursor: pointer;
          }
          .setup-field select optgroup,
          .setup-field select option {
            background: #1a1a1a;
            color: #ccc;
            padding: 4px 8px;
          }
          .setup-model-row {
            display: flex;
            gap: 8px;
          }
          .setup-model-row input {
            flex: 1;
          }
          .setup-fetch-btn {
            padding: 0.65rem 1rem;
            border-radius: 0.5rem;
            border: 1px solid #333;
            background: #222;
            color: #ccc;
            font-size: 0.85rem;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.2s, color 0.2s;
          }
          .setup-fetch-btn:hover:not(:disabled) {
            background: #333;
            color: #fff;
          }
          .setup-fetch-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .setup-error {
            color: #f87171;
            font-size: 0.85rem;
            margin: 0 0 1rem;
          }
          .setup-btn {
            width: 100%;
            padding: 0.7rem;
            border: none;
            border-radius: 0.5rem;
            background: #3b82f6;
            color: #fff;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
          }
          .setup-btn:hover {
            background: #2563eb;
          }
          .setup-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        `}</style>
      </div>
    );
  }

  const activeArea = areas.find((a) => a.id === activeAreaId);
  const activeAreaName = activeArea?.name || "";
  const activeChat = activeArea?.chats?.find((c) => c.id === activeChatId);
  const activeChatName = activeChat?.name || "Chat";

  return (
    <div className="page">
      <div className="app-frame" data-collapsed={sidebarCollapsed}>
      <Topbar
        collapsed={sidebarCollapsed}
        onToggle={handleToggleSidebar}
        areas={areas}
        activeAreaId={activeAreaId}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onAddChat={handleAddChat}
        onRenameChat={handleRenameChat}
        onDeleteChat={handleDeleteChat}
        onOpenPanel={handleOpenPanelFromTopbar}
      />
        <Sidebar
          areas={areas}
          activeAreaId={activeAreaId}
          collapsed={sidebarCollapsed}
          onSelectArea={handleSelectArea}
          onOpenPanel={handleOpenPanel}
          onAddArea={handleAddArea}
        />
        <main className="chat" data-panel={sidePanelOpen ? "open" : "closed"}>
          <SidePanel
            open={sidePanelOpen}
            tab={sidePanelTab}
            area={activeArea || null}
            projectId={projectId}
            treeEntries={treeEntries}
            generatedHistory={generatedHistory}
            rulesContent={rulesContent}
            onChangeTab={handleChangeSidePanelTab}
            onClose={handleCloseSidePanel}
            onUpdateRules={handleUpdateRules}
            onRefreshInfo={handleRefreshInfo}
            onUploadContextFile={handleUploadContextFile}
            onDeleteContextFile={handleDeleteContextFile}
          />
          <ChatPanel
            areaName={activeAreaName}
            chatName={activeChatName}
            messages={chatMessages}
            loading={loading}
            onConfirm={handleConfirm}
            onDeny={handleDeny}
            onDownload={handleDownload}
          />
          <Composer
            value={inputText}
            onChange={setInputText}
            onSend={handleSend}
            onAttach={handleAttach}
          />
          {!setupMode && (
            <ModelBar
              currentModel={currentModel}
              models={models}
              modelsLoading={modelsLoading}
              onFetchModels={handleFetchModelsInApp}
              onChangeModel={handleChangeModel}
            />
          )}
        </main>
      </div>
    </div>
  );
}
