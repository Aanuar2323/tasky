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
  getProviders,
  setProvider as setProviderApi,
  setProviderKey,
} from "./lib/api";
import type { Area, ChatLogEntry, TreeEntry, ModelInfo, Provider, ProviderInfo, ApiErrorBody } from "./lib/api";
import ModelSelectorModal from "./components/ModelSelectorModal";
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
  const [setupProvider, setSetupProvider] = useState<Provider>("openrouter");
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [activeProvider, setActiveProvider] = useState<Provider>("openrouter");
  const [providersInfo, setProvidersInfo] = useState<Record<Provider, ProviderInfo>>({} as Record<Provider, ProviderInfo>);
  const [showConfigModal, setShowConfigModal] = useState(false);
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
            const rawError = e.error as { title: string; hint: string; codes: number[] } | undefined;
            return {
              role: e.role as "user" | "assistant",
              content: e.content,
              ts: e.ts as number | undefined,
              file,
              meta: e.meta as ChatMessage["meta"],
              error: rawError?.title ? rawError : undefined,
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
          if (status.openrouterConfigured) {
            setSetupProvider("openrouter");
          } else if (status.nvidiaConfigured) {
            setSetupProvider("nvidia");
          }
          setProvidersInfo(status.availableProviders ?? {});
          return;
        }
        setCurrentModel(status.model || "");
        setActiveProvider(status.providerId || "openrouter");
        setProvidersInfo(status.availableProviders ?? {});
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

  const handleRenameArea = useCallback(
    async (areaId: string, name: string) => {
      if (!projectId || !name.trim()) return;
      const updatedAreas = areas.map((a) =>
        a.id === areaId ? { ...a, name: name.trim() } : a
      );
      setAreas(updatedAreas);
      try {
        await updateAreas(projectId, { areas: updatedAreas, activeAreaId });
      } catch (err) {
        console.error("Rename area failed:", err);
      }
    },
    [projectId, areas, activeAreaId]
  );

  const handleDeleteArea = useCallback(
    async (areaId: string) => {
      if (!projectId) return;
      // regla: no eliminar la última área
      if (areas.length <= 1) return;
      try {
        await deleteArea(projectId, areaId);
      } catch (err) {
        console.error("Delete area failed:", err);
        return;
      }
      const remaining = areas.filter((a) => a.id !== areaId);
      setAreas(remaining);
      // Si se elimina el área activa, mover a otra
      if (activeAreaId === areaId) {
        const nextArea = remaining[0];
        if (nextArea) {
          const nextChatId =
            nextArea.activeChatId || nextArea.chats?.[0]?.id || "";
          setActiveAreaId(nextArea.id);
          setActiveChatId(nextChatId);
          setSidePanelOpen(false);
          try {
            await updateAreas(projectId, {
              areas: remaining,
              activeAreaId: nextArea.id,
            });
          } catch (err) {
            console.error("Persist active area after delete failed:", err);
          }
          if (nextChatId) {
            await loadChatLog(projectId, nextArea.id, nextChatId);
          } else {
            setChatMessages([]);
          }
        }
      } else {
        try {
          await updateAreas(projectId, {
            areas: remaining,
            activeAreaId,
          });
        } catch (err) {
          console.error("Persist after delete failed:", err);
        }
      }
    },
    [projectId, areas, activeAreaId, loadChatLog]
  );

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
        const e = err as Error & Required<ApiErrorBody>;
        const errorHuman = e.errorHuman;
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "",
            ts: Date.now(),
            error: errorHuman?.title ? errorHuman : { title: "Error inesperado", hint: "Algo salió mal. Reintentá o cambiá de modelo.", codes: [e.upstreamStatus || 502].filter(Boolean), retriable: e.retriable ?? false },
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

  const handleRetry = useCallback((msgIndex: number) => {
    setChatMessages((prev) => {
      const errMsg = prev[msgIndex];
      if (!errMsg) return prev;
      // Find the user message before this error
      let userContent = "";
      for (let j = msgIndex - 1; j >= 0; j--) {
        if (prev[j].role === "user") {
          userContent = prev[j].content;
          break;
        }
      }
      if (!userContent) return prev;

      // Remove the error message
      const filtered = prev.filter((_, i) => i !== msgIndex);

      // Re-send
      setInputText(userContent);
      setTimeout(() => {
        setInputText("");
        setLoading(true);
        const allMessages = [...filtered, { role: "user", content: userContent }].map((m) => ({
          role: m.role,
          content: m.content,
        }));
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
            setChatMessages((prev2) => [...prev2, assistantMsg]);
          })
          .catch((err2) => {
            const e2 = err2 as Error & Required<ApiErrorBody>;
            const errorHuman = e2.errorHuman;
            setChatMessages((prev2) => [
              ...prev2,
              {
                role: "assistant",
                content: "",
                ts: Date.now(),
                error: errorHuman?.title ? errorHuman : { title: "Error inesperado", hint: "Algo salió mal. Reintentá o cambiá de modelo.", codes: [e2.upstreamStatus || 502].filter(Boolean), retriable: e2.retriable ?? false },
              },
            ]);
          })
          .finally(() => setLoading(false));
      }, 0);

      return filtered;
    });
  }, [projectId, activeAreaId, activeChatId]);

  const handleFetchModels = useCallback(async (provider?: Provider) => {
    const p = provider ?? setupProvider;
    const key = setupApiKey.trim();
    if (!key && !(providersInfo[p]?.configured)) {
      setSetupError("Ingresa una API key primero");
      return;
    }
    setModelsLoading(true);
    setSetupError("");
    try {
      // Si hay API key nueva en el input, primero persistirla en backend
      // para que getModelsForProvider pueda usarla.
      if (key && !(providersInfo[p]?.configured)) {
        await setProviderKey(p, key);
        const { providers } = await getProviders();
        setProvidersInfo(providers);
      }
      const { models: modelList } = await fetchModels(p);
      setModels(modelList);
      setModelsFetched(true);
      if (modelList.length > 0 && !setupModel) {
        setSetupModel(modelList[0].id);
      }
    } catch (err) {
      setSetupError(`Error al cargar modelos: ${err instanceof Error ? err.message : "API key inválida"}`);
    } finally {
      setModelsLoading(false);
    }
  }, [setupApiKey, setupProvider, providersInfo, setupModel]);

  const handleSaveSetup = useCallback(async () => {
    if (!setupApiKey.trim()) {
      setSetupError("Ingresa una API key");
      return;
    }
    setSetupSaving(true);
    setSetupError("");
    try {
      await saveSetup(setupApiKey.trim(), setupModel || undefined, setupProvider);
      setSetupMode(false);
      window.location.reload();
    } catch (err) {
      setSetupError(`Error: ${err instanceof Error ? err.message : "No se pudo guardar la config"}`);
    } finally {
      setSetupSaving(false);
    }
  }, [setupApiKey, setupModel, setupProvider]);

  const handleChangeModel = useCallback(async (model: string) => {
    try {
      await updateModel(model, activeProvider);
      setCurrentModel(model);
      // persistir modelo por provider en localStorage
      try {
        const saved = JSON.parse(localStorage.getItem("modelOverrides") || "{}");
        saved[activeProvider] = model;
        localStorage.setItem("modelOverrides", JSON.stringify(saved));
      } catch { /* ignore */ }
    } catch (err) {
      console.error("Error cambiando modelo:", err);
    }
  }, [activeProvider]);

  const handleProviderChange = useCallback(async (provider: Provider) => {
    if (!providersInfo[provider]?.configured) return;
    try {
      await setProviderApi(provider);
      // recargar modelo preferido para este provider
      let modelOverride = "";
      try {
        const saved = JSON.parse(localStorage.getItem("modelOverrides") || "{}");
        modelOverride = saved[provider] || "";
      } catch { /* ignore */ }
      const newModel = modelOverride || providersInfo[provider]?.model || "";
      setCurrentModel(newModel);
      setActiveProvider(provider);
      setModels([]);
      setModelsFetched(false);
      // refresh providers
      const { providers } = await getProviders();
      setProvidersInfo(providers);
    } catch (err) {
      console.error("Error cambiando provider:", err);
    }
  }, [providersInfo]);

  const handleSaveProviderKey = useCallback(async (provider: Provider, apiKey: string) => {
    await setProviderKey(provider, apiKey);
    // refresh providers info
    const { providers } = await getProviders();
    setProvidersInfo(providers);
    // si key guardada es del setup provider, activarla para comienzo
    if (setupMode) {
      setSetupProvider(provider);
    }
  }, [setupMode]);

  const handleFetchModelsInApp = useCallback(async (provider?: Provider) => {
    const p = provider ?? activeProvider;
    setModelsLoading(true);
    try {
      const { models: modelList } = await fetchModels(p);
      setModels(modelList);
      setModelsFetched(true);
    } catch (err) {
      console.error("Error cargando modelos:", err);
    } finally {
      setModelsLoading(false);
    }
  }, [activeProvider]);

  if (setupMode) {
    const initProviders: Record<Provider, ProviderInfo> =
      Object.keys(providersInfo).length > 0
        ? providersInfo
        : ({} as Record<Provider, ProviderInfo>);
    return (
      <div className="page">
        <ModelSelectorModal
          open
          isFirstRun
          providers={initProviders}
          activeProvider={setupProvider}
          models={models}
          modelsLoading={modelsLoading}
          selectedProvider={setupProvider}
          selectedModel={setupModel}
          errorMessage={setupError}
          pending={setupSaving}
          onSelectProvider={(p) => setSetupProvider(p)}
          onChangeModel={(m) => setSetupModel(m)}
          onFetchModels={(p) => handleFetchModels(p)}
          onSaveKey={async (p, k) => {
            await handleSaveProviderKey(p, k);
          }}
          onSaveSetup={handleSaveSetup}
        />
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
          onRenameArea={handleRenameArea}
          onDeleteArea={handleDeleteArea}
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
            onRetry={handleRetry}
          />
          <Composer
            value={inputText}
            onChange={setInputText}
            onSend={handleSend}
            onAttach={handleAttach}
          />
          {!setupMode && (
            <>
              <ModelBar
                activeProvider={activeProvider}
                providers={providersInfo}
                currentModel={currentModel}
                onOpen={() => setShowConfigModal(true)}
              />
              <ModelSelectorModal
                open={showConfigModal}
                providers={providersInfo}
                activeProvider={activeProvider}
                models={models}
                modelsLoading={modelsLoading}
                selectedProvider={activeProvider}
                selectedModel={currentModel}
                onClose={() => setShowConfigModal(false)}
                onSelectProvider={handleProviderChange}
                onChangeModel={handleChangeModel}
                onFetchModels={handleFetchModelsInApp}
                onSaveKey={handleSaveProviderKey}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
