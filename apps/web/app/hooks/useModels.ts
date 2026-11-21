"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelChatgptLogin,
  chatgptLogout,
  checkApiStatus,
  fetchModels,
  getChatgptStatus,
  selectChatgptAccount,
  setProvider as setProviderApi,
  setProviderKey,
  startChatgptLogin,
  updateModel,
  type ApiStatus,
  type ChatgptStatus,
  type KeyProvider,
  type ModelInfo,
  type Provider,
} from "../lib/api";

const LOGIN_POLL_MS = 1500;

/** Acciones de ChatGPT que consume el selector de modelos. */
export interface ChatgptController {
  status: ChatgptStatus | null;
  /** Se muestra cuando no se pudo confirmar la revocación remota al cerrar sesión. */
  notice: string | null;
  /** URL para abrir a mano si la API no pudo abrir el navegador. */
  authorizeUrl: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  login: (opts?: { newAccount?: boolean; reconsent?: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
  logout: () => Promise<void>;
  selectAccount: (id: string) => Promise<void>;
}

/** Estado de proveedores/modelo activo y operaciones del selector de modelos. */
export function useModels() {
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Si la app arrancó sin configurar, el onboarding sigue hasta elegir modelo.
  const [initiallyConfigured, setInitiallyConfigured] = useState<boolean | null>(null);
  const cacheRef = useRef<Map<Provider, ModelInfo[]>>(new Map());
  const [chatgptStatus, setChatgptStatus] = useState<ChatgptStatus | null>(null);
  const [chatgptNotice, setChatgptNotice] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const pendingLogin = chatgptStatus?.login.state === "pending";

  const refresh = useCallback(async () => {
    try {
      const s = await checkApiStatus();
      setStatus(s);
      setInitiallyConfigured((prev) => prev ?? s.configured);
      setError(null);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    checkApiStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setInitiallyConfigured((prev) => prev ?? s.configured);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadModels = useCallback(async (provider: Provider, force = false) => {
    const cached = cacheRef.current.get(provider);
    if (cached && !force) return cached;
    const { models } = await fetchModels(provider);
    cacheRef.current.set(provider, models);
    return models;
  }, []);

  const wasPending = useRef(false);
  const refreshChatgpt = useCallback(async () => {
    try {
      const next = await getChatgptStatus();
      const finished = wasPending.current && next.login.state !== "pending";
      wasPending.current = next.login.state === "pending";
      if (finished) {
        // Terminó el inicio de sesión: cambian cuenta, modelos y proveedor configurado.
        cacheRef.current.delete("chatgpt");
        setAuthorizeUrl(null);
        void refresh();
      }
      setChatgptStatus(next);
    } catch {
      /* la API no responde: se conserva el último estado */
    }
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    getChatgptStatus()
      .then((s) => {
        if (!cancelled) setChatgptStatus(s);
      })
      .catch(() => {
        /* la API no responde: el selector lo reintenta al abrirse */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mientras el navegador completa el inicio de sesión, se consulta el estado.
  useEffect(() => {
    if (!pendingLogin) return;
    const id = window.setInterval(() => void refreshChatgpt(), LOGIN_POLL_MS);
    return () => window.clearInterval(id);
  }, [pendingLogin, refreshChatgpt]);

  const chatgpt: ChatgptController = {
    status: chatgptStatus,
    notice: chatgptNotice,
    authorizeUrl,
    busy: chatgptBusy,
    refresh: refreshChatgpt,
    login: async (opts) => {
      setChatgptBusy(true);
      setChatgptNotice(null);
      try {
        const res = await startChatgptLogin(opts);
        setAuthorizeUrl(res.opened ? null : (res.authorizeUrl ?? null));
        await refreshChatgpt();
      } finally {
        setChatgptBusy(false);
      }
    },
    cancel: async () => {
      await cancelChatgptLogin();
      setAuthorizeUrl(null);
      await refreshChatgpt();
    },
    logout: async () => {
      setChatgptBusy(true);
      try {
        const res = await chatgptLogout();
        setChatgptNotice(res.revoked === false ? "No se confirmó la desconexión en ChatGPT. Podés desconectar Tasky desde la configuración de ChatGPT." : null);
        cacheRef.current.delete("chatgpt");
        await Promise.all([refreshChatgpt(), refresh()]);
      } finally {
        setChatgptBusy(false);
      }
    },
    selectAccount: async (id) => {
      setChatgptBusy(true);
      try {
        await selectChatgptAccount(id);
        cacheRef.current.delete("chatgpt");
        await Promise.all([refreshChatgpt(), refresh()]);
      } finally {
        setChatgptBusy(false);
      }
    },
  };

  const saveKey = useCallback(
    async (provider: KeyProvider, apiKey: string) => {
      await setProviderKey(provider, apiKey);
      cacheRef.current.delete(provider);
      await refresh();
    },
    [refresh]
  );

  const selectModel = useCallback(
    async (provider: Provider, model: string) => {
      await updateModel(model, provider);
      if (status?.providerId !== provider) await setProviderApi(provider);
      await refresh();
    },
    [refresh, status?.providerId]
  );

  return {
    status,
    error,
    configured: !!status?.configured,
    initiallyConfigured,
    activeProvider: (status?.providerId && status.providerId !== "none" ? status.providerId : "openrouter") as Provider,
    currentModel: status?.model ?? "",
    capabilities: status?.capabilities ?? null,
    providers: status?.availableProviders,
    chatgpt,
    refresh,
    loadModels,
    saveKey,
    selectModel,
  };
}
