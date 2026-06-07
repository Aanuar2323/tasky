import { nvidiaChat } from './nvidia.js';
import { executeTool, toolsSchema } from './tools.js';
import { buildContext } from './context-builder.js';

/**
 * Ejecuta una sola llamada al LLM con soporte de tool calling.
 * Sin auditor, sin iteraciones — prompt directo → respuesta.
 */
export async function executeAgenticLoop({
  root,
  areaId,
  rules,
  activeTaskPath,
  attachmentBlocks,
  messages,
  maxIntentos = 1,
  onStreamEvent = () => {}
}) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser?.content ?? '';

  onStreamEvent('iteration', { intento: 1, maxIntentos: 1, status: 'Procesando...' });

  // Construir contexto del sistema
  const systemPrompt = await buildContext({
    root,
    areaId,
    rules,
    activeTask: activeTaskPath,
    attachmentBlocks,
    lastUserMessage: userText,
  });

  let currentConversation = [systemPrompt, ...messages];
  let assistantMessage = null;

  // Llamada al LLM con soporte de tool calls (máximo 5 rondas de tools)
  let toolsResolved = false;
  let toolSafetyNet = 0;
  while (!toolsResolved && toolSafetyNet < 5) {
    const { message } = await nvidiaChat({
      messages: currentConversation,
      tools: toolsSchema
    });
    assistantMessage = message;
    currentConversation.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      onStreamEvent('tool_call', { tool: message.tool_calls[0].function.name, intento: 1 });

      for (const toolCall of message.tool_calls) {
        const toolResult = await executeTool(root, toolCall);
        currentConversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
        });
      }
      toolSafetyNet++;
    } else {
      toolsResolved = true;
    }
  }

  return {
    content: assistantMessage?.content ?? '',
    intentos: 1
  };
}
