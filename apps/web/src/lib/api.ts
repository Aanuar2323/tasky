/**
 * api.ts — Cliente HTTP para comunicarse con el backend
 *
 * Este módulo centraliza todas las peticiones HTTP que el frontend
 * hace al servidor Express. Proporciona una función por cada método
 * REST usado (GET, POST, PUT, DELETE), con manejo básico de errores.
 *
 * Todas las funciones:
 *  - Aceptan una URL relativa (ej: /api/projects)
 *  - Aceptan un body (en POST, PUT, DELETE)
 *  - Devuelven la respuesta parseada como JSON del tipo genérico T
 *  - Lanzan un Error si la respuesta no es ok (status >= 400)
 */

/* ==========================================================
   Tipos compartidos
   ========================================================== */

/** Entrada del explorador de archivos (carpeta o archivo) */
export type DirEntry = {
  name: string;   // Nombre visible del archivo/carpeta
  type: 'dir' | 'file';  // Si es directorio o archivo
  path: string;   // Ruta relativa dentro del proyecto
};

/* ==========================================================
   Funciones de petición HTTP
   ========================================================== */

/**
 * Realiza una petición GET al backend.
 * Se usa para obtener datos sin modificar nada (leer recursos).
 *
 * @param url - Ruta relativa de la API (ej: /api/projects/abc/tree?path=tasks)
 * @returns Promesa con la respuesta parseada como tipo T
 *
 * Uso típico: obtener lista de proyectos, leer archivos, listar carpetas, etc.
 */
export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * Realiza una petición POST al backend.
 * Se usa para crear nuevos recursos o enviar datos que generan una acción.
 *
 * @param url  - Ruta relativa de la API
 * @param body - Objeto a enviar como JSON en el cuerpo de la petición
 * @returns Promesa con la respuesta parseada como tipo T
 *
 * Uso típico: crear proyecto, crear tarea, enviar mensaje al chat, completar tarea
 */
export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * Realiza una petición PUT al backend.
 * Se usa para actualizar recursos existentes de forma completa.
 *
 * @param url  - Ruta relativa de la API
 * @param body - Objeto con los datos actualizados
 * @returns Promesa con la respuesta parseada como tipo T
 *
 * Uso típico: actualizar áreas, actualizar reglas
 */
export async function apiPut<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * Realiza una petición DELETE al backend.
 * Se usa para eliminar recursos existentes.
 *
 * @param url  - Ruta relativa de la API
 * @param body - Objeto con datos necesarios para la eliminación (ej: path del archivo)
 * @returns Promesa con la respuesta parseada como tipo T
 *
 * Uso típico: eliminar archivos dentro del proyecto
 */
export async function apiDelete<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
