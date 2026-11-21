/** Nivel de razonamiento: etiquetas, claves y resolución de la elección por modelo. */

export interface ReasoningLevel {
  effort: string;
  description?: string;
}

/** Elecciones guardadas por proveedor+modelo. Ausente = automático. */
export type EffortSelections = Record<string, string>;

const LABELS: Record<string, string> = {
  none: "Ninguna",
  minimal: "Mínima",
  low: "Baja",
  medium: "Media",
  high: "Alta",
  xhigh: "Muy alta",
  max: "Máxima",
  ultra: "Ultra",
};

export const AUTO_LABEL = "Automático";

/** Etiqueta en español; un valor desconocido del catálogo se muestra tal cual, sin inventar. */
export function reasoningLabel(effort: string): string {
  return LABELS[effort] ?? (effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : effort);
}

export function effortKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/**
 * Nivel a enviar: solo la elección guardada para ese modelo y solo si el modelo
 * activo la declara. Si no, `undefined` (automático: no se envía override).
 */
export function resolveEffort(
  selections: EffortSelections,
  key: string,
  levels: ReasoningLevel[] | undefined
): string | undefined {
  const chosen = selections[key];
  if (!chosen) return undefined;
  return levels?.some((l) => l.effort === chosen) ? chosen : undefined;
}

/** Devuelve las elecciones con `key` actualizado; `undefined` vuelve a automático. */
export function withEffort(selections: EffortSelections, key: string, effort: string | undefined): EffortSelections {
  const next = { ...selections };
  if (effort) next[key] = effort;
  else delete next[key];
  return next;
}
