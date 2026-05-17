import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

type GeneratedFile = {
  path: string;
  filename: string;
  type: 'xlsx' | 'docx' | 'pptx' | 'png';
};

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  meta?: {
    complete?: boolean;
    taskPath?: string | null;
    summary?: string;
  } | null;
  file?: GeneratedFile | null;
};

type ChatLogEntry = {
  id: string;
  ts: number;
  role: 'user' | 'assistant';
  content: string;
  meta?: any;
  file?: GeneratedFile | null;
};

export function Chat({
  projectId,
  areaId,
  chatId,
  activeTaskPath,
  onCompleted,
}: {
  projectId: string;
  areaId: string;
  chatId: string;
  activeTaskPath: string | null;
  onCompleted: () => void;
}) {
  const seed: ChatMsg = {
    id: 'seed',
    role: 'assistant',
    content: 'Listo. Selecciona una tarea en **tasks/inbox/** (o crea una nueva) y escribe aquí. Si mi respuesta queda 100% completa, verás el botón **Completado**.'
  };
  const [messages, setMessages] = useState<ChatMsg[]>([seed]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const [historyAdded, setHistoryAdded] = useState<Set<string>>(new Set());
  const [historyDenied, setHistoryDenied] = useState<Set<string>>(new Set());

  useEffect(() => {
    const container = bottomRef.current?.parentElement?.parentElement as HTMLElement | null;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    (async () => {
      const { entries } = await apiGet<{ entries: ChatLogEntry[] }>(
        `/api/projects/${projectId}/chatlog?areaId=${encodeURIComponent(areaId)}&chatId=${encodeURIComponent(chatId)}`
      );
      const restored: ChatMsg[] = entries.map((e) => ({
        id: e.id,
        role: e.role,
        content: e.content,
        meta: e.meta ?? null,
        file: e.file ?? null,
      }));
      setMessages([seed, ...restored]);
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, areaId, chatId]);

  const openAiMessages = useMemo(
    () =>
      messages
        .filter((m) => m.id !== 'seed')
        .map((m) => ({ role: m.role, content: m.content })),
    [messages]
  );

  async function addToHistory(msgId: string, filePath: string) {
    if (!projectId) return;
    try {
      await apiPost(`/api/projects/${projectId}/add-to-history`, {
        filePath,
        areaId,
      });
      setHistoryAdded((prev) => new Set(prev).add(msgId));
    } catch (e: any) {
      console.error('Error adding to history:', e);
    }
  }

  function denyHistory(msgId: string) {
    setHistoryDenied((prev) => new Set(prev).add(msgId));
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: 'user', content: text };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setBusy(true);

    try {
      const res = await apiPost<{ id: string; content: string; meta: any; file?: GeneratedFile | null }>(
        `/api/projects/${projectId}/chat`,
        {
          messages: [...openAiMessages, { role: 'user', content: text }],
          areaId,
          chatId,
          activeTaskPath: activeTaskPath ?? undefined,
        }
      );

      const assistant: ChatMsg = {
        id: res.id,
        role: 'assistant',
        content: res.content,
        meta: res.meta ?? null,
        file: res.file ?? null,
      };
      setMessages((m) => [...m, assistant]);
    } catch (e: any) {
      // Extraer mensaje limpio (el backend puede devolver JSON o HTML)
      let errorMsg = 'Error de conexión con la IA';
      try {
        const raw = e?.message ?? String(e);
        // Si parece JSON, extraer el campo "error"
        if (raw.startsWith('{')) {
          errorMsg = JSON.parse(raw).error ?? raw;
        } else if (raw.includes('<html') || raw.includes('<!DOCTYPE')) {
          // Si es HTML, extraer solo el texto del <pre> o mostrar mensaje genérico
          const match = raw.match(/<pre>(.*?)<\/pre>/s);
          errorMsg = match ? match[1].replace(/<br\s*\/?>/g, '\n').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim() : 'Error del servidor — intenta de nuevo';
        } else {
          errorMsg = raw;
        }
      } catch { /* usar mensaje por defecto */ }

      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `⚠️ ${errorMsg}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function markCompleted(taskPath: string) {
    await apiPost(`/api/projects/${projectId}/complete`, { taskPath });
    onCompleted();
    setMessages((m) =>
      m.map((msg) =>
        msg.role === 'assistant' && msg.meta?.taskPath === taskPath
          ? { ...msg, meta: { ...msg.meta, complete: false } }
          : msg
      )
    );
  }

  const fileIcon = (type: string) => {
    switch (type) {
      case 'xlsx': return '📊';
      case 'docx': return '📄';
      case 'pptx': return '📑';
      case 'png': return '🖼️';
      default: return '📁';
    }
  };

  return (
    <div className="flex h-full flex-col">

      {/* ── Messages area ── */}
      <div className="flex-1 overflow-auto p-5 min-h-0">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((m) => {
            const hasFile = m.role === 'assistant' && m.file;
            const showHistoryPrompt = hasFile && !historyAdded.has(m.id) && !historyDenied.has(m.id);
            const alreadyInHistory = historyAdded.has(m.id);

            return (
              <div
                key={m.id}
                className={
                  'ui-message motion-pop px-5 py-4 ' +
                  (m.role === 'user'
                    ? 'ui-message--user ml-auto max-w-[88%]'
                    : 'ui-message--assistant mr-auto max-w-[88%]')
                }
                style={{ animationDelay: '60ms' }}
              >
                <div className="whitespace-pre-wrap text-sm leading-7 text-[color:var(--ui-text)]" style={{ fontFamily: 'var(--font-body)' }}>
                  {m.content}
                </div>

                {hasFile && m.file ? (
                  <div className="mt-3 rounded-2xl border border-[color:var(--ui-line)] bg-white/90 p-3 flex items-center gap-3 file-download-card">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: 'oklch(95% 0.02 195)' }}>
                      <span className="text-lg">{fileIcon(m.file.type)}</span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[color:var(--ui-text)] truncate">
                        {m.file.filename}
                      </div>
                      <div className="text-xs text-[color:var(--ui-muted)] uppercase">
                        {m.file.type}
                      </div>
                    </div>

                    <a
                      href={`/api/projects/${projectId}/download?path=${encodeURIComponent(m.file.path)}`}
                      download
                      className="ui-button ui-button--primary shrink-0"
                      style={{ minHeight: '2rem', borderRadius: '10px', padding: '0.4rem 0.7rem', fontSize: '0.75rem' }}
                    >
                      ⬇ Descargar
                    </a>
                  </div>
                ) : null}

                {showHistoryPrompt && m.file ? (
                  <div className="history-prompt mt-2">
                    <span className="text-xs text-[color:var(--ui-muted)]" style={{ fontFamily: 'var(--font-body)' }}>
                      ¿Desea agregar a historial?
                    </span>
                    <button
                      onClick={() => addToHistory(m.id, m.file!.path)}
                      className="history-prompt__confirm"
                    >
                      Confirmar
                    </button>
                    <button
                      onClick={() => denyHistory(m.id)}
                      className="history-prompt__deny"
                    >
                      Denegar
                    </button>
                  </div>
                ) : null}

                {alreadyInHistory ? (
                  <div className="mt-2 flex items-center justify-end gap-1">
                    <span className="history-added-badge">✓ Agregado al historial</span>
                  </div>
                ) : null}

                {m.role === 'assistant' && m.meta?.complete && m.meta?.taskPath ? (
                  <div className="ui-message__meta flex items-center justify-end">
                    <button
                      onClick={() => markCompleted(m.meta!.taskPath!)}
                      className="ui-button ui-button--primary hover-lift"
                    >
                      Completado
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}

          {busy ? (
            <div className="mr-auto max-w-[88%] ui-message ui-message--assistant px-5 py-4 motion-pulse">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <span className="block h-2 w-2 rounded-full bg-[color:var(--ui-accent)]" style={{ animation: 'ui-pulse 1.4s ease-in-out infinite' }} />
                  <span className="block h-2 w-2 rounded-full bg-[color:var(--ui-accent)]" style={{ animation: 'ui-pulse 1.4s ease-in-out 0.15s infinite' }} />
                  <span className="block h-2 w-2 rounded-full bg-[color:var(--ui-accent)]" style={{ animation: 'ui-pulse 1.4s ease-in-out 0.3s infinite' }} />
                </div>
                <span className="text-sm text-[color:var(--ui-muted)]">Pensando…</span>
              </div>
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input bar ── */}
      <div className="border-t border-[color:var(--ui-line)] bg-white/90 p-4 backdrop-blur-xl flex-shrink-0 shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
        <div className="mx-auto flex max-w-3xl gap-3 items-center">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Escribe aquí…"
            className="ui-input flex-1 px-4 py-3 text-sm bg-white/80"
          />
          <button
            disabled={busy}
            onClick={() => void send()}
            className="ui-button ui-button--primary hover-lift disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}
