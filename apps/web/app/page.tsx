"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Topbar from "./components/Topbar";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import Composer from "./components/Composer";
import SidePanel from "./components/SidePanel";
import {
  getProjects,
  createProject,
  getAreas,
  updateAreas,
  getChatLog,
  sendMessageStream,
  getRules,
  getTree,
  getGeneratedHistory,
  downloadFile,
  addToHistory,
  deleteFile,
} from "./lib/api";
import type { Area, ChatLogEntry, TreeEntry } from "./lib/api";
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

  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [generatedHistory, setGeneratedHistory] = useState<unknown>(null);
  const [rulesContent, setRulesContent] = useState<string>("");
  const sidePanelCacheRef = useRef<Map<string, { tree?: TreeEntry[]; history?: unknown; rules?: string }>>(new Map());

  const loadChatLog = useCallback(
    async (pId: string, aId: string, cId: string) => {
      try {
        const { entries } = await getChatLog(pId, aId, cId);
        setChatMessages(
          entries.map((e: ChatLogEntry) => ({
            role: e.role as "user" | "assistant",
            content: e.content,
            ts: e.ts as number | undefined,
            file: e.file as ChatMessage["file"],
            meta: e.meta as ChatMessage["meta"],
          }))
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
        if (cached.history) {
          setGeneratedHistory(cached.history);
          return;
        }
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

    const streamingPlaceholder: ChatMessage = {
      role: "assistant",
      content: "",
      ts: Date.now(),
    };
    setChatMessages((prev) => [...prev, userMsg, streamingPlaceholder]);

    const allMessages = [...chatMessages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    sendMessageStream(projectId, {
      messages: allMessages,
      areaId: activeAreaId,
      chatId: activeChatId,
    }, (delta) => {
      setChatMessages((prev) => {
        const next = [...prev];
        const idx = next.length - 1;
        if (idx < 0 || next[idx].role !== "assistant") return prev;
        next[idx] = { ...next[idx], content: `${next[idx].content}${delta}` };
        return next;
      });
    })
      .then((res) => {
        setChatMessages((prev) => {
          const next = [...prev];
          const idx = next.length - 1;
          if (idx < 0 || next[idx].role !== "assistant") return prev;
          next[idx] = {
            ...next[idx],
            content: res.content,
            file: res.file as ChatMessage["file"],
            meta: res.meta as ChatMessage["meta"],
            ts: Date.now(),
          };
          return next;
        });
      })
      .catch((err) => {
        console.error("Send failed:", err);
        setChatMessages((prev) => {
          const next = [...prev];
          const idx = next.length - 1;
          if (idx < 0 || next[idx].role !== "assistant") return prev;
          next[idx] = {
            ...next[idx],
            content: "Error al enviar el mensaje. Intenta de nuevo.",
            ts: Date.now(),
          };
          return next;
        });
      })
      .finally(() => {
        setLoading(false);
      });
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

  const handleConfirm = useCallback(async () => {
    if (!projectId || !activeAreaId) return;
    try {
      await addToHistory(projectId, {
        areaId: activeAreaId,
        chatId: activeChatId,
      });
      setChatMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.meta?.complete
            ? { ...m, meta: { ...m.meta, complete: false } }
            : m
        )
      );
    } catch (err) {
      console.error("Confirm failed:", err);
    }
  }, [projectId, activeAreaId, activeChatId]);

  const handleDeny = useCallback(() => {
    setChatMessages((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.meta?.complete
          ? { ...m, meta: { ...m.meta, complete: false } }
          : m
      )
    );
  }, []);

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
        </main>
      </div>
    </div>
  );
}
