"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DotsIcon } from "./icons";

const WIDTH = 200;

type Point = { x: number; y: number };

function place(anchor: HTMLElement, point?: Point): CSSProperties {
  if (point) {
    const left = Math.min(Math.max(8, point.x), window.innerWidth - WIDTH - 8);
    return window.innerHeight - point.y > 160
      ? { top: point.y, left, width: WIDTH, transformOrigin: "top left" }
      : { bottom: window.innerHeight - point.y, left, width: WIDTH, transformOrigin: "bottom left" };
  }
  const r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - WIDTH), window.innerWidth - WIDTH - 8);
  return window.innerHeight - r.bottom > 140
    ? { top: r.bottom + 4, left, width: WIDTH, transformOrigin: "top right" }
    : { bottom: window.innerHeight - r.top + 4, left, width: WIDTH, transformOrigin: "bottom right" };
}

interface MenuProps {
  anchor: HTMLElement;
  point?: Point;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/** Menú contextual en un portal: no lo recortan los contenedores con scroll. */
export default function Menu({ anchor, point, label, onClose, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [style] = useState(() => place(anchor, point));

  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const close = () => closeRef.current();
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("resize", close);
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  };

  return createPortal(
    <>
      <div
        className="menu-backdrop"
        onClick={() => closeRef.current()}
        onContextMenu={(e) => {
          e.preventDefault();
          closeRef.current();
        }}
      />
      <div ref={ref} className="menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
        {children}
      </div>
    </>,
    document.body
  );
}

/** Botón de tres puntos que abre un `Menu`; también se abre con clic derecho sobre su fila. `children` recibe la función para cerrarlo. */
export function KebabMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ anchor: HTMLElement; point?: Point } | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const button = buttonRef.current;
    const row = button?.parentElement;
    if (!button || !row) return;
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      e.preventDefault();
      setOpen({ anchor: button, point: { x: e.clientX, y: e.clientY } });
    };
    row.addEventListener("contextmenu", onContextMenu);
    return () => row.removeEventListener("contextmenu", onContextMenu);
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn row-kebab"
        aria-label={`Opciones de ${label}`}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={(e) => setOpen(open ? null : { anchor: e.currentTarget })}
      >
        <DotsIcon />
      </button>
      {open && (
        <Menu anchor={open.anchor} point={open.point} label={`Opciones de ${label}`} onClose={close}>
          {children(close)}
        </Menu>
      )}
    </>
  );
}
