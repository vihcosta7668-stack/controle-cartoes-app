// Funções utilitárias puras (rodam no navegador e no Node).

export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const cents = (v) => Math.round(Number(v) * 100);

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const brl = (v) => BRL.format(round2(v || 0));
export const num = (v) => round2(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "1.118,41" | "- 165,70" | "34.99" | "-12.5" -> number
export function parseValor(txt) {
  if (typeof txt === 'number') return txt;
  let s = String(txt || '').trim().replace(/\s+/g, '').replace(/^R\$/i, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}

// ---------- datas (sempre strings AAAA-MM-DD, sem fuso) ----------
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export function hoje() {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
export function partes(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}
export const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addMeses(iso, n, diaFixo) {
  const { y, m, d } = partes(iso);
  const t = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  const dia = Math.min(diaFixo || d, diasNoMes(ny, nm));
  return ymd(ny, nm, dia);
}
export function addDias(iso, n) {
  const { y, m, d } = partes(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export function difDias(a, b) { // b - a
  const pa = partes(a), pb = partes(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}
export function difMeses(a, b) { // meses de a até b (pelo mês/ano)
  const pa = partes(a), pb = partes(b);
  return (pb.y * 12 + pb.m) - (pa.y * 12 + pa.m);
}
export const mesRef = (iso) => iso.slice(0, 7);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const mesCurto = (iso) => { const { y, m } = partes(iso); return `${MESES[m - 1]}/${String(y).slice(2)}`; };
export const dataBR = (iso) => { if (!iso) return ''; const { y, m, d } = partes(iso); return `${pad(d)}/${pad(m)}/${y}`; };
export const diaMes = (iso) => { if (!iso) return ''; const { m, d } = partes(iso); return `${pad(d)}/${pad(m)}`; };

// ---------- texto ----------
export function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
export function normDesc(s) {
  return semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Detecta parcela no fim da descrição: "Parcela 2/12", "- 2/2", "MOD 06/12"
export function detectaParcela(desc) {
  const m = String(desc || '').match(/(?:parcela\s*)?(\d{1,2})\s*\/\s*(\d{1,2})\s*$/i);
  if (!m) return null;
  const n = Number(m[1]), total = Number(m[2]);
  if (total < 2 || n < 1 || n > total || total > 48) return null;
  return { n, total };
}
// Descrição sem o sufixo de parcela (para ligar parcelas da mesma compra)
export function raizDesc(desc) {
  return normDesc(String(desc || '')
    .replace(/\s*-?\s*parcela\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/i, '')
    .replace(/\s*-?\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, ''));
}

export function uid(prefix = 'id') {
  const r = (globalThis.crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 14);
  return `${prefix}_${r}`;
}

export function slug(s) {
  return normDesc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}
