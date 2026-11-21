/**
 * context/retrieval.js — Recuperación de fragmentos relevantes (BM25).
 *
 * Los archivos del área y los adjuntos del chat se parten en fragmentos
 * (~1.200 caracteres, respetando párrafos) y se puntúan contra los últimos
 * mensajes del usuario. Tokenización sin tildes, con stopwords ES/EN y un
 * stemming mínimo de plurales para que "vacaciones" encuentre "vacación".
 */

const STOPWORDS = new Set([
  // español
  'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por', 'un', 'para', 'con', 'no', 'una', 'su',
  'al', 'lo', 'como', 'mas', 'pero', 'sus', 'le', 'ya', 'o', 'u', 'este', 'si', 'porque', 'esta', 'entre', 'cuando',
  'muy', 'sin', 'sobre', 'tambien', 'me', 'hasta', 'hay', 'donde', 'quien', 'desde', 'todo', 'nos', 'durante',
  'todos', 'uno', 'les', 'ni', 'contra', 'otros', 'ese', 'eso', 'ante', 'ellos', 'e', 'esto', 'mi', 'antes',
  'algunos', 'unos', 'yo', 'otro', 'otras', 'otra', 'tanto', 'esa', 'estos', 'mucho', 'quienes', 'nada', 'muchos',
  'cual', 'cuales', 'poco', 'ella', 'estar', 'estas', 'algunas', 'algo', 'nosotros', 'mis', 'tu', 'te', 'ti', 'tus',
  'ellas', 'os', 'esos', 'esas', 'es', 'son', 'ser', 'fue', 'era', 'sera', 'favor', 'hola', 'gracias', 'dame',
  'dime', 'podes', 'puedes', 'quiero', 'queres', 'quieres', 'sobre',
  // inglés
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'by', 'at',
  'as', 'it', 'this', 'that', 'from', 'i', 'you', 'my', 'we', 'our', 'your', 'what', 'how', 'can', 'do', 'does',
]);

function stem(t) {
  if (t.length <= 3 || /\d/.test(t)) return t;
  if (t.endsWith('ciones') || t.endsWith('iones')) return t.slice(0, -2);
  if (t.endsWith('es') && t.length > 4 && /[lrndzj]$/.test(t.slice(0, -2))) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Tokens normalizados (sin tildes, sin stopwords, con stemming de plurales). */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

function overlapTail(text, n) {
  if (!n || text.length <= n) return '';
  const t = text.slice(-n);
  const i = t.indexOf(' ');
  return i > 0 ? t.slice(i + 1) : t;
}

/**
 * Parte texto en fragmentos de hasta `size` caracteres (más solapamiento).
 * @returns {Array<{index:number, text:string}>}
 */
export function chunkText(text, { size = 1200, overlap = 150 } = {}) {
  const clean = String(text ?? '').replace(/\r/g, '').trim();
  if (!clean) return [];
  const pieces = [];
  for (const para of clean.split(/\n{2,}/)) {
    if (para.length <= size) {
      pieces.push(para);
      continue;
    }
    const sentences = para.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [para];
    let cur = '';
    for (const s of sentences) {
      if (s.length > size) {
        if (cur) pieces.push(cur);
        cur = '';
        for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size));
        continue;
      }
      if (cur && (cur + s).length > size) {
        pieces.push(cur);
        cur = s;
      } else {
        cur += s;
      }
    }
    if (cur) pieces.push(cur);
  }

  const chunks = [];
  let cur = '';
  for (const piece of pieces) {
    const joined = cur ? `${cur}\n\n${piece}` : piece;
    if (cur && joined.length > size) {
      chunks.push({ index: chunks.length, text: cur.trim() });
      const tail = overlapTail(cur, overlap);
      cur = tail ? `${tail}\n\n${piece}` : piece;
    } else {
      cur = joined;
    }
  }
  if (cur.trim()) chunks.push({ index: chunks.length, text: cur.trim() });
  return chunks;
}

/**
 * @param {Array<{id:string, path:string, text:string, boost?:number}>} docs
 * @param {{chunkSize?:number, overlap?:number}} [opts]
 */
export function buildIndex(docs, { chunkSize = 1200, overlap = 150 } = {}) {
  const chunks = [];
  const df = new Map();
  for (const doc of docs) {
    const nameTokens = new Set(tokenize(doc.path));
    for (const ch of chunkText(doc.text, { size: chunkSize, overlap })) {
      const tokens = tokenize(ch.text);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      chunks.push({ docId: doc.id, path: doc.path, chunkIndex: ch.index, text: ch.text, tf, length: tokens.length, nameTokens, boost: doc.boost ?? 1 });
    }
  }
  const avgdl = chunks.length ? chunks.reduce((a, c) => a + c.length, 0) / chunks.length : 0;
  return { chunks, df, avgdl, n: chunks.length };
}

/**
 * Fragmentos más relevantes para la consulta.
 * @returns {Array<{docId:string, path:string, chunkIndex:number, score:number, text:string}>}
 */
export function search(index, query, { limit = 8, perDocLimit = 3, filenameBoost = 1.5, k1 = 1.2, b = 0.75 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.n) return [];
  const idf = new Map(terms.map((t) => {
    const d = index.df.get(t) ?? 0;
    return [t, Math.log(1 + (index.n - d + 0.5) / (d + 0.5))];
  }));
  const scored = [];
  for (const ch of index.chunks) {
    let score = 0;
    for (const t of terms) {
      const f = ch.tf.get(t);
      if (f) {
        const norm = f * (k1 + 1) / (f + k1 * (1 - b + b * (ch.length / (index.avgdl || 1))));
        score += idf.get(t) * norm;
      }
      if (ch.nameTokens.has(t)) score += filenameBoost;
    }
    score *= ch.boost;
    if (score > 0) scored.push({ ...ch, score });
  }
  scored.sort((x, y) => y.score - x.score || x.chunkIndex - y.chunkIndex);
  const perDoc = new Map();
  const out = [];
  for (const c of scored) {
    const used = perDoc.get(c.docId) ?? 0;
    if (used >= perDocLimit) continue;
    perDoc.set(c.docId, used + 1);
    out.push({ docId: c.docId, path: c.path, chunkIndex: c.chunkIndex, score: Number(c.score.toFixed(4)), text: c.text });
    if (out.length >= limit) break;
  }
  return out;
}
