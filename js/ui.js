// Helpers de interface: escape, ícones, modal, toast, gráfico.
import { brl, mesCurto } from './util.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const P = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.6c2.6.2 4.4 2 5 5.4"/>',
  group: '<path d="M4 18V9l8-5 8 5v9"/><path d="M9 18v-5h6v5"/><path d="M2 18h20"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chat: '<path d="M4 19.5 5.3 16A8 8 0 1 1 8 18.7z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
};
export const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

let toastT;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

// Modal simples. Retorna o elemento; fecha com fecharModal().
export function abrirModal(html, { largo = false, aoMontar } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-bg" data-fechar-bg><div class="modal ${largo ? 'largo' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = root.firstElementChild;
  bg.addEventListener('click', (e) => { if (e.target === bg) fecharModal(); });
  const m = bg.firstElementChild;
  aoMontar && aoMontar(m);
  const foco = m.querySelector('[autofocus], input, select, textarea, button');
  foco && setTimeout(() => foco.focus(), 30);
  return m;
}
export function fecharModal() { document.getElementById('modal-root').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });

export const cabecalhoModal = (titulo) => `<div class="modal-h"><h2>${esc(titulo)}</h2><button class="btn ghost icone" data-act="fechar-modal" aria-label="Fechar">${icon('x')}</button></div>`;

export function chipCartao(c) {
  if (!c) return '';
  return `<span class="chip"><i style="background:${esc(c.cor || 'var(--ink-3)')}"></i>${esc(c.nome)}</span>`;
}

// Barras empilhadas (minha parte x dos outros) por mês, com dica ao passar/tocar.
export function graficoBarras(meses, { altura = 200, largura = 640 } = {}) {
  if (!meses.length) return '<div class="vazio">Sem dados.</div>';
  const W = largura, H = Math.round(altura * (largura < 500 ? 0.9 : 1)), padL = 44, padB = 24, padT = 8;
  const max = Math.max(...meses.map((m) => m.total), 1);
  const passo = niceStep(max / 4);
  const topo = Math.ceil(max / passo) * passo;
  const larg = (W - padL) / meses.length;
  const bw = Math.min(34, larg * 0.62);
  const y = (v) => padT + (H - padT - padB) * (1 - v / topo);
  let grade = '';
  for (let v = 0; v <= topo + 0.001; v += passo) {
    grade += `<line class="grade" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="eixo" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? (v / 1000).toLocaleString('pt-BR') + 'k' : v}</text>`;
  }
  let barras = '';
  meses.forEach((m, i) => {
    const cx = padL + larg * i + larg / 2;
    const x = cx - bw / 2;
    const yM = y(m.minha), yT = y(m.total);
    const hM = Math.max(0, y(0) - yM), hO = Math.max(0, yM - yT - (m.outros > 0 && m.minha > 0 ? 2 : 0));
    const dica = `<b>${esc(m.rotulo || mesCurto(m.mes + '-01'))}</b>Total ${brl(m.total)}<br>Minha parte ${brl(m.minha)}<br>Dos outros ${brl(m.outros)}`;
    barras += `<rect class="alvo" x="${padL + larg * i}" y="${padT}" width="${larg}" height="${H - padT}" data-dica="${esc(dica)}" data-x="${cx}" data-y="${yT}"/>`;
    barras += `<g pointer-events="none">`;
    if (hM > 0) barras += `<path d="${barraPath(x, yM, bw, hM, m.outros <= 0)}" fill="var(--s-minha)"/>`;
    if (hO > 0) barras += `<path d="${barraPath(x, yT, bw, hO, true)}" fill="var(--s-outros)"/>`;
    const pula = larg < 40 ? Math.ceil(40 / larg) : 1; // rótulos não se sobrepõem em tela estreita
    barras += `</g>${i % pula === 0 ? `<text class="eixo" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(m.rotulo || mesCurto(m.mes + '-01'))}</text>` : ''}`;
  });
  return `<div class="grafico" data-grafico><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de barras por mês: minha parte e dos outros">${grade}${barras}</svg><div class="dica"></div></div>`;
}
function barraPath(x, y, w, h, arredonda) {
  const r = arredonda ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function niceStep(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
export function ligarGraficos(root) {
  root.querySelectorAll('[data-grafico]').forEach((g) => {
    const dica = g.querySelector('.dica'); const svg = g.querySelector('svg');
    const mostrar = (alvo) => {
      const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
      const sx = r.width / vb.width;
      dica.innerHTML = alvo.dataset.dica;
      const x = Number(alvo.dataset.x) * sx;
      dica.style.left = Math.min(Math.max(x, 70), r.width - 70) + 'px';
      dica.style.top = (Number(alvo.dataset.y) * sx - 6) + 'px';
      dica.classList.add('on');
    };
    g.querySelectorAll('.alvo').forEach((a) => {
      a.addEventListener('mouseenter', () => mostrar(a));
      a.addEventListener('click', () => mostrar(a));
      a.addEventListener('mouseleave', () => dica.classList.remove('on'));
    });
  });
}
