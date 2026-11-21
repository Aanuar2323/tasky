/**
 * llm/errors.js — Clasificación de errores de proveedores y mensajes para la UI.
 */

const TOOLS_HINT = /tool use|tool_use|tool calling|function calling|tool_choice|tools? (?:is |are )?not supported|does not support (?:function|tool)|support tools|"tools"/;
const CONTEXT_HINT = /maximum context length|context length|context window|too many tokens|prompt is too long|input is too long|reduce the length|max_tokens|max_completion_tokens|maximum tokens/;

/**
 * Clasifica un error HTTP del proveedor en una categoría semántica.
 * @param {number} status
 * @param {string} bodyText
 * @returns {string}
 */
export function classifyStatus(status, bodyText = '') {
  const body = String(bodyText || '').toLowerCase();
  switch (status) {
    case 400:
      if (TOOLS_HINT.test(body)) return 'tools_unsupported';
      if (CONTEXT_HINT.test(body)) return 'context_length';
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 402:
      return 'payment_required';
    case 403:
      return /moderation|flagged/.test(body) ? 'moderation' : 'forbidden';
    case 404:
      if (/support tool use|tool use|tool calling|function calling/.test(body)) return 'tools_unsupported';
      if (/data policy|privacy/.test(body)) return 'data_policy';
      if (/no endpoints found for|does not exist|not a valid model|invalid model|unknown model|model_not_found|model not found/.test(body)) {
        return 'model_not_found';
      }
      return 'not_found';
    case 408:
      return 'timeout';
    case 413:
      return CONTEXT_HINT.test(body) ? 'context_length' : 'payload_too_large';
    case 422:
      if (TOOLS_HINT.test(body)) return 'tools_unsupported';
      if (CONTEXT_HINT.test(body)) return 'context_length';
      return 'unprocessable';
    case 429:
      return 'rate_limited';
    case 500:
    case 504:
      return 'server_error';
    case 502:
      return 'bad_gateway';
    case 503:
      return 'unavailable';
    default:
      return 'unknown';
  }
}

export const RETRIABLE_KINDS = new Set(['rate_limited', 'unavailable', 'bad_gateway', 'server_error', 'timeout', 'network', 'empty_response', 'unknown', 'interrupted']);

export const ERROR_LABELS = {
  unauthorized: { title: 'API key inválida', hint: 'Revisá que la clave esté bien pegada en el selector de modelos.' },
  payment_required: { title: 'Sin créditos', hint: 'Cargá créditos en tu proveedor o elegí un modelo gratuito.' },
  forbidden: { title: 'Acceso denegado', hint: 'El proveedor rechazó la solicitud. Verificá los permisos de tu clave.' },
  moderation: { title: 'Contenido bloqueado', hint: 'El proveedor marcó el mensaje por moderación. Reformulalo.' },
  rate_limited: { title: 'Límite de peticiones', hint: 'Demasiadas solicitudes seguidas. Esperá unos segundos o cambiá de modelo.' },
  payload_too_large: { title: 'Solicitud muy grande', hint: 'Quitá adjuntos grandes o abrí un chat nuevo.' },
  context_length: { title: 'Conversación demasiado larga', hint: 'Abrí un chat nuevo o quitá adjuntos: el modelo no admite tanto contexto.' },
  unavailable: { title: 'Servicio saturado', hint: 'El proveedor está al máximo. Probá otro modelo.' },
  server_error: { title: 'Falla del proveedor', hint: 'El servidor de inferencia falló temporalmente. Reintentá.' },
  bad_gateway: { title: 'Pasarela caída', hint: 'Error intermitente del proveedor. Reintentá.' },
  timeout: { title: 'Tiempo de espera agotado', hint: 'El modelo tardó demasiado. Reintentá o probá un modelo más rápido.' },
  network: { title: 'Sin conexión', hint: 'No se pudo contactar al proveedor. Verificá tu conexión.' },
  model_not_found: { title: 'Modelo no disponible', hint: 'El proveedor no reconoce este modelo. Elegí otro en el selector.' },
  data_policy: { title: 'Modelo bloqueado por privacidad', hint: 'Habilitá los modelos gratuitos en openrouter.ai/settings/privacy o elegí otro modelo.' },
  tools_unsupported: { title: 'Modelo sin herramientas', hint: 'Este modelo no admite herramientas. Reintentá: Tasky usará el modo compatible.' },
  bad_request: { title: 'Solicitud rechazada', hint: 'El modelo no aceptó la solicitud. Probá con otro modelo.' },
  unprocessable: { title: 'Solicitud rechazada', hint: 'El modelo no aceptó la solicitud. Probá con otro modelo.' },
  not_found: { title: 'Recurso no encontrado', hint: 'Verificá la URL del proveedor y el modelo elegido.' },
  empty_response: { title: 'Respuesta vacía', hint: 'El modelo no devolvió texto. Reintentá o elegí otro modelo.' },
  not_configured: { title: 'Falta configurar la IA', hint: 'Agregá una API key en el selector de modelos.' },
  invalid_reasoning: { title: 'Razonamiento no disponible', hint: 'Elegí otro nivel o Automático desde el selector junto a Enviar.' },
  aborted: { title: 'Respuesta detenida', hint: '' },
  unknown: { title: 'Error inesperado', hint: 'Algo salió mal. Reintentá o cambiá de modelo.' },
  // ChatGPT (plan de suscripción). `action` le dice a la UI qué botón ofrecer.
  chatgpt_not_signed_in: { title: 'Sesión de ChatGPT requerida', hint: 'Iniciá sesión con ChatGPT desde el selector de modelos.', action: 'signin' },
  chatgpt_reauth_required: { title: 'Sesión de ChatGPT vencida', hint: 'Volvé a iniciar sesión con ChatGPT desde el selector de modelos.', action: 'signin' },
  chatgpt_plan_disabled: { title: 'Plan de ChatGPT sin habilitar', hint: 'Autorizá el uso de tu plan desde el selector de modelos o usá otro proveedor.', action: 'signin' },
  chatgpt_unauthorized: { title: 'ChatGPT no aceptó la sesión', hint: 'Revisá la cuenta elegida y los permisos; si persiste, iniciá sesión de nuevo.', action: 'signin' },
  chatgpt_forbidden: { title: 'ChatGPT rechazó el acceso', hint: 'Una política o región impidió la solicitud. Probá con otro proveedor.' },
  chatgpt_not_eligible: { title: 'Tu cuenta no puede usar su plan acá', hint: 'ChatGPT no habilita el plan para este usuario o espacio de trabajo. Usá otro proveedor.' },
  chatgpt_usage_limit: { title: 'Límite de uso de ChatGPT alcanzado', hint: 'Revisá tu uso en chatgpt.com/settings/usage o elegí otro proveedor.', action: 'usage' },
  chatgpt_unsupported: { title: 'ChatGPT no admite esta solicitud', hint: 'El modelo o una función pedida no está disponible con tu plan. Elegí otro modelo.' },
  chatgpt_route: { title: 'Ruta no permitida', hint: 'ChatGPT no admite esta operación con el plan de suscripción.' },
  chatgpt_denied: { title: 'Permisos de ChatGPT insuficientes', hint: 'La sesión no autoriza esta operación. Cerrá sesión e iniciá de nuevo.', action: 'signin' },
  chatgpt_incomplete: { title: 'Respuesta incompleta', hint: 'ChatGPT cortó la respuesta antes de terminar. Reintentá.' },
  chatgpt_invalid_client: { title: 'Cliente de ChatGPT inválido', hint: 'El registro de Tasky ya no es válido. Cerrá sesión e iniciá de nuevo.', action: 'signin' },
  interrupted: { title: 'Respuesta interrumpida', hint: 'La conexión se cortó antes de terminar. Reintentá.' },
};

/**
 * Error → { title, hint, codes, retriable } para persistir y mostrar.
 */
export function humanizeError(err) {
  const kind = err?.kind && ERROR_LABELS[err.kind] ? err.kind : 'unknown';
  const label = ERROR_LABELS[kind];
  const codes = [err?.status].filter((c) => Number.isInteger(c) && c > 0);
  const out = {
    title: label.title,
    hint: label.hint,
    codes,
    retriable: typeof err?.retriable === 'boolean' ? err.retriable : RETRIABLE_KINDS.has(kind),
  };
  // Código de error y request ID del proveedor, tal cual los devolvió (sin tokens).
  if (typeof err?.code === 'string' && /^[\w.-]{1,80}$/.test(err.code)) out.code = err.code;
  if (typeof err?.requestId === 'string' && /^[\w.:-]{1,100}$/.test(err.requestId)) out.requestId = err.requestId;
  if (label.action) out.action = label.action;
  return out;
}

const HTTP_STATUS = {
  unauthorized: 401,
  payment_required: 402,
  forbidden: 403,
  moderation: 403,
  model_not_found: 404,
  not_found: 404,
  data_policy: 404,
  rate_limited: 429,
  payload_too_large: 413,
  context_length: 413,
  unavailable: 503,
  bad_gateway: 503,
  server_error: 503,
  network: 504,
  timeout: 504,
  not_configured: 400,
  invalid_reasoning: 400,
  chatgpt_not_signed_in: 401,
  chatgpt_reauth_required: 401,
  chatgpt_plan_disabled: 403,
  chatgpt_unauthorized: 401,
  chatgpt_forbidden: 403,
  chatgpt_not_eligible: 403,
  chatgpt_usage_limit: 429,
  chatgpt_unsupported: 400,
  chatgpt_route: 403,
  chatgpt_denied: 403,
  chatgpt_invalid_client: 502,
  interrupted: 502,
};

/** Status HTTP con el que responde Tasky para un tipo de error. */
export function httpStatusFor(kind) {
  return HTTP_STATUS[kind] ?? 502;
}

/** Crea un Error tipado. */
export function llmError(kind, message, extra = {}) {
  const err = new Error(message);
  err.kind = kind;
  Object.assign(err, extra);
  if (typeof err.retriable !== 'boolean') err.retriable = RETRIABLE_KINDS.has(kind);
  return err;
}
