import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../lib/api';

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
  attachments?: AttachedFile[];
};

type AttachedFile = {
  name: string;
  size: number;
  type: string;
};

type ChatLogEntry = {
  id: string;
  ts: number;
  role: 'user' | 'assistant';
  content: string;
  meta?: any;
  file?: GeneratedFile | null;
  attachments?: AttachedFile[];
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
    content: '',
  };

  const [messages, setMessages] = useState<ChatMsg[]>([seed]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        attachments: e.attachments ?? [],
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
      const res = await fetch(`/api/projects/${projectId}/add-to-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, areaId }),
      });
      if (!res.ok) throw new Error(await res.text());
      setHistoryAdded((prev) => new Set(prev).add(msgId));
    } catch (e: any) {
      console.error('Error adding to history:', e);
    }
  }

  function denyHistory(msgId: string) {
    setHistoryDenied((prev) => new Set(prev).add(msgId));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setPendingFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size));
      const newOnes = files.filter((f) => !existing.has(f.name + f.size));
      return [...prev, ...newOnes];
    });
    // reset input so same file can be re-selected
    e.target.value = '';
  }

  function removePendingFile(idx: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function send() {
    const text = input.trim();
    if ((!text && pendingFiles.length === 0) || busy) return;

    // Build user message content (text + mention of attachments)
    const attachmentNames = pendingFiles.map((f) => f.name);
    const contentForDisplay =
      [text, attachmentNames.length ? `📎 ${attachmentNames.join(', ')}` : '']
        .filter(Boolean)
        .join('\n');

    const userMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: contentForDisplay,
      attachments: pendingFiles.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    };

    setMessages((m) => [...m, userMsg]);
    const filesSnapshot = [...pendingFiles];
    setInput('');
    setPendingFiles([]);
    setBusy(true);

    try {
      // Build FormData for multipart upload
      const form = new FormData();
      form.append('messages', JSON.stringify([...openAiMessages, { role: 'user', content: contentForDisplay }]));
      form.append('areaId', areaId);
      form.append('chatId', chatId);
      if (activeTaskPath) form.append('activeTaskPath', activeTaskPath);
      filesSnapshot.forEach((f) => form.append('attachments', f));

      const rawRes = await fetch(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        body: form,
      });

      if (!rawRes.ok) {
        const text = await rawRes.text().catch(() => '');
        let errorMsg = 'Error del servidor';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error ?? text;
        } catch {
          errorMsg = text.replace(/<[^>]*>/g, '').trim() || errorMsg;
        }
        throw new Error(errorMsg);
      }

      const res: { id: string; content: string; meta: any; file?: GeneratedFile | null } = await rawRes.json();

      const assistant: ChatMsg = {
        id: res.id,
        role: 'assistant',
        content: res.content,
        meta: res.meta ?? null,
        file: res.file ?? null,
      };
      setMessages((m) => [...m, assistant]);
    } catch (e: any) {
      let errorMsg = 'Error de conexión con la IA';
      try {
        const raw = e?.message ?? String(e);
        if (raw.startsWith('{')) {
          errorMsg = JSON.parse(raw).error ?? raw;
        } else if (raw.includes('<html') || raw.includes('<!DOCTYPE')) {
          const match = raw.match(/<pre>(.*?)<\/pre>/s);
          errorMsg = match
            ? match[1].replace(/<br\s*\/?>/g, '\n').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim()
            : 'Error del servidor — intenta de nuevo';
        } else {
          errorMsg = raw;
        }
      } catch { /* use default */ }

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
    const res = await fetch(`/api/projects/${projectId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskPath }),
    });
    if (!res.ok) throw new Error(await res.text());
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

  function attachmentIcon(mime: string, name: string) {
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.includes('pdf')) return '📕';
    if (mime.includes('spreadsheet') || name.endsWith('.xlsx') || name.endsWith('.csv')) return '📊';
    if (mime.includes('word') || name.endsWith('.docx')) return '📄';
    if (mime.includes('presentation') || name.endsWith('.pptx')) return '📑';
    if (mime.startsWith('text/') || name.endsWith('.md') || name.endsWith('.json') || name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.py')) return '📝';
    return '📎';
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

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

                {/* Attachment chips on user messages (restored from log) */}
                {m.role === 'user' && m.attachments && m.attachments.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.attachments.map((a, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
                        style={{ background: 'oklch(94% 0.02 240)', color: 'var(--ui-muted)', border: '1px solid var(--ui-line)' }}
                      >
                        <span>{attachmentIcon(a.type, a.name)}</span>
                        <span className="max-w-[120px] truncate font-medium">{a.name}</span>
                        <span style={{ opacity: 0.6 }}>{formatBytes(a.size)}</span>
                      </span>
                    ))}
                  </div>
                ) : null}

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

      {/* ── Pending files preview ── */}
      {pendingFiles.length > 0 ? (
        <div
          className="flex-shrink-0 border-t border-[color:var(--ui-line)] px-4 pt-3 pb-1 flex flex-wrap gap-2"
          style={{ background: 'oklch(97% 0.01 240)' }}
        >
          {pendingFiles.map((f, i) => (
            <div
              key={i}
              className="group flex items-center gap-2 rounded-xl border border-[color:var(--ui-line)] bg-white px-3 py-1.5 text-xs shadow-sm transition-all"
              style={{ maxWidth: '200px' }}
            >
              <span className="text-base leading-none shrink-0">{attachmentIcon(f.type, f.name)}</span>
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium text-[color:var(--ui-text)]">{f.name}</div>
                <div className="text-[color:var(--ui-muted)]">{formatBytes(f.size)}</div>
              </div>
              <button
                onClick={() => removePendingFile(i)}
                className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: 'oklch(88% 0.03 15)', color: 'oklch(45% 0.15 15)' }}
                title="Quitar archivo"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── Input bar ── */}
      <div className="border-t border-[color:var(--ui-line)] bg-white/90 p-4 backdrop-blur-xl flex-shrink-0 shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
        <div className="mx-auto flex max-w-3xl gap-3 items-center">

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            accept="*/*"
          />

          {/* Clip / Attach button */}
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            title="Adjuntar archivo"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[color:var(--ui-line)] bg-white/80 text-[color:var(--ui-muted)] transition-all hover:border-[color:var(--ui-accent)] hover:text-[color:var(--ui-accent)] hover:shadow-sm disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={pendingFiles.length > 0 ? `${pendingFiles.length} archivo(s) adjunto(s) — escribe un mensaje (opcional)` : 'Escribe aquí…'}
            className="ui-input flex-1 px-4 py-3 text-sm bg-white/80"
          />
          <button
            disabled={busy || (!input.trim() && pendingFiles.length === 0)}
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
