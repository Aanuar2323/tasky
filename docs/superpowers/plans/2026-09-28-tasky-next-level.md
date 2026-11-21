# Tasky Next Level — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Ejecución:** el usuario pidió "arma plan y ejecuta sin preguntar nada". Se ejecuta inline (executing-plans) por el mismo autor del plan en la misma sesión. Por eso el plan fija interfaces exactas y tests-contrato; el código de implementación vive en los archivos (no se duplica aquí). No se hacen commits (regla de la sesión: commit solo si el usuario lo pide); cada tarea cierra con la suite verde.

**Goal:** Llevar Tasky a otro nivel: streaming, loop agente con herramientas, compatibilidad multi-modelo, contexto con presupuesto y recuperación, docengine robusto y frontend pulido.

**Architecture:** `index.js` se parte en módulos `llm/`, `context/`, `chat/`. El chat corre un loop agente (tools nativas o protocolo de texto) con eventos SSE. El docengine Python agrega una capa de normalización tolerante y builders mejorados. El frontend consume SSE vía `useChat`.

**Tech Stack:** Node 22 ESM, Express 5, zod 4, node:test · Python 3.11+, pydantic 2, python-docx, openpyxl, python-pptx, unittest · Next 16, React 19, TypeScript, react-markdown.

**Spec:** `docs/superpowers/specs/2026-09-28-tasky-next-level-design.md`

## Global Constraints

- Sin dependencias npm nuevas en `apps/api` ni `apps/web`. Python: solo bump `python-pptx==1.0.2` (coincide con dev local).
- Contrato de storage retrocompatible: logs `.jsonl` viejos (`file` singular, sin `id` en errores) siguen cargando.
- Respuestas y copy de UI en español; hints de error en voseo (como hoy).
- Nunca usar "schema" como nombre del contenido del documento en prompts: el contenido va en `data`.
- Nombres de archivo generados: sin separadores de ruta ni caracteres reservados, ≤ 120 chars, versionados si existen.
- UI: easing `cubic-bezier(0.23, 1, 0.32, 1)`, duraciones ≤ 250 ms, `prefers-reduced-motion`, hover detrás de `(hover: hover) and (pointer: fine)`.
- Tests: `cd apps/api && npm test` (Node) y `python3 -m unittest discover -s apps/api/docengine/tests -t apps/api/docengine` (Python) verdes; `apps/web`: `npx tsc --noEmit`, `npx eslint app` sin errores, `npm run build` OK.

## Review Focus

1. Modelo que devuelve tool-call como texto (`<tool_call>…`) mientras se transmite: el usuario no debe ver el JSON crudo al final → Task 10 (normalize) + Task 17 (e2e "Hermes text tool call").
2. Nombre de archivo malicioso o raro del modelo (`../../x.docx`, `a/b.docx`, `con:`) → Task 7 (sanitización).
3. Conversación muy larga con modelo de 8K de contexto → historial recortado, request no falla por contexto → Task 13 (budget) + Task 17 (e2e "small context").
4. Números como texto en Excel (`"1.500"`, `"$1,200.50"`, `"15%"`, `"00123"`) → valores numéricos correctos sin romper IDs → Task 2 (normalize) + Task 4 (xlsx).
5. Usuario cierra/detiene el stream a mitad → upstream abortado, mensaje parcial persistido como `stopped` → Task 17 (e2e "abort").

---

## Fase A — Docengine (Python)

### Task 1: Harness de tests Python + markdown utils

**Files:**
- Create: `apps/api/docengine/tests/__init__.py`, `apps/api/docengine/tests/helpers.py`, `apps/api/docengine/tests/test_markdown.py`
- Create: `apps/api/docengine/utils/markdown.py`

**Interfaces:**
- Produces: `parse_inline(text:str) -> list[Run]` (`Run = dict(text, bold, italic, code, link)`); `parse_markdown_blocks(text:str) -> list[dict]` que devuelve secciones DOCX (`heading{text,level}`, `paragraph{text}`, `bullets{items}`, `numbered{items}`, `table{headers,rows}`, `code{text,language}`, `quote{text}`, `divider{}`); items anidados como `{"text":..., "children":[...]}`.

- [ ] Step 1: tests

```python
class TestMarkdown(unittest.TestCase):
    def test_inline_bold_italic_code_link(self):
        runs = parse_inline("Hola **mundo** y *cursiva* con `code` y [link](https://x.y)")
        self.assertEqual([r["text"] for r in runs], ["Hola ", "mundo", " y ", "cursiva", " con ", "code", " y ", "link"])
        self.assertTrue(runs[1]["bold"]); self.assertTrue(runs[3]["italic"]); self.assertTrue(runs[5]["code"])
        self.assertEqual(runs[7]["link"], "https://x.y")
    def test_blocks(self):
        md = "# Título\n\nPárrafo uno.\n\n- a\n  - a1\n- b\n\n1. x\n2. y\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> cita\n\n```py\nprint(1)\n```\n\n---"
        kinds = [b["type"] for b in parse_markdown_blocks(md)]
        self.assertEqual(kinds, ["heading", "paragraph", "bullets", "numbered", "table", "quote", "code", "divider"])
    def test_nested_bullets(self):
        b = parse_markdown_blocks("- a\n  - a1\n  - a2\n- b")[0]
        self.assertEqual(b["items"][0], {"text": "a", "children": ["a1", "a2"]})
        self.assertEqual(b["items"][1], "b")
```

- [ ] Step 2: correr → FAIL (módulo no existe). `python3 -m unittest discover -s apps/api/docengine/tests -t apps/api/docengine`
- [ ] Step 3: implementar `utils/markdown.py` (parser de líneas: headings `#{1,6}`, listas `-*+` y `\d+[.)]` con indentación de 2+ espacios para hijos, tablas GFM con separador `|---|`, fences ``` con lenguaje, citas `>`, `---|***|___` divisor; inline por regex en orden code → link → bold → italic).
- [ ] Step 4: correr → PASS.

### Task 2: Normalización tolerante + uniones discriminadas + errores legibles

**Files:**
- Create: `apps/api/docengine/normalize.py`, `apps/api/docengine/tests/test_normalize.py`
- Modify: `apps/api/docengine/schemas/{docx,xlsx,pptx}.py`, `apps/api/docengine/cli.py`

**Interfaces:**
- Produces: `normalize_payload(fmt:str, payload:dict) -> tuple[dict, list[str]]`; `coerce_cell(value) -> value | {"v": value, "fmt": str}`; `format_validation_error(err) -> str`.
- CLI: stderr en error `{"error": "schema_error", "detail": "<resumen corto>"}`; en éxito stderr `{"fixes": [...]}`.

- [ ] Step 1: tests

```python
def test_docx_markdown_top_level(self):
    p, fixes = normalize_payload("docx", {"title": "T", "markdown": "# H\n\ntexto"})
    self.assertEqual([s["type"] for s in p["sections"]], ["heading", "paragraph"]); self.assertIn("docx_markdown_converted", fixes)
def test_docx_aliases(self):
    p, _ = normalize_payload("docx", {"sections": [{"type": "h2", "text": "A"}, {"type": "text", "content": "B"}, {"type": "list", "items": "x\ny"}, {"rows": [{"A": 1, "B": 2}]}]})
    self.assertEqual(p["sections"][0], {"type": "heading", "text": "A", "level": 2})
    self.assertEqual(p["sections"][1]["type"], "paragraph"); self.assertEqual(p["sections"][1]["text"], "B")
    self.assertEqual(p["sections"][2]["items"], ["x", "y"])
    self.assertEqual(p["sections"][3]["headers"], ["A", "B"]); self.assertEqual(p["sections"][3]["rows"], [[1, 2]])
def test_docx_sections_under_other_key(self):
    p, _ = normalize_payload("docx", {"content": [{"type": "paragraph", "text": "x"}]})
    self.assertEqual(len(p["sections"]), 1)
def test_xlsx_numbers(self):
    self.assertEqual(coerce_cell("1.500"), 1500)
    self.assertEqual(coerce_cell("1,500.50"), 1500.5)
    self.assertEqual(coerce_cell("12,5"), 12.5)
    self.assertEqual(coerce_cell("15%"), {"v": 0.15, "fmt": "0%"})
    self.assertEqual(coerce_cell("$1,200.50"), {"v": 1200.5, "fmt": '"$"#,##0.00'})
    self.assertEqual(coerce_cell("00123"), "00123")
    self.assertEqual(coerce_cell("2024-03-15")["fmt"], "dd/mm/yyyy")
    self.assertEqual(coerce_cell("=SUM(A1:A3)"), "=SUM(A1:A3)")
def test_xlsx_rows_as_objects(self):
    p, _ = normalize_payload("xlsx", {"sheets": [{"name": "S", "rows": [{"Mes": "Ene", "Total": "10"}]}]})
    self.assertEqual(p["sheets"][0]["headers"], ["Mes", "Total"]); self.assertEqual(p["sheets"][0]["rows"], [["Ene", 10]])
def test_pptx_aliases(self):
    p, _ = normalize_payload("pptx", {"slides": [{"type": "bullets", "title": "A", "content": "x\ny"}]})
    self.assertEqual(p["slides"][0]["layout"], "content"); self.assertEqual(p["slides"][0]["bullets"], ["x", "y"])
def test_validation_error_is_short(self):
    from schemas.docx import DocxPayload
    try: DocxPayload.model_validate({"sections": [{"type": "nope"}]})
    except Exception as e: msg = format_validation_error(e)
    self.assertIn("sections.0", msg); self.assertLess(len(msg), 700)
```

- [ ] Step 2: FAIL. Step 3: implementar (alias maps; `Field(discriminator="type")`/`"layout"`; nuevas secciones `callout`, portada/encabezado/pie; `BulletItem`; `Sheet.charts`, `as_table`; `stats`/`agenda` slides; `cli.py` llama `normalize_payload` antes de `_validate_nonempty`). Step 4: PASS + `npm test` (cli.test.js) verde.

### Task 3: DOCX builder

**Files:** Modify `apps/api/docengine/builders/docx_builder.py`; Create `apps/api/docengine/tests/test_docx_builder.py`

- [ ] Step 1: tests (abrir resultado con python-docx)

```python
def test_inline_markdown_renders_bold(self):
    doc = build({"sections": [{"type": "paragraph", "text": "Hola **mundo**"}]})
    runs = [r for p in doc.paragraphs for r in p.runs if r.text == "mundo"]
    self.assertTrue(runs and runs[0].bold)
    self.assertNotIn("**", "\n".join(p.text for p in doc.paragraphs))
def test_nested_bullets_levels(self):
    doc = build({"sections": [{"type": "bullets", "items": [{"text": "a", "children": ["a1"]}, "b"]}]})
    styles = [p.style.name for p in doc.paragraphs if p.text in ("a", "a1", "b")]
    self.assertEqual(styles, ["List Bullet", "List Bullet 2", "List Bullet"])
def test_table_header_repeat_and_numeric_align(self):
    doc = build({"sections": [{"type": "table", "headers": ["N", "Monto"], "rows": [["a", 1500]]}]})
    t = doc.tables[0]
    self.assertIn("tblHeader", t.rows[0]._tr.xml)
    self.assertEqual(t.rows[1].cells[1].paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.RIGHT)
    self.assertEqual(t.rows[1].cells[1].text, "1.500")  # formato es-AR de miles
def test_callout_and_cover(self):
    doc = build({"title": "Informe", "cover": True, "sections": [{"type": "callout", "variant": "warning", "text": "Ojo"}]})
    self.assertIn("Informe", doc.paragraphs[0].text + doc.paragraphs[1].text)
    self.assertTrue(any("Ojo" in p.text for p in doc.paragraphs) or any("Ojo" in c.text for t in doc.tables for r in t.rows for c in r.cells))
def test_footer_page_x_of_y(self):
    doc = build({"sections": [{"type": "paragraph", "text": "x"}]})
    xml = doc.sections[0].footer._element.xml
    self.assertIn("PAGE", xml); self.assertIn("NUMPAGES", xml)
```

- [ ] Step 2 FAIL → Step 3 implementar (helpers `add_rich_text`, `_list_paragraph(level)`, `_set_repeat_header`, `_fmt_number` con separador de miles "." y decimal ",", `_callout` como tabla 1x1 sombreada con borde izquierdo, portada con salto de página, pie "Página X de Y", `rFonts` eastAsia, espaciado 6 pt / interlineado 1.15) → Step 4 PASS.

### Task 4: XLSX builder

**Files:** Modify `apps/api/docengine/builders/xlsx_builder.py`; Create `apps/api/docengine/tests/test_xlsx_builder.py`

- [ ] Step 1: tests

```python
def test_numbers_are_numeric_and_table_created(self):
    wb = build({"sheets": [{"name": "V", "headers": ["Mes", "Total"], "rows": [["Ene", "1.500"], ["Feb", "2.300"]]}]})
    ws = wb["V"]
    self.assertEqual(ws["B2"].value, 1500); self.assertEqual(len(ws.tables), 1)
def test_summary_only_numeric_columns(self):
    wb = build({"sheets": [{"name": "V", "headers": ["Mes", "Nota", "Total"], "rows": [["Ene", "x", 1], ["Feb", "y", 2]], "summary_row": {"label": "Total"}}]})
    ws = wb["V"]
    self.assertIsNone(ws["B4"].value); self.assertEqual(ws["C4"].value, "=SUM(C2:C3)")
def test_chart_references_real_range(self):
    wb = build({"sheets": [{"name": "V", "headers": ["Mes", "Total"], "rows": [["Ene", 1], ["Feb", 2]], "chart": {"type": "bar", "title": "T"}}]})
    ws = wb["V"]
    self.assertEqual(len(ws._charts), 1)
    ref = ws._charts[0].series[0].val.numRef.f
    self.assertIn("$B$2:$B$3", ref)
def test_percent_format_and_freeze(self):
    wb = build({"sheets": [{"name": "V", "headers": ["A", "P"], "rows": [["x", "15%"]]}]})
    ws = wb["V"]
    self.assertEqual(ws["B2"].value, 0.15); self.assertEqual(ws["B2"].number_format, "0%"); self.assertEqual(ws.freeze_panes, "A2")
def test_explicit_series_go_to_hidden_sheet(self):
    wb = build({"sheets": [{"name": "V", "headers": ["A"], "rows": [["x"]], "chart": {"type": "pie", "labels": ["a", "b"], "series": [{"name": "s", "values": [1, 2]}]}}]})
    self.assertIn("_datos_graficos", wb.sheetnames); self.assertEqual(wb["_datos_graficos"].sheet_state, "hidden")
```

- [ ] Step 2 FAIL → Step 3 implementar (celdas `{"v","fmt"}`, `ws.add_table` con encabezados únicos, ancho por contenido 8–60, freeze por defecto, resumen solo numéricas, charts: series por columna/auto/explícitas en hoja oculta, `x_axis.delete=False`, `y_axis.delete=False`, tipos bar/col/line/pie/doughnut/area/scatter, stacked, data labels) → Step 4 PASS.

### Task 5: PPTX builder

**Files:** Modify `apps/api/docengine/builders/pptx_builder.py`; Create `apps/api/docengine/tests/test_pptx_builder.py`

- [ ] Step 1: tests

```python
def test_slide_numbers_and_footer(self):
    prs = build({"slides": [{"layout": "title", "title": "A"}, {"layout": "content", "title": "B", "bullets": ["x"]}]})
    texts = [sh.text_frame.text for sh in prs.slides[1].shapes if sh.has_text_frame]
    self.assertIn("2", texts)
def test_long_table_splits(self):
    rows = [[str(i), str(i * 2)] for i in range(25)]
    prs = build({"slides": [{"layout": "table", "title": "T", "headers": ["a", "b"], "rows": rows}]})
    self.assertEqual(len(prs.slides), 3)
def test_sub_bullets_levels(self):
    prs = build({"slides": [{"layout": "content", "title": "T", "bullets": ["a", {"text": "a1", "level": 1}]}]})
    paras = [p for sh in prs.slides[0].shapes if sh.has_text_frame for p in sh.text_frame.paragraphs if p.text == "a1"]
    self.assertEqual(paras[0].level, 1)
def test_stats_layout(self):
    prs = build({"slides": [{"layout": "stats", "title": "KPIs", "stats": [{"value": "92%", "label": "Satisfacción"}, {"value": "1.2M", "label": "Usuarios"}]}]})
    alltext = " ".join(sh.text_frame.text for sh in prs.slides[0].shapes if sh.has_text_frame)
    self.assertIn("92%", alltext); self.assertIn("Usuarios", alltext)
def test_scatter_is_xy(self):
    prs = build({"slides": [{"layout": "chart", "title": "S", "chart": {"type": "scatter", "labels": ["1", "2"], "series": [{"name": "s", "values": [3, 4]}]}}]})
    ch = [sh for sh in prs.slides[0].shapes if sh.has_chart][0].chart
    self.assertEqual(ch.chart_type, XL_CHART_TYPE.XY_SCATTER)
```

- [ ] Step 2 FAIL → Step 3 implementar (sistema de layout 13.333×7.5, banda de acento, tamaño de fuente por volumen de texto, `normAutofit`, sub-bullets, número de diapositiva y pie, `stats`, `agenda`, tablas partidas cada 10 filas, charts XY/doughnut/area/stacked/data labels) → Step 4 PASS.

### Task 6: Editores + requirements

**Files:** Modify `apps/api/docengine/builders/{docx,pptx,xlsx}_editor.py`, `apps/api/docengine/requirements.txt`; Create `apps/api/docengine/tests/test_editors.py`

- [ ] Step 1: tests

```python
def test_docx_replace_across_runs(self):
    src = docx_with_runs(["Hola ", "{{cli", "ente}}", " fin"])
    out = Document(io.BytesIO(edit_docx(b64(src), {"template": {"cliente": "ACME"}})))
    self.assertEqual(out.paragraphs[0].text, "Hola ACME fin")
def test_docx_replace_in_table_and_footer(self): ...  # reemplazo presente en celda y pie
def test_pptx_template_key_with_or_without_braces(self):
    for key in ("{{cliente}}", "cliente"):
        out = edit_pptx(b64(pptx_with_text("Para {{cliente}}")), {"template": {key: "ACME"}})
        self.assertIn("Para ACME", all_text(out))
def test_xlsx_new_sheet_and_update(self):
    out = edit_xlsx(b64(xlsx_simple()), {"sheets": [{"name": "Nueva", "create": True, "add_rows": [["a", 1]]}, {"name": "Hoja", "update_cells": [{"cell": "A1", "value": "X"}]}]})
    wb = load_workbook(io.BytesIO(out)); self.assertIn("Nueva", wb.sheetnames); self.assertEqual(wb["Hoja"]["A1"].value, "X")
```

- [ ] Step 2 FAIL → Step 3 implementar (`replace_in_paragraph` que une runs, recorre cuerpo/tablas anidadas/encabezados/pies; normalización de claves de plantilla; xlsx `create`, `rename`) → Step 4 PASS. `requirements.txt`: `python-pptx==1.0.2`.

## Fase B — Backend: fundamentos

### Task 7: docengine.js — sanitización, versionado, sidecar

**Files:** Modify `apps/api/src/generators/docengine.js`; Modify `apps/api/tests/cli.test.js`

**Interfaces:**
- Produces: `sanitizeFilename(name, type) -> string`; `generateFile({type, outputDir, data, filename, source?, overwrite?}) -> {filePath, filename, fixes}`; `editFile({type, inputPath, outputDir, changes, filename}) -> {filePath, filename}`; `readSourceSidecar(outputDir, filename) -> object|null`; `detectFileType(name)`.
- Sidecar: `<outputDir>/.tasky/<filename>.json` = `{type, filename, summary, data, createdAt, areaId, chatId}`.

- [ ] Step 1: tests

```js
it('sanitiza nombres con rutas', () => {
  assert.equal(sanitizeFilename('../../x.docx', 'docx'), 'x.docx');
  assert.equal(sanitizeFilename('a/b:c?.xlsx', 'xlsx'), 'b_c_.xlsx');
  assert.equal(sanitizeFilename('', 'pptx').endsWith('.pptx'), true);
});
it('versiona si el archivo existe y escribe sidecar', async () => {
  const a = await generateFile({ type: 'docx', outputDir: dir, filename: 'inf.docx', data: DOCX, source: { summary: 's' } });
  const b = await generateFile({ type: 'docx', outputDir: dir, filename: 'inf.docx', data: DOCX });
  assert.equal(a.filename, 'inf.docx'); assert.equal(b.filename, 'inf-v2.docx');
  const side = await readSourceSidecar(dir, 'inf.docx'); assert.equal(side.summary, 's'); assert.deepEqual(side.data, DOCX);
});
```

- [ ] Step 2 FAIL → Step 3 implementar → Step 4 PASS.

### Task 8: Config por proveedor + providers + errores

**Files:** Modify `apps/api/src/config.js`; Create `apps/api/src/llm/providers.js`, `apps/api/src/llm/errors.js`; Create `apps/api/tests/providers.test.js`

**Interfaces:**
- `config.js`: `getModelFor(provider) -> string|null` (migra `model` legacy al proveedor guardado en `provider`), `saveUserConfig({models:{...}})` hace merge profundo de `models`.
- `providers.js`: `getActive() -> {provider, baseUrl, apiKey, model, label}`, `setActiveProvider(p) -> boolean`, `updateProviderConfig({provider, apiKey?, model?}) -> Promise<void>`, `getAvailableProviders()`, `isConfigured()`, `providerConfig(p)`.
- `errors.js`: `classifyStatus(status, body) -> kind`, `humanizeError(err) -> {title, hint, codes, retriable}`, `ERROR_LABELS`.

- [ ] Step 1: tests

```js
it('cada proveedor recuerda su modelo', async () => {
  await updateProviderConfig({ provider: 'openrouter', apiKey: 'sk-or-xxxxxxxxxx', model: 'a/b:free' });
  await updateProviderConfig({ provider: 'nvidia', apiKey: 'nvapi-xxxxxxxxxx', model: 'meta/llama-3.3-70b-instruct' });
  setActiveProvider('nvidia'); assert.equal(getActive().model, 'meta/llama-3.3-70b-instruct');
  setActiveProvider('openrouter'); assert.equal(getActive().model, 'a/b:free');
});
it('mapea 404 de tools y de privacidad', () => {
  assert.equal(classifyStatus(404, '{"error":{"message":"No endpoints found that support tool use"}}'), 'tools_unsupported');
  assert.equal(classifyStatus(404, 'No endpoints found matching your data policy'), 'data_policy');
  assert.equal(classifyStatus(404, 'model not found'), 'model_not_found');
  assert.match(humanizeError({ kind: 'data_policy', status: 404 }).hint, /privacy/);
});
```

- [ ] Step 2 FAIL → Step 3 implementar → Step 4 PASS + suite existente verde (api.test.js usa `/api/setup`, `/api/provider/keys`).

### Task 9: Perfil de capacidades de modelo

**Files:** Create `apps/api/src/llm/capabilities.js`, `apps/api/tests/fixtures/openrouter-models.json`, `apps/api/tests/capabilities.test.js`

**Interfaces:**
- `getModelProfile(provider, model, {baseUrl, apiKey, fetchImpl}) -> Promise<{id, provider, contextLength, maxOutput, tools:boolean|null, temperature:boolean, reasoning:boolean, vision:boolean, source:'catalog'|'heuristic'}>`
- `listModels(provider, {baseUrl, apiKey}) -> Promise<Array<{id, name, isFree, contextLength, maxOutput, tools, vision, reasoning}>>`
- `learnCapability(provider, model, patch) -> Promise<void>` (persiste `storage/model-capabilities.json`), `clearCapabilityCache()`.

- [ ] Step 1: tests

```js
it('usa el catálogo de OpenRouter', async () => {
  const p = await getModelProfile('openrouter', 'nvidia/nemotron-3.5-lightning:free', { fetchImpl: fixtureFetch });
  assert.equal(p.tools, true); assert.equal(p.contextLength, 1000000); assert.equal(p.maxOutput, 16384); assert.equal(p.source, 'catalog');
});
it('temperature=false si el modelo no la soporta', async () => { /* modelo del fixture sin "temperature" */ });
it('heurística para NVIDIA', async () => {
  const p = await getModelProfile('nvidia', 'meta/llama-3.2-90b-vision-instruct', { fetchImpl: failingFetch });
  assert.equal(p.vision, true); assert.equal(p.contextLength, 128000); assert.equal(p.source, 'heuristic');
});
it('lo aprendido pisa al catálogo y persiste', async () => {
  await learnCapability('openrouter', 'nvidia/nemotron-3.5-lightning:free', { tools: false });
  clearCapabilityCache({ keepLearned: false });
  const p = await getModelProfile('openrouter', 'nvidia/nemotron-3.5-lightning:free', { fetchImpl: fixtureFetch });
  assert.equal(p.tools, false);
});
```

- [ ] Step 2 FAIL → Step 3 implementar → Step 4 PASS.

### Task 10: Normalización de salida de modelos

**Files:** Create `apps/api/src/llm/normalize.js`, `apps/api/tests/normalize.test.js`

**Interfaces:**
- `createThinkFilter() -> {push(text) -> {content, reasoning}, flush() -> {content, reasoning}}`
- `stripThink(text) -> {content, reasoning}`
- `extractTextToolCalls(text, toolNames) -> {calls: [{id, name, arguments}], text}`
- `parseToolArguments(raw) -> object|null`
- `createMarkerFilter() -> {push(text) -> string, flush() -> string}` (oculta marcadores de tool-call/tasky-file durante streaming)

- [ ] Step 1: tests

```js
it('think partido entre chunks', () => {
  const f = createThinkFilter(); let c = '', r = '';
  for (const ch of ['Ho', '<thi', 'nk>pien', 'so</th', 'ink>la']) { const o = f.push(ch); c += o.content; r += o.reasoning; }
  const o = f.flush(); c += o.content; r += o.reasoning;
  assert.equal(c, 'Hola'); assert.equal(r, 'pienso');
});
it('</think> sin apertura (R1 distill)', () => assert.deepEqual(stripThink('razono</think>Respuesta'), { content: 'Respuesta', reasoning: 'razono' }));
it('Hermes <tool_call>', () => {
  const r = extractTextToolCalls('Ok.\n<tool_call>{"name":"generate_file","arguments":{"type":"docx"}}</tool_call>', ['generate_file']);
  assert.equal(r.calls[0].name, 'generate_file'); assert.equal(JSON.parse(r.calls[0].arguments).type, 'docx'); assert.equal(r.text.trim(), 'Ok.');
});
it('Mistral [TOOL_CALLS]', () => { /* lista y formato name[ARGS]{...} */ });
it('DeepSeek full-width', () => {
  const t = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path":"a.md"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
  assert.equal(extractTextToolCalls(t, ['read_file']).calls[0].name, 'read_file');
});
it('JSON suelto con name/parameters solo si es tool conocida', () => {
  assert.equal(extractTextToolCalls('{"name":"read_file","parameters":{"path":"x"}}', ['read_file']).calls.length, 1);
  assert.equal(extractTextToolCalls('{"name":"otro","parameters":{}}', ['read_file']).calls.length, 0);
});
it('marker filter oculta tool_call en streaming', () => {
  const f = createMarkerFilter(); let out = '';
  for (const ch of ['Listo ', '<tool', '_call>{"a":1}</tool_call>', ' fin']) out += f.push(ch);
  out += f.flush(); assert.equal(out, 'Listo  fin');
});
```

- [ ] Step 2 FAIL → Step 3 implementar → Step 4 PASS.

### Task 11: Cliente LLM con streaming y reintentos adaptativos

**Files:** Create `apps/api/src/llm/client.js`, `apps/api/tests/helpers/mock-llm.js`, `apps/api/tests/client.test.js`; Rewrite `apps/api/src/llm-client.js` (fachada)

**Interfaces:**
- `chatCompletion({messages, tools?, toolChoice?, stream?, signal?, onEvent?, profile?, temperature?, maxTokens?, target?}) -> Promise<{content, reasoning, toolCalls, finishReason, usage, model, generationId}>`; `onEvent({type:'delta'|'reasoning', text})`.
- Error lanzado: `Error` con `{kind, status, retriable, retryAfter, provider, generationId, body}`; `kind:'tools_unsupported'` señala al caller que cambie a protocolo de texto (y ya quedó aprendido).
- Fachada `llm-client.js`: `llmChat`, `nvidiaChat`, `getAvailableProviders`, `setProvider`, `getActiveConfig`, `getActiveProvider`, `updateApiConfig`, `getModelsForProvider`, `isConfigured`, `TOOLS`, `LEGACY_RESPONSE_FORMAT`.
- `mock-llm.js`: `startMockLlm(handler) -> {url, requests, close}`; handler `(body, n) -> {sse:[chunk...]} | {json} | {status, body, headers}`.

- [ ] Step 1: tests

```js
it('stream: texto + reasoning + tool call fragmentado', async () => { /* 3 chunks con delta.tool_calls[index 0] arguments partidos → toolCalls[0].arguments completo */ });
it('stream: <think> no llega al contenido', async () => {});
it('temperature no soportada → reintenta sin temperature y aprende', async () => {});
it('max_tokens excesivo → reintenta con el límite del mensaje', async () => {});
it('402 can only afford → reintenta con menos tokens', async () => {});
it('429 con retry-after → reintenta', async () => {});
it('404 tools → lanza tools_unsupported y aprende tools=false', async () => {});
it('abort → kind aborted', async () => {});
```

- [ ] Step 2 FAIL → Step 3 implementar (SSE por líneas, `delta.content|reasoning|reasoning_content|tool_calls`, `usage` final, error en stream, timeout de inactividad 120 s, `TASKY_RETRY_BASE_MS`) → Step 4 PASS.

## Fase C — Contexto

### Task 12: Extracción con caché

**Files:** Create `apps/api/src/context/extract.js`, `apps/api/tests/extract.test.js`; Modify `apps/api/src/index.js` (usa el módulo, re-exporta `readContextFile`, `CONTEXT_EXTS`, `listAllContextFiles`)

**Interfaces:** `CONTEXT_EXTS`, `kindOf(name)`, `extractText(absPath) -> Promise<string>` (caché por mtime+size), `extractTextFromBuffer(buf, name) -> Promise<string>`, `decodeXmlEntities(s)`, `extractStats() -> {hits, misses}`.

- [ ] Step 1: tests: entidades XML (`&amp;` → `&`, `&#233;` → `é`), `<a:t xml:space="preserve">` reconocido, segunda lectura es hit de caché, cambio de mtime invalida. `context.test.js` existente sigue verde.
- [ ] Steps 2–4: FAIL → implementar → PASS.

### Task 13: Recuperación BM25 + presupuesto

**Files:** Create `apps/api/src/context/retrieval.js`, `apps/api/src/context/budget.js`, `apps/api/tests/retrieval.test.js`, `apps/api/tests/budget.test.js`

**Interfaces:** `tokenize(text)`, `chunkText(text, {size, overlap})`, `buildIndex(docs)`, `search(index, query, {limit, perDocLimit, filenameBoost})`; `estimateTokens(text)`, `estimateMessagesTokens(msgs)`, `planBudget({contextLength, maxOutput, maxInput?}) -> {input, output, core, sections:{rules, generated, retrieval, attachments, history}}`, `truncateToTokens(text, n)`.

- [ ] Step 1: tests

```js
it('encuentra el fragmento relevante ignorando tildes', () => {
  const idx = buildIndex([{ id: 'a', path: 'a.md', text: 'Política de vacaciones: 15 días hábiles.' }, { id: 'b', path: 'b.md', text: 'Menú del comedor.' }]);
  assert.equal(search(idx, 'cuantos dias de vacaciones', { limit: 1 })[0].path, 'a.md');
});
it('chunks con solapamiento y límites de párrafo', () => {});
it('planBudget con 8K reduce salida y reparte', () => {
  const b = planBudget({ contextLength: 8192, maxOutput: 8192 });
  assert.ok(b.output <= 3072); assert.ok(b.input + b.output <= 8192); assert.ok(b.sections.history > 0);
});
it('planBudget con 1M limita la entrada', () => assert.ok(planBudget({ contextLength: 1_000_000, maxOutput: 16384 }).input <= 100_000));
```

- [ ] Steps 2–4.

### Task 14: Contexto de proyecto + historial

**Files:** Create `apps/api/src/context/project.js`, `apps/api/src/context/history.js`, `apps/api/tests/project-context.test.js`, `apps/api/tests/history.test.js`

**Interfaces:**
- `project.js`: `parseRules(md)`, `renderActiveRules(md) -> string`, `isTemplateText(md)`, `isDefaultContent(kind, md)`, `loadProjectContext(root, areaId, areas) -> {projectName, areaName, summary, areaSummary, rules, customInstructions}`, `listGeneratedFiles(root, {areaId, limit}) -> [{path, filename, type, summary, createdAt, chatId}]`, `listAreaContextFiles(root, areaId)`.
- `history.js`: `readChatLog`, `appendChatEntry`, `rewriteChatLog`, `truncateAfterLastUser(root, areaId, chatId) -> {lastUser, removed}`, `entriesToMessages(entries) -> [{role, content, id, ts}]`, `fitHistory(messages, budgetTokens, summary?) -> {messages, dropped}`, `loadSummary`, `saveSummary`, `shouldCompact(messages, budget)`.

- [ ] Step 1: tests

```js
it('solo reglas activas', () => {
  const md = '### Tono\n- Formal\n`enabled`\n\n### Emojis\n- Usar emojis\n`disabled`';
  assert.equal(renderActiveRules(md), '- Tono: Formal');
});
it('plantilla por defecto = vacía', () => assert.equal(renderActiveRules('# Reglas del área: X\n\n**Instrucciones:** Configura…'), ''));
it('reglas libres (no plantilla) pasan crudas', () => assert.equal(renderActiveRules('Siempre en inglés.'), 'Siempre en inglés.'));
it('historial: nota de archivo, sin errores', () => {
  const msgs = entriesToMessages([{ role: 'user', content: 'hacé un word' }, { role: 'assistant', content: 'Listo', file: { name: 'a.docx', url: 'files/generated/a.docx', type: 'docx' } }, { role: 'assistant', content: '', error: { title: 'x' } }]);
  assert.equal(msgs.length, 2); assert.match(msgs[1].content, /\[Archivo generado: a\.docx \(docx\) — files\/generated\/a\.docx\]/);
});
it('fitHistory corta lo más viejo y conserva el último', () => {});
it('truncateAfterLastUser borra respuesta/error posteriores', async () => {});
```

- [ ] Steps 2–4.

## Fase D — Pipeline de chat

### Task 15: Protocolo (parser legacy + bloques tasky-file)

**Files:** Create `apps/api/src/chat/protocol.js`; Modify `apps/api/src/index.js` (re-export); Modify `apps/api/tests/parser.test.js` (imports, TOOLS nuevos), Create `apps/api/tests/protocol.test.js`

**Interfaces:** `parseStructuredResponse(raw)` (sin cambios de contrato), `normalizeFileGenerated(fg) -> {fg, fixes}` (+ `data_hoisted_from_top_level`, `data_from_<key>`, acepta `markdown`), `extractFileBlocks(text) -> {text, files}`, `parseTextModeResponse(raw) -> {content, files, warnings}`.

- [ ] Step 1: tests

```js
it('bloque tasky-file se extrae y no queda visible', () => {
  const r = extractFileBlocks('Te dejo el archivo.\n```tasky-file\n{"type":"docx","filename":"a.docx","data":{"markdown":"# Hola"}}\n```\nSaludos');
  assert.equal(r.files.length, 1); assert.equal(r.text, 'Te dejo el archivo.\n\nSaludos');
});
it('json fence con forma de archivo también cuenta', () => {});
it('secciones en la raíz se mueven a data', () => {
  const { fg, fixes } = normalizeFileGenerated({ type: 'docx', filename: 'a.docx', sections: [{ type: 'paragraph', text: 'x' }] });
  assert.equal(fg.data.sections.length, 1); assert.ok(fixes.includes('data_hoisted_from_top_level'));
});
it('docx con solo markdown es válido', () => assert.ok(normalizeFileGenerated({ type: 'docx', filename: 'a.docx', data: { markdown: '# x' } }).fg));
it('parseTextModeResponse acepta wrapper legacy', () => {});
```

- [ ] Steps 2–4 (parser.test.js: `TOOLS` pasa a 3 herramientas `edit_file`, `generate_file`, `read_file`).

### Task 16: Herramientas + prompt

**Files:** Create `apps/api/src/chat/tools.js`, `apps/api/src/chat/prompt.js`, `apps/api/tests/tools-chat.test.js`, `apps/api/tests/prompt.test.js`

**Interfaces:**
- `TOOL_DEFS` (OpenAI tools), `TOOL_NAMES`, `executeTool(call, ctx) -> Promise<{ok, content, file?}>`, `ctx = {root, areaId, chatId, emit}`; `isReadablePath(relPath, areaId) -> boolean`; `compactToolCallForReplay(call) -> call`.
- `buildSystemPrompt({mode, now, project, sections}) -> string` donde `sections = {rules, customInstructions, fileIndex, snippets, generated, conversationSummary}`; `FILE_REFERENCE` (texto de referencia de `data`).

- [ ] Step 1: tests

```js
it('read_file rechaza rutas internas', () => {
  assert.equal(isReadablePath('ai/layer1/00-role-and-flow.md', 'a1'), false);
  assert.equal(isReadablePath('ai/layer2/areas/a1/rules(ajkwygebfickuvaulwakfjbscfa).md', 'a1'), false);
  assert.equal(isReadablePath('ai/layer2/areas/a1/notas.md', 'a1'), true);
  assert.equal(isReadablePath('files/generated/x.docx', 'a1'), true);
  assert.equal(isReadablePath('info/areas.json', 'a1'), false);
});
it('generate_file inválido devuelve error legible para el modelo', async () => {
  const r = await executeTool({ id: 'c1', name: 'generate_file', arguments: '{"type":"docx","filename":"x.docx","data":{"sections":[{"type":"nope"}]}}' }, ctx);
  assert.equal(r.ok, false); assert.match(r.content, /sections\.0/);
});
it('generate_file válido crea archivo y sidecar', async () => {});
it('prompt en modo texto explica tasky-file y no menciona herramientas', () => {});
it('prompt nunca usa "schema" como clave del contenido', () => assert.ok(!/"schema"\s*:/.test(buildSystemPrompt({ mode: 'tools', now: new Date(), project: {}, sections: {} }))));
```

- [ ] Steps 2–4.

### Task 17: Servicio de chat, SSE y rutas

**Files:** Create `apps/api/src/chat/service.js`, `apps/api/src/chat/sse.js`, `apps/api/tests/chat-e2e.test.js`; Modify `apps/api/src/index.js` (chat, preview, generated, models, status)

**Interfaces:**
- `runChat({root, areaId, chatId, areas, userText, attachments, regenerate, signal, emit}) -> Promise<record>`; eventos `start|status|reasoning|delta|file|done|error`.
- `createSse(res) -> {send(event, data), close()}`.
- Rutas: `POST /api/projects/:id/chat` (`Accept: text/event-stream` → SSE), `GET /api/projects/:id/preview?path=`, `GET /api/projects/:id/generated?areaId=`.

- [ ] Step 1: tests e2e (mock LLM + storage temporal):

```js
it('texto en streaming y persistencia', async () => { /* eventos delta concatenados === done.message.content; log tiene user + assistant */ });
it('tool call generate_file crea archivo real', async () => { /* evento file; files/generated/<name> existe; sidecar existe */ });
it('autocorrección tras error de validación', async () => { /* 1ª llamada data inválida → tool result con error → 2ª llamada válida → archivo */ });
it('modelo sin tools → protocolo de texto', async () => { /* 404 tools → reintento sin tools con tasky-file → archivo + texto limpio */ });
it('tool-call Hermes en texto', async () => { /* contenido final sin <tool_call> */ });
it('regenerate no duplica el mensaje del usuario', async () => {});
it('contexto chico: historial recortado y request aceptada', async () => { /* mock verifica tokens estimados < contexto */ });
it('abort a mitad de stream persiste parcial con stopped', async () => {});
it('JSON (sin SSE) mantiene forma {id, content, meta, file, files}', async () => {});
it('preview de docx devuelve markdown', async () => {});
```

- [ ] Steps 2–4 + suite completa verde.

### Task 18: Scaffold, docs y referencias

**Files:** Modify `apps/api/src/storage.js` (plantillas nuevas sin "máx 10 filas", con marcador de plantilla), `README.md`, `storage/defaults/skills/generators/*.md` (referencias actualizadas); test en `storage.test.js` (reglas por defecto no contienen "10 filas").

- [ ] Steps: test FAIL → cambiar → PASS.

## Fase E — Frontend

### Task 19: Cliente SSE + useChat + usePersistentState

**Files:** Modify `apps/web/app/lib/api.ts`, `apps/web/app/types/chat.ts`; Create `apps/web/app/lib/sse.ts`, `apps/web/app/hooks/useChat.ts`, `apps/web/app/hooks/usePersistentState.ts`; Modify `apps/web/app/page.tsx`

**Interfaces:** `streamChat(projectId, {message, areaId, chatId, regenerate?, attachments?: File[]}, {signal, onEvent}) -> Promise<void>`; `parseSseChunk(buffer) -> {events, rest}`; `useChat({projectId, areaId, chatId}) -> {messages, sending, send(text, files), stop(), regenerate(), reload(), markSaved(i)}`; `usePersistentState<T>(key, initial) -> [T, set]` (useSyncExternalStore).

- [ ] Verificación: `npx tsc --noEmit`, `npx eslint app` sin errores.

### Task 20: Mensajes, archivos, markdown, estado vacío

**Files:** Modify `ChatPanel.tsx`, `MarkdownRenderer.tsx`, `ErrorPill.tsx`, `workspace.css`; Create `components/MessageItem.tsx`, `components/FileCard.tsx`, `components/EmptyState.tsx`, `components/StatusChip.tsx`

- [ ] Verificación visual + tsc/eslint.

### Task 21: Composer con adjuntos y detener

**Files:** Modify `components/Composer.tsx`, `workspace.css`

- [ ] Arrastrar/pegar/quitar adjuntos, `isComposing`, botón detener mientras transmite. Verificación visual.

### Task 22: Vista previa de archivos

**Files:** Create `components/FilePreview.tsx`; Modify `lib/api.ts` (`getPreview`), `workspace.css`

- [ ] DOCX (markdown), XLSX (pestañas + tabla), PPTX (tarjetas 16:9), texto. Esc/backdrop cierran; foco atrapado.

### Task 23: Selector de modelos

**Files:** Modify `components/ModelSelectorModal.tsx`, `components/ModelBar.tsx`, `lib/api.ts` (`ModelInfo` con capacidades), `workspace.css`

- [ ] Búsqueda, filtro gratis, badges, lista virtual simple (render ≤ 200 filas filtradas), teclado ↑/↓/Enter.

### Task 24: Sidebar, panel de área y limpieza de copy

**Files:** Modify `components/Sidebar.tsx`, `components/SidePanel.tsx`, `components/Topbar.tsx`, `workspace.css`

- [ ] Renombrar inline, editor de reglas inline, lista de generados del área, quitar párrafos redundantes, `window.prompt` eliminado.

### Task 25: Responsive, accesibilidad, movimiento

**Files:** Modify `workspace.css`, `page.tsx`, `components/*`

- [ ] Breakpoints 900/600, `100dvh`, sidebar superpuesta en móvil, `:focus-visible`, `prefers-reduced-motion`, `:active` scale 0.97. `npm run build` OK.

## Fase F — Verificación

### Task 26: Verificación integral

- [ ] Node + Python suites verdes; `tsc`, `eslint`, `next build` OK.
- [ ] Levantar API + web, verificación en navegador (escritorio y 390 px): chat en streaming con mock o modelo real, generar Word/Excel/PowerPoint, vista previa, adjuntos, selector de modelos.
- [ ] Revisión final del diff (requesting-code-review) y corrección de hallazgos.
- [ ] Resumen al usuario con evidencia.
