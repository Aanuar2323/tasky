/**
 * context/budget.js — Presupuesto de tokens del prompt.
 *
 * Estimación conservadora (3,5 caracteres por token, pensado para español) y
 * reparto de la ventana del modelo entre instrucciones, reglas, archivos,
 * adjuntos e historial. La salida nunca se come más del 35 % de la ventana.
 */

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1000;
const MESSAGE_OVERHEAD = 4;
const DEFAULT_MAX_INPUT = Number(process.env.TASKY_MAX_INPUT_TOKENS ?? 100_000);
const TRUNCATION_MARK = '\n…[recortado]';

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function contentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((acc, part) => {
      if (part?.type === 'image_url') return acc + IMAGE_TOKENS;
      return acc + estimateTokens(part?.text ?? '');
    }, 0);
  }
  return 0;
}

export function estimateMessagesTokens(messages) {
  return (messages ?? []).reduce((acc, m) => {
    let n = MESSAGE_OVERHEAD + contentTokens(m?.content);
    for (const tc of m?.tool_calls ?? []) n += estimateTokens(tc?.function?.arguments ?? '') + 8;
    return acc + n;
  }, 0);
}

/**
 * @param {{contextLength:number, maxOutput:number, maxInput?:number, coreTokens?:number}} p
 * @returns {{input:number, output:number, core:number,
 *   sections:{rules:number, generated:number, attachments:number, retrieval:number, history:number}}}
 */
export function planBudget({ contextLength, maxOutput, maxInput = DEFAULT_MAX_INPUT, coreTokens = 3500 }) {
  const ctx = Math.max(2048, Number(contextLength) || 32768);
  let output = Math.min(Number(maxOutput) || 4096, Math.floor(ctx * 0.35));
  output = Math.max(output, Math.min(1024, Math.floor(ctx / 4)));
  const safety = Math.max(256, Math.floor(ctx * 0.03));
  const input = Math.max(1024, Math.min(ctx - output - safety, maxInput));
  const remaining = Math.max(0, input - coreTokens);
  const rules = Math.min(2500, Math.floor(remaining * 0.1));
  const generated = Math.min(1200, Math.floor(remaining * 0.04));
  const attachments = Math.floor(remaining * 0.3);
  const retrieval = Math.floor(remaining * 0.22);
  const history = Math.max(0, remaining - rules - generated - attachments - retrieval);
  return { input, output, core: coreTokens, sections: { rules, generated, attachments, retrieval, history } };
}

/** Recorta `text` para que quepa en `tokens`, en un límite de palabra. */
export function truncateToTokens(text, tokens) {
  const s = String(text ?? '');
  if (estimateTokens(s) <= tokens) return s;
  const maxChars = Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN) - TRUNCATION_MARK.length);
  let cut = s.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (boundary > maxChars * 0.6) cut = cut.slice(0, boundary);
  return `${cut.trimEnd()}${TRUNCATION_MARK}`;
}
