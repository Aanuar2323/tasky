/**
 * nvidia.js — Cliente LLM unificado (OpenRouter / NVIDIA NIM)
 *
 * Este archivo es un re-export de compatibilidad hacia llm-client.js.
 * El cliente real soporta OpenRouter (prioritario) y NVIDIA NIM (fallback)
 * con detección automática según las variables de entorno disponibles.
 *
 * Para usar OpenRouter: define OPENROUTER_API_KEY en .env
 * Para usar NVIDIA:    define solo NVIDIA_API_KEY (sin OPENROUTER_API_KEY)
 */

export { llmChat as nvidiaChat } from './llm-client.js';