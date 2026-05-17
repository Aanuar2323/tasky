# Referencia: Generación y Edición de Archivos (XLSX, DOCX, PPTX, PNG)

## Resumen

Esta funcionalidad integrada permite a la IA generar y editar archivos a través del chat, devolviendo directamente al usuario enlaces de descarga y ofreciendo guardarlos en el historial permanente del área.

## Arquitectura

El flujo funciona a través del intercambio del metadato especial `TASK_APP_META`:

1. El usuario pide la generación o edición de un archivo.
2. La IA construye el JSON completo con la estructura (según reglas descritas abajo).
3. La IA responde con un `TASK_APP_META` que incluye la clave `fileGenerated`.
4. El backend (`POST /api/projects/:id/chat`) detecta este campo y delega en el generador (`generators/index.js`).
5. Se crea el archivo físico temporal en `files/generated/`.
6. El frontend detecta la presencia del objeto `file` en la respuesta de la IA.
7. Se muestra un botón de descarga y un *prompt* "¿Desea agregar a historial?".
8. Si se confirma, el archivo se almacena de forma persistente en `history/areas/{areaId}/files/`.

---

## API Reference

### `POST /api/projects/:id/generate`
Genera o edita un archivo. Es invocado internamente por `/chat` o directamente.
- **Body**: `{ type: "xlsx|docx|pptx|png", data?: Object, editPath?: string, editChanges?: Object, areaId, chatId, filename? }`
- **Response**: `{ ok: true, file: { path, filename, type } }`

### `POST /api/projects/:id/add-to-history`
Mueve un archivo generado al historial de un área específica.
- **Body**: `{ filePath: string, areaId: string, filename?: string }`
- **Response**: `{ ok: true, historyPath: string }`

### `GET /api/projects/:id/generated-history`
Lista archivos dentro del historial de un área.
- **Query**: `?areaId=<id>`
- **Response**: `{ entries: [{ name, type, path }] }`

---

## Estructuras JSON para la IA (Referencia)

Para que el backend genere correctamente los archivos, la IA debe emitir la estructura correspondiente en el objeto `fileGenerated`.

### XLSX
```json
{
  "sheets": [
    {
      "name": "Hoja1",
      "columns": [{ "header": "ColA", "key": "a", "width": 15 }],
      "rows": [{ "a": "Valor" }],
      "styles": { "headerBold": true, "headerBgColor": "FF0D95A1" }
    }
  ]
}
```

### DOCX
```json
{
  "title": "Documento",
  "sections": [
    { "type": "heading", "text": "Título", "level": 1 },
    { "type": "paragraph", "text": "Cuerpo del documento..." },
    { "type": "table", "rows": [["Col1", "Col2"], ["Val1", "Val2"]] }
  ]
}
```

### PPTX
```json
{
  "title": "Presentación",
  "slides": [
    { "type": "title", "title": "Diapositiva Principal", "subtitle": "Subtítulo" },
    { "type": "bullets", "title": "Puntos clave", "bullets": ["Punto 1", "Punto 2"] }
  ]
}
```

### PNG (Gráfico - chart)
```json
{
  "type": "chart",
  "chartType": "bar",
  "title": "Gráfico Mensual",
  "labels": ["Ene", "Feb"],
  "datasets": [
    { "label": "Datos", "data": [10, 20], "color": "#0D95A1" }
  ]
}
```

### PNG (Edición de imagen)
```json
{
  "resize": { "width": 800, "height": 600 },
  "addText": [
    { "text": "Marca de agua", "x": 10, "y": 10, "fontSize": 20, "color": "#FFFFFF" }
  ]
}
```

---

## Archivos y Dependencias Implementadas

- **Generadores (`apps/api/src/generators/`)**: 
  - `index.js`: Enrutador.
  - `xlsx.js`: Usando `exceljs`.
  - `docx.js`: Usando `docx`.
  - `pptx.js`: Usando `pptxgenjs`.
  - `png.js`: Usando `canvas` (para dibujar desde cero) y `sharp` (para edición/procesamiento).
- **Rutas y Lógica**: Implementadas en `apps/api/src/index.js` y persistencia en `storage.js`.
- **UI (Frontend)**: Tab de "Archivos generados" en `HistoryView.tsx` y visualización/prompt en `Chat.tsx`.
- **Estilos (`index.css`)**: Definidos como clases `.file-download-card`, `.history-prompt`, etc.

## Limitaciones conocidas

- Las funciones `readDocxStructure` y `readPptxStructure` solo devuelven los metadatos básicos del archivo, ya que extraer texto enriquecido requiere herramientas más pesadas no integradas actualmente.
- El almacenamiento temporal en `files/generated/` no se autolimpia si los archivos no se pasan al historial; requiere depuración manual o cron job.
- El estado visual `historyAdded` y `historyDenied` en el `Chat.tsx` es efímero; se reinicia si el componente se desmonta.
