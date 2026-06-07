/**
 * openrouter.js — Wrapper de compatibilidad
 *
 * El cliente LLM real ahora vive en llm-client.js, que soporta
 * tanto OpenRouter como NVIDIA NIM de forma unificada.
 */

export { llmChat, llmChat as nvidiaChat } from './llm-client.js';
