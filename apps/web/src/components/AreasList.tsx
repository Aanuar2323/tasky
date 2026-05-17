/**
 * AreasList.tsx — Panel izquierdo: lista de áreas de trabajo
 *
 * Este componente muestra todas las áreas del proyecto en el panel
 * lateral izquierdo. Cada área es una tarjeta con:
 *  - Nombre del área (clic para seleccionarla)
 *  - Botón "+" para crear un nuevo chat dentro del área
 *  - Botones de acción: Info, Historial, Rules
 *
 * El área activa se resalta visualmente (fondo oscuro, texto blanco).
 * Las áreas inactivas tienen fondo blanco y se oscurecen al pasar el mouse.
 */

import { useState } from 'react';

type Area = { id: string; name: string; pinned?: boolean };

export function AreasList({
  areas,        // Lista de áreas del proyecto
  activeId,     // ID del área actualmente seleccionada
  onSelect,     // Callback al seleccionar un área (clic en el nombre)
  onAdd,        // Callback al crear una nueva área (botón "+" del header)
  onNewChat,    // Callback al crear un nuevo chat en un área (botón "+" del área)
  onOpenInfo,   // Callback al abrir la info de un área
  onOpenHistory,// Callback al abrir el historial de un área
  onOpenRules,  // Callback al abrir las reglas de un área
  onRename,     // Callback para renombrar un área
  onPinArea,    // Toggle pin de área
  onDeleteArea, // Eliminar área
}: {
  areas: Area[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onNewChat: (areaId: string) => void;
  onOpenInfo: (areaId: string) => void;
  onOpenHistory: (areaId: string) => void;
  onOpenRules: (areaId: string) => void;
  onRename: (areaId: string) => void;
  onPinArea: (areaId: string) => void;
  onDeleteArea: (areaId: string) => void;
}) {
  const [menuAreaId, setMenuAreaId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">

      {/* ── Cabecera: título "Areas" + botón para crear nueva área ── */}
      <div className="flex items-center justify-between border-b border-[color:var(--ui-line)] px-4 py-4">
        <div>
          <div className="ui-label mb-1">Areas</div>
          <div className="text-sm text-[color:var(--ui-muted)]">Organiza chats y vistas por espacio.</div>
        </div>
        <button
          onClick={onAdd}
          className="ui-button ui-button--primary"
        >
          +
        </button>
      </div>

      {/* ── Lista de áreas (scrollable si hay muchas) ── */}
      <div className="flex-1 overflow-auto p-4">
        <div className="flex flex-col gap-3 stagger-reveal">
          {areas.map((a) => {
            const active = a.id === activeId;
            return (
              <div
                key={a.id}
                onClick={() => onSelect(a.id)}
                className={
                  'group cursor-pointer rounded-[24px] p-4 text-left transition hover-lift ' +
                  (active
                    ? 'ui-card ui-card-active bg-[color:var(--ui-accent)] text-white'
                    : 'ui-card bg-white text-[color:var(--ui-text)]')
                }
              >
                {/* Nombre del área + botón para nuevo chat */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(a.id);
                      }}
                      className="min-w-0 text-left"
                      title="Seleccionar area"
                    >
                      <div className="flex items-center gap-2 truncate text-base font-semibold">
                        {a.pinned ? <span title="Fijado">📌</span> : null}
                        <span className="truncate">{a.name}</span>
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename(a.id);
                      }}
                      className={
                        'rounded-xl border px-2 py-1 text-xs font-semibold opacity-0 transition group-hover:opacity-100 backdrop-blur ' +
                        (active
                          ? 'border-white/30 bg-white/10 text-white/80 hover:text-white'
                            : 'border-[color:var(--ui-line)] bg-white/60 text-[color:var(--ui-muted)] hover:text-[color:var(--ui-text)]')
                      }
                      title="Editar nombre"
                    >
                      ✎
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuAreaId((id) => (id === a.id ? null : a.id));
                        }}
                        className={
                          'rounded-xl px-2 py-1 text-sm font-semibold opacity-0 transition group-hover:opacity-100 ' +
                          (active
                            ? 'text-white/80 hover:text-white'
                            : 'text-[color:var(--ui-muted)] hover:text-[color:var(--ui-text)]')
                        }
                        title="Opciones"
                      >
                        ⋯
                      </button>
                      {menuAreaId === a.id ? (
                        <div className="ui-menu absolute right-0 top-7 z-20 w-40 overflow-hidden py-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onPinArea(a.id);
                              setMenuAreaId(null);
                            }}
                            className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]"
                          >
                            {a.pinned ? 'Desfijar' : 'Fijar'}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteArea(a.id);
                              setMenuAreaId(null);
                            }}
                            className="w-full px-3 py-2 text-left text-xs font-semibold text-[color:var(--ui-danger)] hover:bg-[#fff0ec]"
                          >
                            Eliminar
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewChat(a.id);
                      }}
                      className={
                        'shrink-0 rounded-2xl border px-3 py-1.5 text-sm font-semibold transition ' +
                        (active
                          ? 'border-white/30 bg-white/10 text-white hover:bg-white/15'
                          : 'border-[color:var(--ui-line)] bg-white text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
                      }
                      title="Nuevo chat en esta area"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Botones de acción: Info, Historial, Rules */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenInfo(a.id);
                    }}
                    className={
                      'rounded-2xl border px-2 py-2 text-xs font-semibold transition ' +
                      (active
                        ? 'border-white/25 bg-white/10 text-white hover:bg-white/15'
                        : 'border-[color:var(--ui-line)] bg-white text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
                    }
                  >
                    Info
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenHistory(a.id);
                    }}
                    className={
                      'rounded-2xl border px-2 py-2 text-xs font-semibold transition ' +
                      (active
                        ? 'border-white/25 bg-white/10 text-white hover:bg-white/15'
                        : 'border-[color:var(--ui-line)] bg-white text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
                    }
                  >
                    Historial
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenRules(a.id);
                    }}
                    className={
                      'rounded-2xl border px-2 py-2 text-xs font-semibold transition ' +
                      (active
                        ? 'border-white/25 bg-white/10 text-white hover:bg-white/15'
                        : 'border-[color:var(--ui-line)] bg-white text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
                    }
                  >
                    Rules
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
