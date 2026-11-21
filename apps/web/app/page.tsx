"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Composer from "./components/Composer";
import FilePreview from "./components/FilePreview";
import ModelTrigger from "./components/ModelBar";
import ReasoningSelect from "./components/ReasoningSelect";
import ModelSelectorModal from "./components/ModelSelectorModal";
import SidePanel, { type PanelTab } from "./components/SidePanel";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import { useChat } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { usePersistentState } from "./hooks/usePersistentState";
import { effortKey, resolveEffort, withEffort, type EffortSelections, type ReasoningLevel } from "./lib/reasoning";
import {
  addToHistory,
  createProject,
  deleteArea,
  deleteChat,
  getAreas,
  getProjects,
  saveFileToDisk,
  updateAreas,
  type Area,
  type Provider,
} from "./lib/api";
import type { ChatFile } from "./types/chat";

interface Workspace {
  projectId: string;
  areas: Area[];
  activeAreaId: string;
}

const MOBILE_QUERY = "(max-width: 900px)";
const DEFAULT_CHAT_NAME = /^Chat \d+$/;

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Sin contexto seguro (http en la red local) no hay randomUUID.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function nextName(prefix: string, taken: string[]) {
  let n = taken.length + 1;
  while (taken.includes(`${prefix} ${n}`)) n += 1;
  return `${prefix} ${n}`;
}

function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 40).trimEnd()}…` : clean;
}

async function loadWorkspace(): Promise<Workspace> {
  const { projects } = await getProjects();
  const projectId = projects[0]?.id ?? (await createProject("Tasky")).id;
  const { areas, activeAreaId } = await getAreas(projectId);
  const active = areas.some((a) => a.id === activeAreaId) ? activeAreaId : (areas[0]?.id ?? "");
  return { projectId, areas, activeAreaId: active };
}

function Splash({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div className="splash">
      {error ? (
        <div className="splash-card" role="alert">
          <h1>{error}</h1>
          <p>
            Iniciá el servidor con <code>npm run dev:all</code> y reintentá.
          </p>
          <button type="button" className="btn" data-tone="primary" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      ) : (
        <span className="brand splash-brand" aria-label="Cargando Tasky">
          Tasky
        </span>
      )}
    </div>
  );
}

const NO_EFFORTS: EffortSelections = {};
const NO_LEVELS: ReasoningLevel[] = [];

export default function Home() {
  const models = useModels();
  const [setupDone, setSetupDone] = useState(false);
  const needsSetup = !!models.status && (!models.configured || (models.initiallyConfigured === false && !setupDone));
  const ready = !!models.status && !needsSetup;

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [initError, setInitError] = useState("");
  const [initAttempt, setInitAttempt] = useState(0);

  useEffect(() => {
    if (!ready || workspace) return;
    let cancelled = false;
    loadWorkspace()
      .then((ws) => {
        if (cancelled) return;
        setWorkspace(ws);
        setInitError("");
      })
      .catch(() => {
        if (!cancelled) setInitError("No se pudo abrir el proyecto");
      });
    return () => {
      cancelled = true;
    };
  }, [ready, workspace, initAttempt]);

  const [navHidden, setNavHidden] = usePersistentState("tasky.navHidden", false);
  const [mobileNav, setMobileNav] = useState(false);
  const [panel, setPanel] = useState<{ open: boolean; tab: PanelTab }>({ open: false, tab: "info" });
  const [preview, setPreview] = useState<ChatFile | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [focusKey, setFocusKey] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const projectId = workspace?.projectId ?? "";
  const areas = useMemo(() => workspace?.areas ?? [], [workspace]);
  const activeArea = areas.find((a) => a.id === workspace?.activeAreaId) ?? null;
  const activeChat = activeArea
    ? (activeArea.chats.find((c) => c.id === activeArea.activeChatId) ?? activeArea.chats[0] ?? null)
    : null;
  const activeAreaId = activeArea?.id ?? "";
  const activeChatId = activeChat?.id ?? "";

  // La elección es por modelo y solo se usa si el modelo activo declara ese nivel.
  const [effortSelections, setEffortSelections] = usePersistentState<EffortSelections>("tasky.reasoningEffort", NO_EFFORTS);
  const reasoningLevels = models.capabilities?.reasoningLevels ?? NO_LEVELS;
  const modelEffortKey = effortKey(models.activeProvider, models.currentModel);
  const reasoningEffort = resolveEffort(effortSelections, modelEffortKey, reasoningLevels);

  const chat = useChat({ projectId, areaId: activeAreaId, chatId: activeChatId, reasoningEffort });
  const { messages, loading, sending, send: sendMessage, stop, regenerate, markFileSaved } = chat;

  const fileCount = useMemo(() => messages.reduce((n, m) => n + (m.files?.length ?? 0), 0), [messages]);

  const notify = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (!mobileNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNav(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNav]);

  // ── Áreas y chats ───────────────────────────────────────

  const commit = useCallback(
    (next: Workspace) => {
      setWorkspace(next);
      updateAreas(next.projectId, { areas: next.areas, activeAreaId: next.activeAreaId }).catch(() =>
        notify("No se pudieron guardar los cambios")
      );
    },
    [notify]
  );

  const selectArea = useCallback(
    (areaId: string) => {
      if (!workspace || areaId === workspace.activeAreaId) return;
      commit({ ...workspace, activeAreaId: areaId });
    },
    [workspace, commit]
  );

  const selectChat = useCallback(
    (areaId: string, chatId: string) => {
      if (!workspace) return;
      setMobileNav(false);
      const area = workspace.areas.find((a) => a.id === areaId);
      if (!area || (areaId === workspace.activeAreaId && area.activeChatId === chatId)) return;
      commit({
        ...workspace,
        activeAreaId: areaId,
        areas: workspace.areas.map((a) => (a.id === areaId ? { ...a, activeChatId: chatId } : a)),
      });
    },
    [workspace, commit]
  );

  const addArea = useCallback(() => {
    if (!workspace) return null;
    const id = newId();
    const chatId = newId();
    const area: Area = {
      id,
      name: nextName("Área", workspace.areas.map((a) => a.name)),
      pinned: false,
      chats: [{ id: chatId, name: "Chat 1", pinned: false }],
      activeChatId: chatId,
    };
    commit({ ...workspace, areas: [...workspace.areas, area], activeAreaId: id });
    return id;
  }, [workspace, commit]);

  const renameArea = useCallback(
    (areaId: string, name: string) => {
      if (!workspace) return;
      commit({ ...workspace, areas: workspace.areas.map((a) => (a.id === areaId ? { ...a, name } : a)) });
    },
    [workspace, commit]
  );

  const removeArea = useCallback(
    async (areaId: string) => {
      if (!projectId) return;
      await deleteArea(projectId, areaId);
      setWorkspace((ws) => {
        if (!ws) return ws;
        const remaining = ws.areas.filter((a) => a.id !== areaId);
        return { ...ws, areas: remaining, activeAreaId: ws.activeAreaId === areaId ? (remaining[0]?.id ?? "") : ws.activeAreaId };
      });
    },
    [projectId]
  );

  const addChat = useCallback(
    (areaId: string) => {
      if (!workspace) return;
      setMobileNav(false);
      setFocusKey((k) => k + 1);
      // Un chat vacío ya sirve como chat nuevo.
      if (areaId === workspace.activeAreaId && !loading && !sending && messages.length === 0) return;
      const area = workspace.areas.find((a) => a.id === areaId);
      if (!area) return;
      const id = newId();
      const chats = [...area.chats, { id, name: nextName("Chat", area.chats.map((c) => c.name)), pinned: false }];
      commit({
        ...workspace,
        activeAreaId: areaId,
        areas: workspace.areas.map((a) => (a.id === areaId ? { ...a, chats, activeChatId: id } : a)),
      });
    },
    [workspace, commit, loading, sending, messages.length]
  );

  const renameChat = useCallback(
    (areaId: string, chatId: string, name: string) => {
      if (!workspace) return;
      commit({
        ...workspace,
        areas: workspace.areas.map((a) =>
          a.id === areaId ? { ...a, chats: a.chats.map((c) => (c.id === chatId ? { ...c, name } : c)) } : a
        ),
      });
    },
    [workspace, commit]
  );

  const removeChat = useCallback(
    async (areaId: string, chatId: string) => {
      if (!projectId) return;
      await deleteChat(projectId, areaId, chatId);
      setWorkspace((ws) => {
        if (!ws) return ws;
        return {
          ...ws,
          areas: ws.areas.map((a) => {
            if (a.id !== areaId) return a;
            const chats = a.chats.filter((c) => c.id !== chatId);
            return { ...a, chats, activeChatId: a.activeChatId === chatId ? (chats[0]?.id ?? "") : a.activeChatId };
          }),
        };
      });
    },
    [projectId]
  );

  // ── Chat ────────────────────────────────────────────────

  const send = useCallback(
    (text: string, files: File[]) => {
      if (activeArea && activeChat && messages.length === 0 && DEFAULT_CHAT_NAME.test(activeChat.name)) {
        const title = titleFrom(text || files[0]?.name || "");
        if (title) renameChat(activeArea.id, activeChat.id, title);
      }
      setDraft("");
      void sendMessage(text, files);
    },
    [activeArea, activeChat, messages.length, renameChat, sendMessage]
  );

  const pickSuggestion = useCallback((prompt: string) => {
    setDraft(prompt);
    setFocusKey((k) => k + 1);
  }, []);

  const download = useCallback(
    async (file: ChatFile) => {
      try {
        await saveFileToDisk(projectId, file.url, file.name);
      } catch {
        notify(`No se pudo descargar ${file.name}`);
      }
    },
    [projectId, notify]
  );

  const saveFile = useCallback(
    async (messageId: string, file: ChatFile) => {
      if (!activeAreaId) return;
      try {
        await addToHistory(projectId, { filePath: file.url, areaId: activeAreaId, summary: file.summary ?? undefined });
        markFileSaved(messageId, file.url);
        setHistoryVersion((v) => v + 1);
        notify("Guardado en el historial");
      } catch {
        notify("No se pudo guardar en el historial");
      }
    },
    [projectId, activeAreaId, markFileSaved, notify]
  );

  // ── Paneles ─────────────────────────────────────────────

  const toggleNav = useCallback(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) setMobileNav((v) => !v);
    else setNavHidden((v) => !v);
  }, [setNavHidden]);

  const openPanel = useCallback((tab: PanelTab) => {
    setPanel((p) => (p.open && p.tab === tab ? { ...p, open: false } : { open: true, tab }));
  }, []);
  const changePanelTab = useCallback((tab: PanelTab) => setPanel({ open: true, tab }), []);
  const closePanel = useCallback(() => setPanel((p) => ({ ...p, open: false })), []);
  const closePreview = useCallback(() => setPreview(null), []);
  const closeModels = useCallback(() => setModelOpen(false), []);
  const openModels = useCallback(() => setModelOpen(true), []);
  const newChat = useCallback(() => {
    if (activeAreaId) addChat(activeAreaId);
  }, [activeAreaId, addChat]);

  const { selectModel } = models;
  const finishSetup = useCallback(
    async (provider: Provider, model: string) => {
      await selectModel(provider, model);
      setSetupDone(true);
    },
    [selectModel]
  );

  // ── Render ──────────────────────────────────────────────

  if (!models.status) {
    return models.error ? (
      <Splash error="No hay conexión con la API de Tasky" onRetry={() => void models.refresh()} />
    ) : (
      <Splash />
    );
  }

  if (needsSetup) {
    return (
      <div className="setup-screen">
        <span className="brand setup-brand">Tasky</span>
        <ModelSelectorModal
          open
          firstRun
          providers={models.providers}
          activeProvider={models.activeProvider}
          currentModel={models.currentModel}
          loadModels={models.loadModels}
          onSaveKey={models.saveKey}
          chatgpt={models.chatgpt}
          onSelect={finishSetup}
        />
      </div>
    );
  }

  if (!workspace) {
    return initError ? (
      <Splash
        error={initError}
        onRetry={() => {
          setInitError("");
          setInitAttempt((n) => n + 1);
        }}
      />
    ) : (
      <Splash />
    );
  }

  return (
    <div className="app" data-nav={navHidden ? "hidden" : "shown"} data-mobile-nav={mobileNav ? "open" : "closed"}>
      <div className="nav-backdrop" aria-hidden="true" onClick={() => setMobileNav(false)} />
      <Sidebar
        areas={areas}
        activeAreaId={activeAreaId}
        activeChatId={activeChatId}
        onSelectArea={selectArea}
        onSelectChat={selectChat}
        onAddArea={addArea}
        onRenameArea={renameArea}
        onDeleteArea={removeArea}
        onAddChat={addChat}
        onRenameChat={renameChat}
        onDeleteChat={removeChat}
        onClose={() => setMobileNav(false)}
      />

      <main className="main">
        <Topbar
          areaName={activeArea?.name ?? ""}
          chatName={activeChat?.name ?? ""}
          panelTab={panel.open ? panel.tab : null}
          onToggleNav={toggleNav}
          onNewChat={newChat}
          onOpenPanel={openPanel}
        />
        <ChatPanel
          key={`${activeAreaId}:${activeChatId}`}
          areaName={activeArea?.name ?? ""}
          messages={messages}
          loading={loading}
          sending={sending}
          onPickSuggestion={pickSuggestion}
          onRegenerate={regenerate}
          onPreview={setPreview}
          onDownload={download}
          onSaveFile={saveFile}
        />
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={stop}
          sending={sending}
          disabled={!activeChatId}
          canSubmit={!loading}
          focusKey={focusKey}
          modelSlot={<ModelTrigger provider={models.activeProvider} model={models.currentModel} onOpen={openModels} />}
          effortSlot={
            <ReasoningSelect
              levels={reasoningLevels}
              value={reasoningEffort}
              defaultLevel={models.capabilities?.defaultReasoningLevel}
              onChange={(effort) => setEffortSelections((prev) => withEffort(prev, modelEffortKey, effort))}
            />
          }
        />
      </main>

      <SidePanel
        open={panel.open}
        tab={panel.tab}
        area={activeArea}
        projectId={projectId}
        refreshKey={`${fileCount}:${historyVersion}`}
        onChangeTab={changePanelTab}
        onClose={closePanel}
        onPreview={setPreview}
        onDownload={download}
      />

      {preview && <FilePreview key={preview.url} projectId={projectId} file={preview} onClose={closePreview} onDownload={download} />}

      {modelOpen && (
        <ModelSelectorModal
          open
          providers={models.providers}
          activeProvider={models.activeProvider}
          currentModel={models.currentModel}
          loadModels={models.loadModels}
          onSaveKey={models.saveKey}
          chatgpt={models.chatgpt}
          onSelect={selectModel}
          onClose={closeModels}
        />
      )}

      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}
