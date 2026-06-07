import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, readTextFile } from './storage.js';

async function readOptional(root, relPath) {
  try {
    return await readTextFile(root, relPath);
  } catch {
    return '';
  }
}

async function listMarkdownFiles(root, relDir) {
  try {
    const abs = safeJoin(root, relDir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name !== 'summary.md')
      .map((e) => path.posix.join(relDir.split(path.sep).join(path.posix.sep), e.name));
  } catch {
    return [];
  }
}

function pickRelevantFiles(prompt, files, max = 3) {
  const tokens = (prompt ?? '')
    .toLowerCase()
    .match(/[a-z0-9áéíóúñ]+/gi)
    ?.filter((t) => t.length >= 4) ?? [];

  if (tokens.length === 0) return files.slice(0, max);

  const scored = files
    .map((f) => {
      const name = f.toLowerCase();
      const score = tokens.reduce((acc, t) => (name.includes(t) ? acc + 1 : acc), 0);
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f);

  return (scored.length ? scored : files).slice(0, max);
}

export async function buildContext({
  root,
  areaId,
  rules,
  activeTask,
  attachmentBlocks = [],
  lastUserMessage = '',
  isAuditor = false,
  feedbackPrevio = null
}) {
  const layer1 = await readOptional(root, `ai/areas/${areaId}/layer1/00-role-and-flow.md`);
  const auditorPrompt = await readOptional(root, `ai/areas/${areaId}/layer1/01-auditor.md`);
  
  if (isAuditor) {
    return {
      role: 'system',
      content: `[ROL AUDITOR]\n${auditorPrompt}\n\n[REGLAS DEL PROYECTO]\n${rules}\n\n[TAREA ACTIVA]\n${activeTask || 'Ninguna'}`
    };
  }

  // Nivel 2: Smart inclusions
  const areaSummary = await readOptional(root, `ai/areas/${areaId}/layer2/summary.md`);
  
  const areaFiles = await listMarkdownFiles(root, `ai/areas/${areaId}/layer2/files`);
  const selectedFiles = pickRelevantFiles(lastUserMessage ?? '', areaFiles, 3);
  const selectedBlocks = await Promise.all(
    selectedFiles.map(async (rel) => {
      const content = await readOptional(root, rel);
      const clipped = content.slice(0, 4000);
      return `---\nFILE: ${rel}\n${clipped}\n`;
    })
  );
  
  const selectedText = selectedBlocks.length ? selectedBlocks.join('\n') : '(no se seleccionaron archivos)';

  // Nivel 3: Lazy schemas (solo si el usuario quiere generar/editar archivos o si feedbackPrevio pide arreglar un archivo)
  const userText = (lastUserMessage ?? '').toLowerCase();
  const wantsFiles = userText.match(/crear|generar|excel|xlsx|documento|docx|word|presentaci[óo]n|pptx|imagen|gr[áa]fico|png|tabla|diagrama/i) || 
                     (feedbackPrevio && feedbackPrevio.toLowerCase().includes('archivo'));
                     
  const fileGenerationSchemas = wantsFiles ? `
FILE GENERATION (include "fileGenerated" in your JSON response):
For XLSX: { "type":"xlsx", "data": { "sheets":[{"name":string,"columns":[{"header":string,"key":string,"width"?:number}],"rows":[{"key":value}],"styles"?:{"headerBold":bool,"headerBgColor":string,"headerFontColor":string}}] }, "filename": "..." }
For DOCX: { "type":"docx", "data": { "title"?:string,"sections":[{"type":"heading|paragraph|bullet|table|image","text"?:string,"level"?:1|2|3,"bold"?:bool,"italic"?:bool,"fontSize"?:number,"alignment"?:string,"rows"?:string[][],"imagePath"?:string,"imageWidth"?:number,"imageHeight"?:number}] }, "filename": "..." }
For PPTX: { "type":"pptx", "data": { "title"?:string,"slides":[{"type":"title|content|bullets|table|image","title"?:string,"subtitle"?:string,"body"?:string,"bullets"?:string[],"rows"?:string[][],"imagePath"?:string,"notes"?:string}] }, "filename": "..." }
For PNG chart: { "type":"png", "data": { "type":"chart","chartType":"bar|line|pie|doughnut","title":string,"labels":string[],"datasets":[{"label":string,"data":number[],"color"?:string}],"width"?:number,"height"?:number }, "filename": "..." }
For PNG table: { "type":"png", "data": { "type":"table","title"?:string,"headers":string[],"rows":string[][],"width"?:number,"height"?:number }, "filename": "..." }
For PNG text: { "type":"png", "data": { "type":"text","title":string,"subtitle"?:string,"body":string,"width"?:number,"height"?:number }, "filename": "..." }
For PNG diagram: { "type":"png", "data": { "type":"diagram","title":string,"nodes":[{"id":string,"label":string,"x":number,"y":number}],"edges":[{"from":string,"to":string,"label"?:string}],"width"?:number,"height"?:number }, "filename": "..." }
For edits, include "editPath" and "editChanges" instead of "data".

IMPORTANT LIMITS FOR FILE GENERATION:
- NEVER generate massive datasets. If the user asks for large datasets, generate ONLY 3 to 5 sample rows.
- Maximum 10 rows of data per sheet/table under any circumstance.
- Keep all JSON values compact: no extra whitespace, no comments, no line breaks inside values.
- Use descriptive filenames in Spanish when appropriate.
` : '';

  const systemContent = `You are an agent inside a file-based task app.

LAYER 1 (role + execution order):
${layer1}

LAYER 2 (area summary - ${areaId}):
${areaSummary}

LAYER 2 (selected relevant files):
${selectedText}

RULES (markdown):
${rules}

${activeTask ? `ACTIVE TASK (if you mark complete, you MUST use this taskPath):\n${activeTask}\n` : `ACTIVE TASK: none selected. If you mark complete, set taskPath=null unless the user explicitly referenced a task file.\n`}

${attachmentBlocks.length ? `USER ATTACHMENTS (${attachmentBlocks.length} file(s) — analyze them as requested):\n${attachmentBlocks.join('\n')}\n` : ''}

${feedbackPrevio ? `[FEEDBACK DE AUDITORÍA PREVIA]\nTu intento anterior falló la auditoría. Corrige estos errores:\n${feedbackPrevio}\n\n` : ''}

${fileGenerationSchemas}

You must respond with a JSON object that matches this exact schema:
{
  "content": "<markdown visible for the user, never empty>",
  "meta": { "complete": <bool>, "taskPath": <string|null>, "summary": "<short summary>" },
  "fileGenerated": <optional, only when user asks to create/edit a file>
}

Rules:
- "content" is REQUIRED and must never be empty. Put the user-facing markdown here.
- "meta.complete" should be true only if the user's request is fully solved.
- "meta.taskPath" should be the active task path if you are marking it complete, else null.
- "meta.summary" is a one-line summary of your response.
- "fileGenerated" is OPTIONAL. Include it only when the user asks to create or edit a file.
- A task moves to history only when the user clicks the Completado button in the UI.
`;

  return {
    role: 'system',
    content: systemContent
  };
}
