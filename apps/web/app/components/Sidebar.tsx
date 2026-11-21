"use client";

import { useEffect, useRef, useState } from "react";
import type { Area } from "../lib/api";
import ConfirmDialog from "./ConfirmDialog";
import { KebabMenu } from "./Menu";
import { PencilIcon, PlusIcon, TrashIcon, XIcon } from "./icons";

type Target = { kind: "area"; areaId: string } | { kind: "chat"; areaId: string; chatId: string };

const keyOf = (t: Target) => (t.kind === "area" ? `area:${t.areaId}` : `chat:${t.chatId}`);

interface SidebarProps {
  areas: Area[];
  activeAreaId: string;
  activeChatId: string;
  onSelectArea: (areaId: string) => void;
  onSelectChat: (areaId: string, chatId: string) => void;
  onAddArea: () => string | null;
  onRenameArea: (areaId: string, name: string) => void;
  onDeleteArea: (areaId: string) => Promise<void>;
  onAddChat: (areaId: string) => void;
  onRenameChat: (areaId: string, chatId: string, name: string) => void;
  onDeleteChat: (areaId: string, chatId: string) => Promise<void>;
  onClose: () => void;
}

function RenameInput({ initial, label, onCommit, onCancel }: { initial: string; label: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = value.trim().replace(/\s+/g, " ");
    if (save && name && name !== initial) onCommit(name);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="rename-input"
      aria-label={label}
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}

function RowActions({ canDelete, onRename, onDelete }: { canDelete: boolean; onRename: () => void; onDelete: () => void }) {
  return (
    <>
      <button type="button" role="menuitem" className="menu-item" onClick={onRename}>
        <PencilIcon /> Renombrar
      </button>
      <button type="button" role="menuitem" className="menu-item" data-tone="danger" disabled={!canDelete} onClick={onDelete}>
        <TrashIcon /> Eliminar
      </button>
    </>
  );
}

export default function Sidebar({
  areas,
  activeAreaId,
  activeChatId,
  onSelectArea,
  onSelectChat,
  onAddArea,
  onRenameArea,
  onDeleteArea,
  onAddChat,
  onRenameChat,
  onDeleteChat,
  onClose,
}: SidebarProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Target | null>(null);

  const addArea = () => {
    const id = onAddArea();
    if (id) setEditing(keyOf({ kind: "area", areaId: id }));
  };

  const confirmTarget = confirm
    ? confirm.kind === "area"
      ? areas.find((a) => a.id === confirm.areaId)
      : areas.find((a) => a.id === confirm.areaId)?.chats.find((c) => c.id === confirm.chatId)
    : null;

  return (
    <nav className="sidebar" aria-label="Áreas y chats">
      <div className="sb-head">
        <span className="brand">Tasky</span>
        <button type="button" className="icon-btn sb-close" aria-label="Cerrar menú" onClick={onClose}>
          <XIcon />
        </button>
      </div>

      <div className="sb-section">
        <h2 className="sb-label">Áreas</h2>
        <button type="button" className="icon-btn" data-tip="Nueva área" aria-label="Nueva área" onClick={addArea}>
          <PlusIcon />
        </button>
      </div>

      <ul className="area-list">
        {areas.map((area) => {
          const active = area.id === activeAreaId;
          const areaTarget: Target = { kind: "area", areaId: area.id };
          const areaKey = keyOf(areaTarget);
          return (
            <li key={area.id} className="area-item" data-active={active ? "true" : "false"}>
              <div className="nav-row" data-kind="area" data-active={active ? "true" : "false"}>
                {editing === areaKey ? (
                  <RenameInput
                    initial={area.name}
                    label="Nombre del área"
                    onCommit={(name) => {
                      setEditing(null);
                      onRenameArea(area.id, name);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <button
                    type="button"
                    className="nav-main"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelectArea(area.id)}
                    onDoubleClick={() => setEditing(areaKey)}
                  >
                    <span className="area-mark" aria-hidden="true">{area.name.trim().charAt(0).toUpperCase() || "Á"}</span>
                    <span className="nav-label">{area.name}</span>
                  </button>
                )}
                {editing !== areaKey && (
                  <KebabMenu label={area.name}>
                    {(close) => (
                      <RowActions
                        canDelete={areas.length > 1}
                        onRename={() => {
                          close();
                          setEditing(areaKey);
                        }}
                        onDelete={() => {
                          close();
                          setConfirm(areaTarget);
                        }}
                      />
                    )}
                  </KebabMenu>
                )}
              </div>

              {active && (
                <ul className="chat-list" aria-label={`Chats de ${area.name}`}>
                  {area.chats.map((chat) => {
                    const chatTarget: Target = { kind: "chat", areaId: area.id, chatId: chat.id };
                    const chatKey = keyOf(chatTarget);
                    const current = chat.id === activeChatId;
                    return (
                      <li key={chat.id}>
                        <div className="nav-row" data-kind="chat" data-active={current ? "true" : "false"}>
                          {editing === chatKey ? (
                            <RenameInput
                              initial={chat.name}
                              label="Nombre del chat"
                              onCommit={(name) => {
                                setEditing(null);
                                onRenameChat(area.id, chat.id, name);
                              }}
                              onCancel={() => setEditing(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              className="nav-main"
                              aria-current={current ? "page" : undefined}
                              onClick={() => onSelectChat(area.id, chat.id)}
                              onDoubleClick={() => setEditing(chatKey)}
                            >
                              <span className="nav-label">{chat.name}</span>
                            </button>
                          )}
                          {editing !== chatKey && (
                            <KebabMenu label={chat.name}>
                              {(close) => (
                                <RowActions
                                  canDelete={area.chats.length > 1}
                                  onRename={() => {
                                    close();
                                    setEditing(chatKey);
                                  }}
                                  onDelete={() => {
                                    close();
                                    setConfirm(chatTarget);
                                  }}
                                />
                              )}
                            </KebabMenu>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  <li>
                    <button type="button" className="new-chat" onClick={() => onAddChat(area.id)}>
                      <PlusIcon /> Nuevo chat
                    </button>
                  </li>
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {confirm && confirmTarget && (
        <ConfirmDialog
          title={`¿Eliminar «${confirmTarget.name}»?`}
          body={
            confirm.kind === "area"
              ? "Se borran sus chats, reglas y archivos de contexto. No se puede deshacer."
              : "Se borran los mensajes de este chat. Los archivos generados se conservan."
          }
          confirmLabel={confirm.kind === "area" ? "Eliminar área" : "Eliminar chat"}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === "area") await onDeleteArea(confirm.areaId);
            else await onDeleteChat(confirm.areaId, confirm.chatId);
            setConfirm(null);
          }}
        />
      )}
    </nav>
  );
}
