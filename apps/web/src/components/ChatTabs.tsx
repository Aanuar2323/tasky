/**
 * ChatTabs.tsx — Selector de chats dentro de un área
 *
 * En lugar de lista vertical, se muestra un botón horizontal
 * compacto que despliega un menú vertical con animación.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

type ChatRef = { id: string; name: string; pinned?: boolean };

export function ChatTabs({
  chats,          // Lista de chats del área activa
  activeChatId,   // ID del chat actualmente seleccionado
  onSelect,       // Callback al seleccionar un chat diferente
  onPin,          // Toggle pin
  onDelete,       // Delete chat
}: {
  chats: ChatRef[];
  activeChatId: string;
  onSelect: (chatId: string) => void;
  onPin: (chatId: string) => void;
  onDelete: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuChatId, setMenuChatId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMenuChatId(null);
      }
    }
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const orderedChats = useMemo(() => {
    const pinned = chats.filter((c) => c.pinned);
    const rest = chats.filter((c) => !c.pinned);
    return [...pinned, ...rest];
  }, [chats]);

  const active = orderedChats.find((c) => c.id === activeChatId) ?? orderedChats[0];

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="ui-button ui-button--secondary min-w-[10rem] justify-between"
      >
        <span className="truncate">{active?.name ?? 'Chat'}</span>
        <span className="text-[color:var(--ui-muted)]">▾</span>
      </button>

      <div
        className={
          'ui-menu absolute left-0 z-20 mt-2 w-64 origin-top overflow-hidden transition ' +
          (open ? 'motion-pop scale-100 opacity-100' : 'pointer-events-none scale-95 opacity-0')
        }
      >
        <div className="max-h-64 overflow-auto p-2">
          {orderedChats.map((c) => {
            const isActive = c.id === activeChatId;
            return (
              <div
                key={c.id}
                className={
                  'flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold transition ' +
                  (isActive
                    ? 'bg-[color:var(--ui-accent)] text-white'
                    : 'text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
                }
              >
                <button
                  onClick={() => {
                    onSelect(c.id);
                    setOpen(false);
                  }}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  {c.pinned ? <span title="Fijado">📌</span> : null}
                  <span className="truncate">{c.name}</span>
                </button>
                {isActive ? <span className="ml-2 text-white/70">•</span> : null}

                <div className="relative ml-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuChatId((id) => (id === c.id ? null : c.id));
                    }}
                    className={
                      'rounded-lg px-2 py-1 text-xs font-semibold ' +
                      (isActive
                        ? 'text-white/80 hover:text-white'
                        : 'text-[color:var(--ui-muted)] hover:text-[color:var(--ui-text)]')
                    }
                    title="Opciones"
                  >
                    ⋯
                  </button>

                  {menuChatId === c.id ? (
                    <div className="ui-menu absolute right-0 top-7 z-30 w-40 overflow-hidden py-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPin(c.id);
                          setMenuChatId(null);
                        }}
                        className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]"
                      >
                        {c.pinned ? 'Desfijar' : 'Fijar'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id);
                          setMenuChatId(null);
                        }}
                        className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-danger)] hover:bg-[#fff0ec]"
                      >
                        Eliminar
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
