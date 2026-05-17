/**
 * RulesForm.tsx — Formulario de edición de reglas del proyecto
 *
 * Permite al usuario configurar las reglas que guían el comportamiento
 * del asistente de IA. Las reglas se guardan como markdown en el
 * archivo rules.md del proyecto.
 *
 * Se divide en dos columnas:
 *  1. Formulario con campos editables (izquierda)
 *  2. Vista previa del markdown generado (derecha)
 *
 * Campos del formulario:
 *  - Objetivo: qué hace el proyecto
 *  - Estructura de carpetas: cómo se organizan los archivos
 *  - Flujo: pasos del workflow
 *  - Hacer: lista de buenas prácticas
 *  - No hacer: lista de cosas prohibidas
 *
 * Al guardar, se convierte el formulario a markdown y se envía al backend
 * vía PUT /api/projects/:id/rules
 */

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPut } from '../lib/api';

/* ==========================================================
   Tipos y valores por defecto
   ========================================================== */

/** Estado del formulario de reglas */
type RulesState = {
  goal: string;            // Objetivo del proyecto
  folderLayout: string;    // Estructura de carpetas (texto)
  workflowSteps: string;   // Pasos del flujo de trabajo (texto)
  doList: string;          // Cosas que sí hacer (una por línea)
  dontList: string;        // Cosas que no hacer (una por línea)
};

/** Valores por defecto para un proyecto nuevo */
const defaults: RulesState = {
  goal: 'Automatizar tareas con orden por carpetas y chat.',
  folderLayout:
    'tasks/inbox (pendientes)\ntasks/history (completadas)\nfiles (adjuntos y outputs)\nchat (historial)',
  workflowSteps:
    '1) Escanear carpetas\n2) Leer reglas\n3) Resolver tarea\n4) Proponer salida\n5) Marcar como completado desde el chat',
  doList: 'Mantener consistencia\nUsar .docx/.xlsx cuando aplique\nSer breve y accionable',
  dontList: 'No borrar archivos sin confirmación\nNo inventar datos\nNo mover a historial sin botón',
};

/* ==========================================================
   Conversión a Markdown
   ========================================================== */

/**
 * Convierte el estado del formulario a un documento markdown
 * que se guarda como rules.md en el proyecto.
 * Este es el formato que lee el asistente de IA.
 */
function toMarkdown(s: RulesState) {
  return `# Rules

## Objetivo
${s.goal}

## Estructura de carpetas

\`\`\`
${s.folderLayout}
\`\`\`

## Flujo

${s.workflowSteps}

## ✅ Hacer
${s.doList
  .split(/\r?\n/)
  .filter(Boolean)
  .map((x) => `- ${x}`)
  .join('\n')}

## 🚫 No hacer
${s.dontList
  .split(/\r?\n/)
  .filter(Boolean)
  .map((x) => `- ${x}`)
  .join('\n')}
`;
}

/* ==========================================================
   Componente RulesForm
   ========================================================== */

export function RulesForm({
  projectId,   // ID del proyecto cuyas reglas se editan
}: {
  projectId: string;
}) {
  /** Estado del formulario (campos editables) */
  const [state, setState] = useState<RulesState>(defaults);

  /** Mensaje de estado (guardando, guardado, error, etc.) */
  const [status, setStatus] = useState<string>('');

  /* ── Cargar reglas existentes al montar ──────────────────── */

  useEffect(() => {
    (async () => {
      const { content } = await apiGet<{ content: string }>(`/api/projects/${projectId}/rules`);
      // MVP: si rules.md ya existe con contenido, mostrar que se cargó
      if (content && content.length > 20) setStatus('Reglas cargadas.');
    })().catch(() => setStatus('No se pudo cargar rules.md (aún).'));
  }, [projectId]);

  /* ── Vista previa del markdown generado ──────────────────── */

  /** Markdown derivado del formulario (se recalcula cuando cambia el estado) */
  const markdown = useMemo(() => toMarkdown(state), [state]);

  /* ── Guardar reglas en el backend ───────────────────────── */

  /**
   * Convierte el formulario a markdown y lo envía al backend
   * vía PUT /api/projects/:id/rules
   */
  async function save() {
    setStatus('Guardando…');
    try {
      await apiPut(`/api/projects/${projectId}/rules`, { markdown });
      setStatus('Guardado ✅');
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-2">

        {/* ── Columna izquierda: formulario editable ── */}
        <div className="ui-panel p-5">
          <div className="ui-label mb-3">Rules (formulario)</div>

          {/* Campo: Objetivo */}
          <label className="ui-label">Objetivo</label>
          <textarea
            value={state.goal}
            onChange={(e) => setState((s) => ({ ...s, goal: e.target.value }))}
            className="ui-textarea mt-1"
            rows={3}
          />

          {/* Campo: Estructura de carpetas */}
          <label className="ui-label mt-3 block">Estructura de carpetas</label>
          <textarea
            value={state.folderLayout}
            onChange={(e) => setState((s) => ({ ...s, folderLayout: e.target.value }))}
            className="ui-textarea mt-1 font-mono text-sm"
            rows={5}
          />

          {/* Campo: Flujo de trabajo */}
          <label className="ui-label mt-3 block">Flujo</label>
          <textarea
            value={state.workflowSteps}
            onChange={(e) => setState((s) => ({ ...s, workflowSteps: e.target.value }))}
            className="ui-textarea mt-1"
            rows={6}
          />

          {/* Campos: Hacer / No hacer (en paralelo) */}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="ui-label">✅ Hacer</label>
              <textarea
                value={state.doList}
                onChange={(e) => setState((s) => ({ ...s, doList: e.target.value }))}
                className="ui-textarea mt-1"
                rows={5}
              />
            </div>
            <div>
              <label className="ui-label">🚫 No hacer</label>
              <textarea
                value={state.dontList}
                onChange={(e) => setState((s) => ({ ...s, dontList: e.target.value }))}
                className="ui-textarea mt-1"
                rows={5}
              />
            </div>
          </div>

          {/* Barra de estado + botón guardar */}
          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-[color:var(--ui-muted)]">{status}</div>
            <button
              onClick={() => void save()}
              className="ui-button ui-button--primary"
            >
              Guardar
            </button>
          </div>
        </div>

        {/* ── Columna derecha: vista previa del markdown ── */}
        <div className="ui-panel p-5">
          <div className="ui-label mb-3">Preview (markdown interno)</div>
          <pre className="whitespace-pre-wrap text-xs leading-5 text-[color:var(--ui-text)]">{markdown}</pre>
        </div>
      </div>
    </div>
  );
}
