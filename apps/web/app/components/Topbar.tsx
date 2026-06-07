"use client";

import { useState, useRef, useEffect } from "react";
import type { Area } from "@/app/lib/api";

interface TopbarProps {
  collapsed: boolean;
  onToggle: () => void;
  areas: Area[];
  activeAreaId: string;
  activeChatId: string;
  onSelectChat: (areaId: string, chatId: string) => void;
  onAddChat: (areaId: string) => void;
  onRenameChat: (areaId: string, chatId: string, name: string) => void;
  onDeleteChat: (areaId: string, chatId: string) => void;
  onOpenPanel: (tab: "info" | "historial" | "reglas") => void;
}

const CHAT_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M2 3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H5l-2 2v-2H3a1 1 0 0 1-1-1V3.5z" strokeLinejoin="round" />
  </svg>
);

const PLUS_SVG = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d="M7 2v10M2 7h10" strokeLinecap="round" />
  </svg>
);

const DOTS_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <circle cx="2.5" cy="6" r="1" fill="currentColor" />
    <circle cx="6" cy="6" r="1" fill="currentColor" />
    <circle cx="9.5" cy="6" r="1" fill="currentColor" />
  </svg>
);

const CHECK_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M2.5 6l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TRASH_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M3 3h6M4.5 3V2a.5.5 0 0 1 .5-.5h2A.5.5 0 0 1 7.5 2v1M5 5.5v3M7 5.5v3M3.5 3l.5 6.5h4l.5-6.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PENCIL_SVG = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <path d="M8.5 1.5l2 2-7 7H1.5V8.5l7-7z" strokeLinejoin="round" />
  </svg>
);

export default function Topbar({
  collapsed,
  onToggle,
  areas,
  activeAreaId,
  activeChatId,
  onSelectChat,
  onAddChat,
  onRenameChat,
  onDeleteChat,
  onOpenPanel,
}: TopbarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ areaId: string; chatId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ areaId: string; chatId: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const dropdownRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setRenaming(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  const activeArea = areas.find((a) => a.id === activeAreaId);
  const activeChat = activeArea?.chats?.find((c) => c.id === activeChatId);
  const chatLabel = activeChat?.name || "Chat";

  function handleDotsClick(e: React.MouseEvent, areaId: string, chatId: string) {
    e.stopPropagation();
    setContextMenu({ areaId, chatId, x: e.clientX, y: e.clientY });
  }

  function handleRenameSubmit() {
    if (renaming && renameValue.trim()) {
      onRenameChat(renaming.areaId, renaming.chatId, renameValue.trim());
    }
    setRenaming(null);
    setContextMenu(null);
  }

  function handleStartRename(areaId: string, chatId: string, currentName: string) {
    setRenaming({ areaId, chatId });
    setRenameValue(currentName);
    setContextMenu(null);
  }

  return (
    <header className="topbar">
      <button
        className="icon-btn"
        data-tip={collapsed ? "Expandir panel · 200px" : "Colapsar panel · 48px"}
        aria-label="Colapsar sidebar"
        onClick={onToggle}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
          <path d="M2 4h7M2 8h12M2 12h9" strokeLinecap="round" />
        </svg>
      </button>

      <div className="topbar-center">
        <div className="chat-selector" ref={dropdownRef}>
          <button
          className="chat-selector-btn"
          onClick={() => setDropdownOpen((v) => !v)}
          aria-label="Seleccionar chat"
        >
          <span className="cs-icon">{CHAT_SVG}</span>
          <span className="cs-label">{chatLabel}</span>
          <svg className="cs-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" width="12" height="12">
            <path d={dropdownOpen ? "M3 8L6 5L9 8" : "M3 5L6 8L9 5"} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {dropdownOpen && activeArea && (
          <div className="cs-dropdown">
            <div className="cs-head">
              <span className="cs-head-name">{activeArea.name}</span>
              <button
                className="cs-head-add"
                aria-label="Nuevo chat"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddChat(activeAreaId);
                }}
              >
                {PLUS_SVG}
              </button>
            </div>
            {activeArea.chats.map((chat) => {
              const isActive = chat.id === activeChatId;
              const isRenaming = renaming?.areaId === activeAreaId && renaming?.chatId === chat.id;

              return (
                <div
                  key={chat.id}
                  className={`cs-chat-row${isActive ? " active" : ""}`}
                  onClick={() => {
                    onSelectChat(activeAreaId, chat.id);
                    setDropdownOpen(false);
                  }}
                >
                  <span className="cs-chat-icon">{CHAT_SVG}</span>
                  {isRenaming ? (
                    <input
                      ref={renameRef}
                      className="cs-rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={handleRenameSubmit}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="cs-chat-name">{chat.name}</span>
                  )}
                  <button
                    className="cs-chat-dots"
                    onClick={(e) => handleDotsClick(e, activeAreaId, chat.id)}
                    aria-label="Opciones del chat"
                  >
                    {DOTS_SVG}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {contextMenu && (
        <div
          className="cs-context-menu"
          ref={contextRef}
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
          }}
        >
          <button
            className="cs-ctx-item"
            onClick={() => {
              const area = areas.find((a) => a.id === contextMenu.areaId);
              const chat = area?.chats.find((c) => c.id === contextMenu.chatId);
              if (chat) handleStartRename(contextMenu.areaId, contextMenu.chatId, chat.name);
            }}
          >
            <span className="cs-ctx-icon">{PENCIL_SVG}</span>
            Cambiar nombre
          </button>
          <button
            className="cs-ctx-item danger"
            onClick={() => {
              onDeleteChat(contextMenu.areaId, contextMenu.chatId);
              setContextMenu(null);
            }}
          >
            <span className="cs-ctx-icon">{TRASH_SVG}</span>
            Eliminar
          </button>
        </div>
      )}

      <div className="right">
        <button
          className="icon-btn"
          data-tip="Historial"
          onClick={() => onOpenPanel("historial")}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3l2 1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="icon-btn"
          data-tip="Reglas"
          onClick={() => onOpenPanel("reglas")}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <path
              d="M3.5 2.5h6L13 6v7a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5z"
              strokeLinejoin="round"
            />
            <path d="M5 8h6M5 10.5h4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="icon-btn"
          data-tip="Info"
          aria-label="Info"
          onClick={() => onOpenPanel("info")}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5.5v3M8 8.5v.1" strokeLinecap="round" />
          </svg>
        </button>
        <div className="user-avatar" data-tip="María · @Empresa">
          M
        </div>
      </div>
    </header>
  );
}
