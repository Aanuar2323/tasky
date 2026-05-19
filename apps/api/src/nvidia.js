/**
 * nvidia.js — Cliente para la API de NVIDIA NIM (chat completions)
 *
 * Este módulo encapsula la comunicación con el endpoint de chat
 * de NVIDIA (integrate.api.nvidia.com). Envía los mensajes al
 * modelo configurado (por defecto GLM 5.1) y devuelve la
 * respuesta del asistente.
 *
 * Variables de entorno usadas:
 *   NVIDIA_BASE_URL  — URL base de la API (default: https://integrate.api.nvidia.com/v1)
 *   NVIDIA_API_KEY   — Clave de autenticación (obligatoria)
 *   MODEL            — Nombre del modelo a usar (default: z-ai/glm-5.1)
 */

import 'dotenv/config';

/* ==========================================================
   Configuración desde variables de entorno
   ========================================================== */

/** URL base de la API de NVIDIA */
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';

/** Clave de API para autenticación con NVIDIA. Obligatoria. */
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

/** Modelo de lenguaje a usar para generar las respuestas */
const MODEL = process.env.MODEL ?? 'z-ai/glm-5.1';

/* ==========================================================
   Función principal de chat
   ========================================================== */

/**
 * Envía una conversación a la API de NVIDIA y devuelve la respuesta del asistente.
 *
 * Formato de solicitud: compatible con OpenAI Chat Completions
 *   - messages: array de {role, content} con el historial de la conversación
 *   - temperature: creatividad de la respuesta (0 = determinista, 1 = muy creativo)
 *
 * @param {Object} params
 * @param {Array<{role: string, content: string}>} params.messages - Historial de mensajes
 * @param {number} [params.temperature=0.2] - Temperatura de muestreo
 * @returns {Promise<{raw: Object, content: string}>} Respuesta cruda de la API y contenido del asistente
 * @throws {Error} Si no hay API key configurada o la API devuelve error
 */
export async function nvidiaChat({ messages, temperature = 0.2 }) {
  // Validar que la API key exista antes de hacer la petición
  if (!NVIDIA_API_KEY) throw new Error('Missing NVIDIA_API_KEY');

  const MAX_RETRIES = 2;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Petición POST al endpoint de chat completions (formato OpenAI-compatible)
      const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature,
        }),
      });

      // Si la API devuelve un error (401, 429, 500, etc.), lanzar excepción con detalles
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // No reintentar errores de autenticación o validación (4xx)
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`NVIDIA API error ${res.status}: ${text.slice(0, 500)}`);
        }
        // Errores de servidor (5xx) sí se reintentan
        throw new Error(`NVIDIA API server error ${res.status}: ${text.slice(0, 500)}`);
      }

      // Extraer el contenido de la respuesta del asistente
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';

      return { raw: data, content };
    } catch (err) {
      lastError = err;

      // No reintentar errores de cliente (4xx) ni si ya agotamos reintentos
      const isClientError = err.message?.includes('NVIDIA API error 4');
      if (isClientError || attempt >= MAX_RETRIES) break;

      // Esperar antes de reintentar (backoff exponencial: 1s, 2s)
      const delay = 1000 * (attempt + 1);
      console.warn(`NVIDIA fetch attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Si todos los reintentos fallaron, lanzar el último error con contexto claro
  const msg = lastError?.cause?.code === 'ECONNREFUSED' || lastError?.cause?.code === 'ENOTFOUND'
    ? `Cannot reach NVIDIA API (${lastError.cause.code}) — check your internet connection`
    : `NVIDIA API error: ${lastError?.message ?? 'unknown'}`;

  throw new Error(msg);
}
