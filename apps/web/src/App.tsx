/**
 * App.tsx — Componente raíz de la aplicación Task
 *
 * Este componente orquesta toda la interfaz de usuario. Es el "cerebro"
 * del frontend: maneja el estado global y decide qué se muestra en
 * cada sección de la pantalla.
 */

import { useEffect, useMemo, useState } from 'react';
import { Chat } from './components/Chat';
import { FilePreview } from './components/FilePreview';
import { AreasList } from './components/AreasList';
import { Modal } from './components/Modal';
import { ChatTabs } from './components/ChatTabs';
import { HistoryView } from './components/HistoryView';
import { RulesForm } from './components/RulesForm';
import { InfoView } from './components/InfoView';
import { AiContextEditor } from './components/AiContextEditor';
import { apiDelete, apiGet, apiPost, apiPut } from './lib/api';

type Project = { id: string; name: string };
type ChatRef = { id: string; name: string; pinned?: boolean };
type Area = { id: string; name: string; pinned?: boolean; chats: ChatRef[]; activeChatId: string };

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [activeAreaId, setActiveAreaId] = useState('a1');
  const [openedFile, setOpenedFile] = useState<string | null>(null);
  const [centerMode, setCenterMode] = useState<'chat' | 'preview'>('chat');
  const [refreshKey, setRefreshKey] = useState(0);

  const [showHistory, setShowHistory] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showAI, setShowAI] = useState(false);

  useEffect(() => {
    (async () => {
      const { projects } = await apiGet<{ projects: { id: string }[] }>(`/api/projects`);
      let pid: string;

      if (projects.length === 0) {
        const created = await apiPost<{ id: string }>(`/api/projects`, { name: 'Proyecto x' });
        pid = created.id;
        setProject({ id: pid, name: 'Proyecto x' });
      } else {
        pid = projects[0].id;
        setProject({ id: pid, name: 'Proyecto x' });
      }

      const cfg = await apiGet<{ areas: Area[]; activeAreaId: string }>(`/api/projects/${pid}/areas`);
      setAreas(cfg.areas);
      setActiveAreaId(cfg.activeAreaId);
    })().catch(console.error);
  }, []);

  const projectName = useMemo(() => project?.name ?? 'Proyecto x', [project?.name]);
  const activeArea = useMemo(() => areas.find((a) => a.id === activeAreaId) ?? null, [areas, activeAreaId]);

  const orderedAreas = useMemo(() => {
    const pinned = areas.filter((a) => a.pinned);
    const rest = areas.filter((a) => !a.pinned);
    return [...pinned, ...rest];
  }, [areas]);

  const activeChatId = activeArea?.activeChatId ?? 'c1';

  async function persistAreas(nextAreas: Area[], nextActiveAreaId = activeAreaId) {
    if (!project) return;
    setAreas(nextAreas);
    setActiveAreaId(nextActiveAreaId);
    await apiPut(`/api/projects/${project.id}/areas`, {
      areas: nextAreas,
      activeAreaId: nextActiveAreaId,
    });
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[color:var(--ui-muted)]">
        Cargando…
      </div>
    );
  }

  return (
    <div className="app-shell flex h-full flex-col">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80" />

      <header className="app-header motion-enter px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="ui-chip ui-chip--accent truncate">
              <span className="h-2 w-2 rounded-full bg-white/90" />
              {projectName}
            </div>
            <div className="ui-chip truncate">
              <span className="h-2 w-2 rounded-full bg-[color:var(--ui-accent)]" />
              {areas.find((a) => a.id === activeAreaId)?.name ?? activeAreaId}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => setShowHistory(true)} className="ui-button ui-button--secondary">Historial</button>
            <button onClick={() => setShowRules(true)} className="ui-button ui-button--secondary">Rules</button>
            <button onClick={() => setShowAI(true)} className="ui-button ui-button--secondary">IA</button>
            <div className="ui-chip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="8" r="4" />
                <path d="M12 14c-4 0-8 2-8 4v2h16v-2c0-2-4-4-8-4z" />
              </svg>
              @Empresa user
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 p-4 xl:p-5">
        <aside className="app-sidebar motion-enter w-[340px] min-h-0 overflow-hidden rounded-[28px]">
          <AreasList
            areas={orderedAreas}
            activeId={activeAreaId}
            onSelect={(id) => {
              setActiveAreaId(id);
              if (project) {
                void apiPut(`/api/projects/${project.id}/areas`, {
                  areas,
                  activeAreaId: id,
                }).catch(() => null);
              }
            }}
            onAdd={() => {
              const nextId = `a${areas.length + 1}`;
              const nextArea: Area = {
                id: nextId,
                name: `Area ${areas.length + 1}`,
                chats: [{ id: 'c1', name: 'Chat 1' }],
                activeChatId: 'c1',
              };
              void persistAreas([...areas, nextArea], nextId);
            }}
            onNewChat={(areaId) => {
              const nextAreas = areas.map((a) => {
                if (a.id !== areaId) return a;
                const nextNum = a.chats.length + 1;
                const nextChat = { id: `c${nextNum}`, name: `Chat ${nextNum}` };
                return { ...a, chats: [...a.chats, nextChat], activeChatId: nextChat.id };
              });
              void persistAreas(nextAreas, areaId);
              setCenterMode('chat');
            }}
            onRename={(areaId) => {
              const current = areas.find((a) => a.id === areaId);
              const nextName = prompt('Nuevo nombre del área:', current?.name ?? '');
              if (!nextName?.trim()) return;
              const nextAreas = areas.map((a) => (a.id === areaId ? { ...a, name: nextName.trim() } : a));
              void persistAreas(nextAreas, areaId);
            }}
            onPinArea={(areaId) => {
              const nextAreas = areas.map((a) => (a.id === areaId ? { ...a, pinned: !a.pinned } : a));
              void persistAreas(nextAreas, activeAreaId);
            }}
            onDeleteArea={async (areaId) => {
              const ok = confirm('Eliminar área y todos sus chats?');
              if (!ok || !project) return;
              await apiDelete(`/api/projects/${project.id}/area`, { areaId });
              const cfg = await apiGet<{ areas: Area[]; activeAreaId: string }>(
                `/api/projects/${project.id}/areas`
              );
              setAreas(cfg.areas);
              setActiveAreaId(cfg.activeAreaId);
            }}
            onOpenInfo={(areaId) => {
              setActiveAreaId(areaId);
              setShowInfo(true);
            }}
            onOpenHistory={(areaId) => {
              setActiveAreaId(areaId);
              setShowHistory(true);
            }}
            onOpenRules={(areaId) => {
              setActiveAreaId(areaId);
              setShowRules(true);
            }}
          />
        </aside>

        <main className="app-workspace motion-enter min-w-0 flex-1 overflow-hidden rounded-[28px] ui-panel flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--ui-line)', background: 'oklch(100% 0 0 / 0.6)', backdropFilter: 'blur(12px)' }}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-xs text-[color:var(--ui-muted)]">
                Area: <span className="font-semibold text-[color:var(--ui-text)]">{activeArea?.name ?? '—'}</span>
              </div>
              <ChatTabs
                chats={activeArea?.chats ?? [{ id: 'c1', name: 'Chat 1' }]}
                activeChatId={activeChatId}
                onSelect={(cid) => {
                  const nextAreas = areas.map((a) =>
                    a.id === activeAreaId ? { ...a, activeChatId: cid } : a
                  );
                  void persistAreas(nextAreas, activeAreaId);
                }}
                onPin={(chatId) => {
                  const nextAreas = areas.map((a) => {
                    if (a.id !== activeAreaId) return a;
                    const nextChats = a.chats.map((c) =>
                      c.id === chatId ? { ...c, pinned: !c.pinned } : c
                    );
                    return { ...a, chats: nextChats };
                  });
                  void persistAreas(nextAreas, activeAreaId);
                }}
                onDelete={async (chatId) => {
                  const ok = confirm('Eliminar chat y todo su historial?');
                  if (!ok || !project) return;
                  await apiDelete(`/api/projects/${project.id}/chat`, { areaId: activeAreaId, chatId });
                  const cfg = await apiGet<{ areas: Area[]; activeAreaId: string }>(
                    `/api/projects/${project.id}/areas`
                  );
                  setAreas(cfg.areas);
                  setActiveAreaId(cfg.activeAreaId);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setShowInfo(true)} className="ui-button ui-button--secondary">Info</button>
              <button onClick={() => setShowHistory(true)} className="ui-button ui-button--secondary">Historial</button>
              <button onClick={() => setShowRules(true)} className="ui-button ui-button--secondary">Rules</button>
              <button onClick={() => setShowAI(true)} className="ui-button ui-button--secondary">IA</button>
              <div className="ui-chip">
                Tarea:{' '}
                <span className="font-mono text-[color:var(--ui-text)]" style={{ fontSize: '0.7rem' }}>
                  {openedFile?.startsWith('tasks/inbox/') ? openedFile : '—'}
                </span>
              </div>
              <button
                className={centerMode === 'chat' ? 'ui-button ui-button--primary' : 'ui-button ui-button--secondary'}
                onClick={() => setCenterMode('chat')}
              >
                Chat
              </button>
              <button
                disabled={!openedFile || openedFile.startsWith('tasks/inbox/')}
                className={
                  centerMode === 'preview'
                    ? 'ui-button ui-button--primary'
                    : 'ui-button ui-button--secondary disabled:opacity-50'
                }
                onClick={() => setCenterMode('preview')}
              >
                Preview
              </button>
            </div>
          </div>

          {centerMode === 'preview' && openedFile && !openedFile.startsWith('tasks/inbox/') ? (
            <FilePreview projectId={project.id} path={openedFile} />
          ) : (
            <Chat
              projectId={project.id}
              areaId={activeAreaId}
              chatId={activeChatId}
              activeTaskPath={openedFile?.startsWith('tasks/inbox/') ? openedFile : null}
              onCompleted={() => {
                setRefreshKey((k) => k + 1);
                setOpenedFile(null);
                setCenterMode('chat');
              }}
            />
          )}
        </main>
      </div>

      <Modal
        title={`Info — ${activeArea?.name ?? ''}`}
        open={showInfo}
        onClose={() => setShowInfo(false)}
        widthClass="w-[1120px]"
      >
        <InfoView
          projectId={project.id}
          projectName={projectName}
          areaName={activeArea?.name ?? activeAreaId}
          areaId={activeAreaId}
        />
      </Modal>

      <Modal
        title={`Historial — ${activeArea?.name ?? ''}`}
        open={showHistory}
        onClose={() => setShowHistory(false)}
        widthClass="w-[920px]"
      >
        <HistoryView projectId={project.id} areaId={activeAreaId} refreshKey={refreshKey} />
      </Modal>

      <Modal
        title={`Rules — ${activeArea?.name ?? ''}`}
        open={showRules}
        onClose={() => setShowRules(false)}
        widthClass="w-[1100px]"
      >
        <RulesForm projectId={project.id} />
      </Modal>

      <Modal
        title={`IA — ${activeArea?.name ?? ''}`}
        open={showAI}
        onClose={() => setShowAI(false)}
        widthClass="w-[1100px]"
      >
        <AiContextEditor projectId={project.id} areaId={activeAreaId} />
      </Modal>
    </div>
  );
}
