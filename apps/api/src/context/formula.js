/**
 * context/formula.js — Evaluador acotado de fórmulas de Excel para vistas previas.
 *
 * openpyxl guarda fórmulas sin valor calculado, así que una vista previa mostraría
 * "=SUM(B2:B5)" en lugar del total. Este evaluador cubre lo que usan los archivos
 * generados: aritmética, referencias de la misma hoja, rangos y funciones de
 * agregación. Ante cualquier otra cosa devuelve null y el llamador muestra la fórmula.
 */

const FUNCS = {
  SUM: (vals) => vals.reduce((a, b) => a + b, 0),
  AVERAGE: (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null),
  MIN: (vals) => (vals.length ? Math.min(...vals) : 0),
  MAX: (vals) => (vals.length ? Math.max(...vals) : 0),
  COUNT: (vals) => vals.length,
};

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?(?:E[+-]?\d+)?%?)|(\$?[A-Z]{1,3}\$?\d+)|([A-Z][A-Z0-9.]*)\s*\(|([-+*/^(),;:]))/iy;

function tokenize(src) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) return null;
    pos = TOKEN_RE.lastIndex;
    if (m[1]) {
      const pct = m[1].endsWith('%');
      const n = Number(pct ? m[1].slice(0, -1) : m[1]);
      tokens.push({ t: 'num', v: pct ? n / 100 : n });
    } else if (m[2]) tokens.push({ t: 'ref', v: m[2].replace(/\$/g, '').toUpperCase() });
    else if (m[3]) tokens.push({ t: 'fn', v: m[3].toUpperCase() });
    else tokens.push({ t: 'op', v: m[4] === ';' ? ',' : m[4] });
  }
  return tokens;
}

function splitRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

function colName(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function expandRange(a, b) {
  const p = splitRef(a);
  const q = splitRef(b);
  const refs = [];
  for (let r = Math.min(p.row, q.row); r <= Math.max(p.row, q.row); r += 1) {
    for (let c = Math.min(p.col, q.col); c <= Math.max(p.col, q.col); c += 1) refs.push(`${colName(c)}${r}`);
    if (refs.length > 100_000) throw new Error('rango demasiado grande');
  }
  return refs;
}

/**
 * @param {string} formula  sin el "=" inicial
 * @param {(ref: string) => number | string | null | undefined} lookup
 *        número, texto, o null/undefined si la celda está vacía
 * @returns {number | null}
 */
export function evaluateFormula(formula, lookup) {
  if (typeof formula !== 'string' || formula.includes('!') || formula.includes('"')) return null;
  const tokens = tokenize(formula.replace(/^=/, ''));
  if (!tokens?.length) return null;
  let i = 0;
  const peek = () => tokens[i];
  const take = (v) => {
    const tok = tokens[i];
    if (!tok || (v !== undefined && tok.v !== v)) throw new Error('sintaxis');
    i += 1;
    return tok;
  };
  const scalar = (ref) => {
    const v = lookup(ref);
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v !== 'number') throw new Error('texto en aritmética');
    return v;
  };

  function args() {
    const out = [];
    if (peek()?.v === ')') return out;
    for (;;) {
      const tok = peek();
      if (tok?.t === 'ref' && tokens[i + 1]?.v === ':') {
        const a = take().v;
        take(':');
        const b = take().v;
        for (const ref of expandRange(a, b)) {
          const v = lookup(ref);
          if (typeof v === 'number') out.push(v);
        }
      } else {
        out.push(expr());
      }
      if (peek()?.v !== ',') break;
      take(',');
    }
    return out;
  }

  function primary() {
    const tok = take();
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'ref') return scalar(tok.v);
    if (tok.t === 'fn') {
      const vals = args();
      take(')');
      if (tok.v === 'ROUND') {
        if (vals.length < 1 || vals.length > 2) throw new Error('ROUND');
        const f = 10 ** (vals[1] ?? 0);
        return Math.sign(vals[0]) * Math.round(Math.abs(vals[0]) * f) / f;
      }
      if (tok.v === 'ABS' && vals.length === 1) return Math.abs(vals[0]);
      const fn = FUNCS[tok.v];
      if (!fn) throw new Error(`función ${tok.v}`);
      const r = fn(vals);
      if (r === null) throw new Error('sin valores');
      return r;
    }
    if (tok.v === '(') {
      const v = expr();
      take(')');
      return v;
    }
    throw new Error('sintaxis');
  }

  function unary() {
    if (peek()?.v === '-') {
      take();
      return -unary();
    }
    if (peek()?.v === '+') {
      take();
      return unary();
    }
    return primary();
  }

  function power() {
    const base = unary();
    if (peek()?.v === '^') {
      take();
      return base ** power();
    }
    return base;
  }

  function term() {
    let v = power();
    while (peek()?.v === '*' || peek()?.v === '/') {
      const op = take().v;
      const rhs = power();
      if (op === '/' && rhs === 0) throw new Error('#DIV/0!');
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  }

  function expr() {
    let v = term();
    while (peek()?.v === '+' || peek()?.v === '-') {
      const op = take().v;
      const rhs = term();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  try {
    const v = expr();
    if (i !== tokens.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}
