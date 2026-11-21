"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AUTO_LABEL, reasoningLabel, type ReasoningLevel } from "../lib/reasoning";
import { CheckIcon, ReasoningIcon } from "./icons";

interface ReasoningSelectProps {
  /** Niveles que declara el modelo activo. Sin niveles no se muestra nada. */
  levels: ReasoningLevel[];
  /** Nivel elegido; `undefined` = automático. */
  value: string | undefined;
  /** Nivel que usa el modelo en automático (solo informativo). */
  defaultLevel?: string | null;
  onChange: (effort: string | undefined) => void;
}

/** Selector compacto de nivel de razonamiento: listbox accesible junto a Enviar. */
export default function ReasoningSelect({ levels, value, defaultLevel, onChange }: ReasoningSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Índice 0 = automático; el resto sigue el orden del catálogo.
  const options: { value: string | undefined; label: string; hint?: string }[] = [
    { value: undefined, label: AUTO_LABEL, hint: defaultLevel ? reasoningLabel(defaultLevel) : undefined },
    ...levels.map((l) => ({ value: l.effort, label: reasoningLabel(l.effort) })),
  ];
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const currentLabel = value ? reasoningLabel(value) : AUTO_LABEL;

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${uid}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, uid]);

  if (!levels.length) return null;

  const openList = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };
  const choose = (index: number) => {
    onChange(options[index].value);
    close();
  };

  const onButtonKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} className="effort">
      <button
        ref={buttonRef}
        type="button"
        className="effort-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${uid}-list` : undefined}
        aria-label={`Razonamiento: ${currentLabel}`}
        data-set={value ? "true" : "false"}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKeyDown}
      >
        <ReasoningIcon />
        <span className="effort-label">{value ? currentLabel : "Auto"}</span>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={`${uid}-list`}
          className="effort-list"
          role="listbox"
          tabIndex={-1}
          aria-label="Razonamiento"
          aria-activedescendant={`${uid}-${active}`}
          onKeyDown={onListKeyDown}
          onBlur={(e) => {
            if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
        >
          {options.map((o, i) => (
            <li
              key={o.value ?? "auto"}
              id={`${uid}-${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              aria-label={o.hint ? `${o.label} (${o.hint})` : o.label}
              className="effort-option"
              data-active={i === active ? "true" : "false"}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="effort-check" aria-hidden="true">
                {i === selectedIndex && <CheckIcon />}
              </span>
              <span>{o.label}</span>
              {o.hint && (
                <span className="effort-hint" aria-hidden="true">
                  {o.hint}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
