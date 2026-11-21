"use client";

import type { PanelTab } from "./SidePanel";
import { ClockIcon, FileIcon, MenuIcon, PlusIcon, RulesIcon } from "./icons";

interface TopbarProps {
  areaName: string;
  chatName: string;
  panelTab: PanelTab | null;
  onToggleNav: () => void;
  onNewChat: () => void;
  onOpenPanel: (tab: PanelTab) => void;
}

const PANEL_BUTTONS: { tab: PanelTab; label: string; Icon: typeof FileIcon }[] = [
  { tab: "info", label: "Archivos", Icon: FileIcon },
  { tab: "historial", label: "Historial", Icon: ClockIcon },
  { tab: "reglas", label: "Reglas", Icon: RulesIcon },
];

export default function Topbar({ areaName, chatName, panelTab, onToggleNav, onNewChat, onOpenPanel }: TopbarProps) {
  return (
    <header className="topbar">
      <button type="button" className="icon-btn" data-tip="Menú" aria-label="Mostrar u ocultar el menú" onClick={onToggleNav}>
        <MenuIcon />
      </button>

      <div className="tb-title">
        {areaName && <span className="tb-area">{areaName}</span>}
        {areaName && chatName && (
          <span className="tb-sep" aria-hidden="true">
            /
          </span>
        )}
        {chatName && <span className="tb-chat">{chatName}</span>}
      </div>

      <div className="tb-actions">
        <button type="button" className="icon-btn" data-tip="Nuevo chat" aria-label="Nuevo chat" onClick={onNewChat}>
          <PlusIcon />
        </button>
        <span className="tb-divider" aria-hidden="true" />
        {PANEL_BUTTONS.map(({ tab, label, Icon }) => (
          <button
            key={tab}
            type="button"
            className="icon-btn"
            data-tip={label}
            aria-label={label}
            aria-pressed={panelTab === tab}
            onClick={() => onOpenPanel(tab)}
          >
            <Icon />
          </button>
        ))}
      </div>
    </header>
  );
}
