"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getChatLog, streamChat, type ApiError, type ChatStreamEvent } from "../lib/api";
import { fileFromAny, fromLogEntries, fromLogEntry } from "../lib/messages";
import type { ChatMessage, HumanError } from "../types/chat";

let counter = 0;
const tempId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

const FALLBACK_ERROR: HumanError = {
  title: "Error inesperado",
  hint: "Algo salió mal. Reintentá o cambiá de modelo.",
  codes: [],
  retriable: true,
};

interface Pending {
  id: string;
  text: string;
  reasoning: string;
}

/**
 * Estado del chat activo: historial, envío con streaming (actualizaciones
 * agrupadas por frame), detener, regenerar y marcas locales.
 */
export function useChat({
  projectId,
  areaId,
  chatId,
  reasoningEffort,
}: {
  projectId: string;
  areaId: string;
  chatId: string;
  /** Nivel elegido para el modelo activo; `undefined` = automático. */
  reasoningEffort?: string;
}) {
  const key = projectId && areaId && chatId ? `${projectId}:${areaId}:${chatId}` : "";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadedKey, setLoadedKey] = useState("");
  const [sending, setSending] = useState(false);

  const keyRef = useRef(key);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const frameRef = useRef<number | null>(null);

  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const flush = useCallback(() => {
    frameRef.current = null;
    const p = pendingRef.current;
    if (!p || (!p.text && !p.reasoning)) return;
    const { id, text, reasoning } = p;
    p.text = "";
    p.reasoning = "";
    patch(id, (m) => ({
      ...m,
      content: m.content + text,
      reasoning: reasoning ? `${m.reasoning ?? ""}${reasoning}` : m.reasoning,
      status: text ? null : m.status,
    }));
  }, [patch]);

  const schedule = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const load = useCallback(async () => {
    if (!key) return;
    try {
      const { entries } = await getChatLog(projectId, areaId, chatId);
      if (keyRef.current === key) setMessages(fromLogEntries(entries));
    } catch {
      if (keyRef.current === key) setMessages([]);
    } finally {
      if (keyRef.current === key) setLoadedKey(key);
    }
  }, [key, projectId, areaId, chatId]);

  useEffect(() => {
    keyRef.current = key;
    abortRef.current?.abort();
    if (!key) return;
    let cancelled = false;
    getChatLog(projectId, areaId, chatId)
      .then(({ entries }) => {
        if (!cancelled) setMessages(fromLogEntries(entries));
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(key);
      });
    return () => {
      cancelled = true;
    };
  }, [key, projectId, areaId, chatId]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const run = useCallback(
    async ({ text, files, regenerate }: { text?: string; files?: File[]; regenerate?: boolean }) => {
      if (!key || abortRef.current) return;
      const runKey = key;
      const assistantId = tempId("a");
      setMessages((prev) => {
        let base = prev;
        if (regenerate) {
          let lastUser = -1;
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            if (prev[i].role === "user") {
              lastUser = i;
              break;
            }
          }
          if (lastUser !== -1) base = prev.slice(0, lastUser + 1);
        }
        const next = [...base];
        if (!regenerate) {
          next.push({
            id: tempId("u"),
            role: "user",
            content: text ?? "",
            ts: Date.now(),
            attachments: files?.map((f) => ({ name: f.name, size: f.size, type: f.type })),
          });
        }
        next.push({
          id: assistantId,
          role: "assistant",
          content: "",
          ts: Date.now(),
          streaming: true,
          status: { phase: "thinking", label: "Pensando" },
          files: [],
        });
        return next;
      });
      setSending(true);
      const controller = new AbortController();
      abortRef.current = controller;
      pendingRef.current = { id: assistantId, text: "", reasoning: "" };
      let reasoningStart: number | null = null;
      let reasoningMs: number | undefined;

      const onEvent = (e: ChatStreamEvent) => {
        if (keyRef.current !== runKey || !pendingRef.current) return;
        switch (e.event) {
          case "start":
            patch(assistantId, (m) => ({ ...m, model: e.data.model }));
            break;
          case "status":
            flush();
            patch(assistantId, (m) => ({ ...m, status: { phase: e.data.phase, label: e.data.label } }));
            break;
          case "reasoning":
            reasoningStart ??= Date.now();
            pendingRef.current.reasoning += e.data.text;
            schedule();
            break;
          case "delta":
            if (reasoningStart !== null && reasoningMs === undefined) reasoningMs = Date.now() - reasoningStart;
            pendingRef.current.text += e.data.text;
            schedule();
            break;
          case "file": {
            flush();
            const f = fileFromAny(e.data.file);
            if (f) patch(assistantId, (m) => ({ ...m, files: [...(m.files ?? []), f] }));
            break;
          }
          case "done": {
            flush();
            const final = fromLogEntry(e.data.message, 0);
            if (final) {
              patch(assistantId, (m) => ({
                ...final,
                id: assistantId,
                reasoning: m.reasoning,
                reasoningMs: reasoningMs ?? (reasoningStart !== null ? Date.now() - reasoningStart : undefined),
                streaming: false,
                status: null,
              }));
            }
            break;
          }
          case "error":
            flush();
            patch(assistantId, (m) => ({ ...m, streaming: false, status: null, error: e.data.error ?? FALLBACK_ERROR }));
            break;
          default:
            break;
        }
      };

      try {
        await streamChat(
          projectId,
          { areaId, chatId, message: text, regenerate, attachments: files, reasoningEffort },
          { signal: controller.signal, onEvent }
        );
      } catch (err) {
        flush();
        if ((err as Error)?.name === "AbortError") {
          patch(assistantId, (m) => ({ ...m, streaming: false, status: null, stopped: true }));
        } else {
          const human = (err as ApiError)?.errorHuman ?? FALLBACK_ERROR;
          patch(assistantId, (m) => ({ ...m, streaming: false, status: null, error: human }));
        }
      } finally {
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        flush();
        pendingRef.current = null;
        patch(assistantId, (m) => (m.streaming ? { ...m, streaming: false, status: null } : m));
        if (abortRef.current === controller) abortRef.current = null;
        setSending(false);
      }
    },
    [key, projectId, areaId, chatId, reasoningEffort, patch, flush, schedule]
  );

  const send = useCallback((text: string, files?: File[]) => run({ text, files }), [run]);
  const regenerate = useCallback(() => run({ regenerate: true }), [run]);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  const markFileSaved = useCallback((messageId: string, url: string) => {
    patch(messageId, (m) => ({ ...m, files: m.files?.map((f) => (f.url === url ? { ...f, saved: true } : f)) }));
  }, [patch]);

  return {
    messages: loadedKey === key ? messages : [],
    loading: !!key && loadedKey !== key,
    sending,
    send,
    stop,
    regenerate,
    reload: load,
    markFileSaved,
  };
}
