"use client";

import { useState } from "react";
import type { ChatgptController } from "../hooks/useModels";

/** Inicio de sesión, estado y cierre de sesión de ChatGPT dentro del selector de modelos. */
export default function ChatgptPanel({ chatgpt }: { chatgpt: ChatgptController }) {
  const { status, notice, authorizeUrl, busy } = chatgpt;
  const [error, setError] = useState("");

  if (!status) {
    return (
      <div className="msm-state">
        <span className="spinner" aria-hidden="true" /> Cargando
      </div>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message || "No se pudo completar la acción");
    }
  };

  const login = status.login;
  const pending = login.state === "pending";
  const loginError = login.state === "error" ? login.message : "";

  if (!status.available) {
    return (
      <div className="msm-chatgpt">
        <p className="msm-chatgpt-note" role="status">
          Iniciar sesión con ChatGPT requiere ejecutar Tasky en tu equipo, fuera de Docker.
        </p>
      </div>
    );
  }

  return (
    <div className="msm-chatgpt">
      {status.signedIn && !pending && (
        <div className="msm-chatgpt-row">
          {status.accounts.length > 1 ? (
            <select
              className="msm-chatgpt-who"
              aria-label="Cuenta de ChatGPT"
              value={status.accountId ?? ""}
              disabled={busy}
              onChange={(e) => void run(() => chatgpt.selectAccount(e.target.value))}
            >
              {status.accounts.filter((a) => a.signedIn).map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          ) : (
            <span className="msm-chatgpt-who" title={status.email ?? undefined}>{status.email ?? "Cuenta de ChatGPT"}</span>
          )}
          <button type="button" className="btn" data-size="sm" disabled={busy} onClick={() => void run(() => chatgpt.login({ newAccount: true }))}>
            Otra cuenta
          </button>
          <button type="button" className="btn" data-size="sm" disabled={busy} onClick={() => void run(chatgpt.logout)}>
            Cerrar sesión
          </button>
        </div>
      )}

      {status.signedIn && !status.planUsage && !pending && (
        <div className="msm-chatgpt-row">
          <p className="msm-chatgpt-note" data-tone="danger" role="status">El uso de tu plan no está habilitado.</p>
          <button type="button" className="btn" data-tone="primary" data-size="sm" disabled={busy} onClick={() => void run(() => chatgpt.login({ reconsent: true }))}>
            Habilitar plan
          </button>
        </div>
      )}

      {!status.signedIn && !pending && (
        <div className="msm-chatgpt-row">
          {status.reauthRequired && <p className="msm-chatgpt-note" role="status">La sesión venció.</p>}
          <button type="button" className="btn" data-tone="primary" disabled={busy} onClick={() => void run(() => chatgpt.login())}>
            Continue with ChatGPT
          </button>
        </div>
      )}

      {pending && (
        <div className="msm-chatgpt-row" role="status">
          <span className="spinner" aria-hidden="true" />
          <span className="msm-chatgpt-who">Esperando a ChatGPT</span>
          {authorizeUrl && (
            <a className="btn" data-tone="primary" data-size="sm" href={authorizeUrl} target="_blank" rel="noopener noreferrer">
              Abrir ChatGPT
            </a>
          )}
          <button type="button" className="btn" data-size="sm" onClick={() => void run(chatgpt.cancel)}>
            Cancelar
          </button>
        </div>
      )}

      {notice && <p className="msm-chatgpt-note" role="status">{notice}</p>}
      {(error || loginError) && <p className="msm-chatgpt-note" data-tone="danger" role="alert">{error || loginError}</p>}
    </div>
  );
}
