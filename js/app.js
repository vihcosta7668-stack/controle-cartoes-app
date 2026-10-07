import { Store, ErroConflito } from './store.js';
import {
  hoje as hojeISO, brl, num, dataBR, diaMes, mesCurto, difDias, addMeses, round2, cents, parseValor,
  detectaParcela, raizDesc, uid, slug,
} from './util.js';
import * as C from './calc.js';
import { parseNubankCSV, parseItauPages, lerPaginasPDF } from './parsers.js';
import { importarFatura } from './importer.js';
import { esc, icon, toast, abrirModal, fecharModal, cabecalhoModal, chipCartao, graficoBarras, ligarGraficos } from './ui.js';

const EU = C.EU;
const S = {
  store: new Store(), dados: null, view: 'resumo', hoje: hojeISO(),
  fat: { cartao: null, venc: null, filtro: 'todos' }, abertos: new Set(), verPagos: new Set(), grupoSel: null,
  sync: 'ok', timer: null, msgSalvar: '', ocultoEm: null,
};
const app = document.getElementById('app');

// ======================= inicialização =======================
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) S.ocultoEm = Date.now();
  else if (S.ocultoEm && Date.now() - S.ocultoEm > 10 * 60 * 1000 && S.store.desbloqueado) { S.store.bloquear(); S.dados = null; fecharModal(); telaPin(); }
  else if (S.dados) { const h = hojeISO(); if (h !== S.hoje) { S.hoje = h; render(); } }
});
window.addEventListener('online', () => { if (S.sync === 'pendente') salvarAgora(); });

if (!S.store.configurado) telaConfig(); else telaPin();

function dadosVazios() {
  return {
    versao: 1, atualizadoEm: new Date().toISOString(),
    pessoas: [{ id: EU, nome: 'Eu', telefone: '' }],
    cartoes: [
      { id: 'nubank', nome: 'Nubank', fechamento: 11, vencimento: 18, cor: '#820ad1', pix: { chave: '', tipo: 'aleatoria', nome: '', cidade: '', banco: 'Nubank' } },
      { id: 'itau', nome: 'Itaú', fechamento: 29, vencimento: 5, cor: '#ec7000', pix: { chave: '', tipo: 'aleatoria', nome: '', cidade: '', banco: 'Itaú' } },
    ],
    regras: [], faturas: [], lancamentos: [], grupos: [], cobrancas: [], config: { diasAntesCobranca: 2 },
  };
}

// ======================= acesso =======================
function telaConfig(erro = '') {
  app.innerHTML = `<div class="acesso pilha">
    <div class="logo">${icon('card')}</div>
    <h1>Conectar ao seu repositório de dados</h1>
    <p>O app guarda tudo num arquivo <b>dados.json</b> dentro de um repositório <b>privado</b> do seu GitHub. Este aparelho só guarda o acesso, cifrado com o seu PIN.</p>
    <ol class="passos">
      <li>Crie (ou use) o repositório privado de dados, ex.: <code>controle-cartoes-dados</code>.</li>
      <li>Gere um token em <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub → Fine-grained token</a>: <i>Only select repositories</i> → só o repositório de dados; <i>Permissions → Contents: Read and write</i>.</li>
      <li>Cole abaixo e escolha um PIN (mín. 6 dígitos/letras) para abrir o app neste aparelho.</li>
    </ol>
    <form class="form card" id="f-config" autocomplete="off">
      <div class="lado">
        <label class="campo"><span>Usuário do GitHub</span><input class="inp" name="owner" required autocapitalize="off" spellcheck="false"></label>
        <label class="campo"><span>Repositório (privado)</span><input class="inp" name="repo" required value="controle-cartoes-dados" autocapitalize="off" spellcheck="false"></label>
      </div>
      <label class="campo"><span>Token (github_pat_…)</span><input class="inp" name="token" type="password" required autocapitalize="off" spellcheck="false"></label>
      <div class="lado">
        <label class="campo"><span>PIN deste aparelho</span><input class="inp" name="pin" type="password" inputmode="numeric" minlength="6" required></label>
        <label class="campo"><span>Repita o PIN</span><input class="inp" name="pin2" type="password" inputmode="numeric" minlength="6" required></label>
      </div>
      <details class="small"><summary class="muted">Avançado</summary>
        <div class="lado" style="margin-top:10px">
          <label class="campo"><span>Branch</span><input class="inp" name="branch" value="main"></label>
          <label class="campo"><span>Arquivo</span><input class="inp" name="path" value="dados.json"></label>
        </div>
      </details>
      ${erro ? `<div class="erro-txt">${esc(erro)}</div>` : ''}
      <button class="btn pri" type="submit">Conectar</button>
    </form>
  </div>`;
  document.getElementById('f-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.pin !== f.pin2) return telaConfig('Os PINs não são iguais.');
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Conectando…';
    try { await S.store.configurar(f); await carregarDados(); } catch (err) { S.store.sair(); telaConfig(err.message); }
  });
}

function telaPin(erro = '') {
  const cfg = S.store.cfg || {};
  app.innerHTML = `<div class="acesso pilha">
    <div class="logo">${icon('lock')}</div>
    <h1>Controle de Cartões</h1>
    <p class="small muted">Dados em ${esc(cfg.owner)}/${esc(cfg.repo)}</p>
    <form class="form card" id="f-pin" autocomplete="off">
      <label class="campo"><span>PIN</span><input class="inp" name="pin" type="password" inputmode="numeric" autofocus required></label>
      ${erro ? `<div class="erro-txt">${esc(erro)}</div>` : ''}
      <button class="btn pri" type="submit">Abrir</button>
    </form>
    <button class="btn ghost small" id="b-esqueci">Esqueci o PIN (desconectar este aparelho)</button>
  </div>`;
  const f = document.getElementById('f-pin');
  setTimeout(() => f.pin.focus(), 50);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Abrindo…';
    try { await S.store.desbloquear(f.pin.value); await carregarDados(); } catch (err) { telaPin(err.message); }
  });
  document.getElementById('b-esqueci').addEventListener('click', () => {
    if (confirm('Isso apaga o acesso salvo neste aparelho (os dados no GitHub não são afetados). Continuar?')) { S.store.sair(); telaConfig(); }
  });
}

async function carregarDados() {
  app.innerHTML = '<div class="boot">Buscando seus dados…</div>';
  const cache = await S.store.lerCache();
  if (cache?.pendente) { // alterações feitas offline ainda não enviadas
    S.dados = cache.dados; S.store.sha = cache.sha; S.sync = 'pendente';
    render(); salvarAgora();
    return;
  }
  try {
    const { dados } = await S.store.carregar();
    if (!dados) {
      S.dados = dadosVazios(); render();
      abrirModal(`${cabecalhoModal('Primeiro acesso')}<p>Não encontrei <b>${esc(S.store.cfg.path)}</b> no repositório. Vou criar um arquivo novo, vazio, com Nubank e Itaú já cadastrados.</p>
        <p class="small muted">Se você tem o dados.json inicial que veio com o app, suba ele no repositório antes e toque em Recarregar.</p>
        <div class="modal-f"><button class="btn" data-act="recarregar">Recarregar</button><button class="btn pri" data-act="criar-dados">Criar arquivo</button></div>`);
      return;
    }
    S.dados = migrar(dados); S.sync = 'ok';
  } catch (err) {
    if (cache?.dados) { S.dados = cache.dados; S.sync = 'erro'; toast('Sem conexão com o GitHub — mostrando a última cópia deste aparelho.', 4000); }
    else { app.innerHTML = `<div class="acesso"><p class="erro-txt">${esc(err.message)}</p><button class="btn" data-act="recarregar-pagina">Tentar de novo</button></div>`; return; }
  }
  render();
}
function migrar(d) {
  d.cobrancas ||= []; d.grupos ||= []; d.regras ||= []; d.faturas ||= []; d.config ||= { diasAntesCobranca: 2 };
  if (!d.pessoas.some((p) => p.id === EU)) d.pessoas.unshift({ id: EU, nome: 'Eu', telefone: '' });
  return d;
}

// ======================= salvar =======================
function mutar(fn, msg) {
  const novo = structuredClone(S.dados);
  fn(novo);
  S.dados = novo; S.msgSalvar = msg || 'app: atualização';
  S.sync = 'salvando'; render();
  clearTimeout(S.timer); S.timer = setTimeout(salvarAgora, 700);
}
async function salvarAgora() {
  clearTimeout(S.timer);
  try {
    await S.store.salvar(S.dados, S.msgSalvar);
    S.sync = 'ok';
  } catch (err) {
    if (err instanceof ErroConflito) { S.sync = 'erro'; resolverConflito(); }
    else { S.sync = 'pendente'; await S.store.marcarPendente(S.dados); toast('Não consegui salvar no GitHub. Fica guardado aqui e envio quando a conexão voltar.', 4000); }
  }
  atualizarSync();
}
function resolverConflito() {
  abrirModal(`${cabecalhoModal('Dados alterados em outro aparelho')}
    <p>O arquivo no GitHub mudou depois que este aparelho abriu (provavelmente você mexeu pelo celular e pelo notebook ao mesmo tempo).</p>
    <div class="modal-f">
      <button class="btn" data-act="conflito-github">Usar os do GitHub</button>
      <button class="btn pri" data-act="conflito-local">Manter os daqui</button>
    </div>
    <p class="tiny muted">"Usar os do GitHub" descarta a última alteração feita aqui. "Manter os daqui" sobrescreve o que foi feito no outro aparelho.</p>`);
}
function atualizarSync() {
  const el = document.querySelector('.sync'); if (!el) return;
  const t = { ok: 'Salvo', salvando: 'Salvando…', pendente: 'Não enviado', erro: 'Sem sincronizar' }[S.sync];
  el.className = 'sync ' + S.sync; el.textContent = t;
}

// ======================= estrutura =======================
const NAV = [
  ['resumo', 'Resumo', 'home'], ['faturas', 'Faturas', 'card'], ['pessoas', 'Me devem', 'people'], ['grupos', 'Grupos', 'group'], ['futuro', 'Futuro', 'chart'],
];
function render() {
  if (!S.dados) return;
  const cobr = C.cobrancasDevidas(S.dados, S.hoje, S.dados.config?.diasAntesCobranca ?? 2).length;
  const views = { resumo: vResumo, faturas: vFaturas, pessoas: vPessoas, grupos: vGrupos, futuro: vFuturo, ajustes: vAjustes };
  const titulo = { resumo: 'Resumo', faturas: 'Faturas', pessoas: 'Me devem', grupos: 'Compras em grupo', futuro: 'Parcelas e próximos meses', ajustes: 'Ajustes' }[S.view];
  const navBtn = ([id, nome, ic]) => `<button data-act="nav" data-arg="${id}" ${S.view === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${nome}</span>${id === 'pessoas' && cobr ? `<span class="badge-dot">${cobr}</span>` : ''}</button>`;
  const y = window.scrollY;
  app.innerHTML = `<div class="shell">
    <nav class="navside" aria-label="Menu">
      <div class="marca"><span class="logo-mini">${icon('card')}</span>Controle de Cartões</div>
      ${NAV.map(navBtn).join('')}
      <div style="flex:1"></div>
      <button data-act="nav" data-arg="ajustes" ${S.view === 'ajustes' ? 'aria-current="page"' : ''}>${icon('gear')}<span>Ajustes</span></button>
    </nav>
    <div>
      <header class="topbar">
        <div class="titulo"><h1>${titulo}</h1><small>Hoje, ${dataBR(S.hoje)}</small></div>
        <span class="sync"></span>
        <button class="btn icone ghost so-mobile" data-act="nav" data-arg="ajustes" aria-label="Ajustes">${icon('gear')}</button>
      </header>
      <main class="pilha">${views[S.view]()}</main>
    </div>
    <nav class="nav" aria-label="Menu">${NAV.map(navBtn).join('')}</nav>
  </div>`;
  atualizarSync(); ligarGraficos(app);
  if (S.manterScroll) window.scrollTo(0, y); S.manterScroll = false;
}

const larguraGrafico = () => Math.round(Math.min(640, Math.max(320, window.innerWidth - 64)));
const cartao = (id) => C.cartaoPorId(S.dados, id);
const nome = (id) => C.nomePessoa(S.dados, id);
const pessoasOutras = () => S.dados.pessoas.filter((p) => p.id !== EU);

function quemTexto(l) {
  if (l.tipo === 'pagamento') return 'Pagamento';
  if (l.grupo) { const g = C.grupoPorId(S.dados, l.grupo); return g ? `Grupo: ${g.nome}` : 'Grupo'; }
  const d = l.divisao || [];
  if (!d.length) return '';
  const minha = C.minhaParte(S.dados, l);
  if (d.length === 1 && minha < 0.005) return nome(d[0].pessoa);
  return `Dividido: ${[minha > 0.004 ? 'eu' : null, ...d.map((x) => nome(x.pessoa))].filter(Boolean).join(', ')}`;
}
function legenda(minha, outros) {
  return `<div class="legenda"><span style="--c:var(--s-minha)">Minha parte ${brl(minha)}</span><span style="--c:var(--s-outros)">Dos outros ${brl(outros)}</span></div>`;
}
function barraMinha(minha, outros) {
  const t = minha + outros; if (t <= 0) return '<div class="barra"></div>';
  return `<div class="barra" aria-hidden="true"><span class="m" style="width:${(minha / t) * 100}%"></span><span class="o" style="width:${(outros / t) * 100}%"></span></div>`;
}
const quando = (venc) => {
  const d = difDias(S.hoje, venc);
  return d === 0 ? 'vence hoje' : d === 1 ? 'vence amanhã' : d > 0 ? `vence em ${d} dias` : `venceu há ${-d} dia${d === -1 ? '' : 's'}`;
};
function faturasEmAberto(c) { // fechadas sem pagamento completo (últimos 3 meses)
  const ab = C.faturaAberta(c, S.hoje);
  const out = [];
  for (let k = 1; k <= 3; k++) {
    const v = C.vencSeguinte(c, ab, -k);
    const r = C.resumoFatura(S.dados, c.id, v, S.hoje);
    if (r.total > 0 && r.faltaPagar > 0.009) out.push(r);
  }
  return out;
}

// ======================= RESUMO =======================
function vResumo() {
  const d = S.dados;
  if (!d.lancamentos.length) {
    return `<div class="card vazio pilha"><p>Nenhuma fatura ainda. Importe o CSV do Nubank ou o PDF do Itaú para começar.</p>
      <button class="btn pri" data-act="importar">${icon('upload')} Importar fatura</button></div>`;
  }
  const res = d.cartoes.map((c) => ({ c, r: C.resumoFatura(d, c.id, C.faturaAberta(c, S.hoje), S.hoje), abertas: faturasEmAberto(c) }));
  const pessoas = C.resumoPessoas(d, S.hoje);
  const cobr = C.cobrancasDevidas(d, S.hoje, d.config?.diasAntesCobranca ?? 2);
  const tot = res.reduce((s, x) => s + x.r.totalGeral, 0);
  const minha = res.reduce((s, x) => s + x.r.minha, 0);
  const faltaBancos = res.reduce((s, x) => s + x.r.faltaPagar + x.abertas.reduce((a, r) => a + r.faltaPagar, 0), 0);
  const receber = pessoas.reduce((s, p) => s + p.falta, 0);
  const atrasado = pessoas.reduce((s, p) => s + p.atrasado, 0);
  const meses = C.previsaoMeses(d, S.hoje, 6);
  return `
  ${cobr.length ? `<div class="alerta warn"><div class="grow"><b>${cobr.length} cobrança${cobr.length > 1 ? 's' : ''} para fazer</b><br><span class="small">${esc(cobr.map((c) => nome(c.pessoa)).slice(0, 5).join(', '))}${cobr.length > 5 ? '…' : ''}</span></div><button class="btn sm" data-act="nav" data-arg="pessoas">Ver</button></div>` : ''}
  <div class="grid g4">
    <div class="card kpi"><div class="rot">Faturas abertas</div><div class="val">${brl(tot)}</div><div class="sub">${res.map((x) => `${esc(x.c.nome)} ${brl(x.r.totalGeral)}`).join(' · ')}</div></div>
    <div class="card kpi"><div class="rot">Minha parte</div><div class="val">${brl(minha)}</div><div class="sub">dos outros ${brl(tot - minha)}</div></div>
    <div class="card kpi"><div class="rot">Falta pagar aos bancos</div><div class="val">${brl(faltaBancos)}</div><div class="sub">inclui fatura fechada sem pagamento</div></div>
    <div class="card kpi"><div class="rot">Falta receber</div><div class="val">${brl(receber)}</div><div class="sub">${atrasado > 0 ? `<span class="tag bad">${brl(atrasado)} atrasado</span>` : 'nada atrasado'}</div></div>
  </div>
  <div class="grid g2m">
    ${res.map(({ c, r, abertas }) => `
    <section class="card">
      <div class="card-h">${chipCartao(c)}<span class="small muted">fecha ${diaMes(r.fechamento)} · ${quando(r.venc)} (${diaMes(r.venc)})</span></div>
      <div class="spread"><div><div class="kpi" style="padding:0"><div class="val">${brl(r.totalGeral)}</div>
        <div class="sub">lançado ${brl(r.total)}${r.totalPrevisto > 0 ? ` · previsto ${brl(r.totalPrevisto)}` : ''}</div></div></div>
        ${conferenciaTag(r)}</div>
      <div style="margin:12px 0 8px">${barraMinha(r.minha, r.outros)}</div>${legenda(r.minha, r.outros)}
      ${abertas.map((a) => `<div class="alerta bad" style="margin-top:12px"><div class="grow small">Fatura de ${dataBR(a.venc)}: <b>${brl(a.faltaPagar)}</b> sem pagamento registrado.</div><button class="btn sm" data-act="marcar-paga" data-arg="${c.id}|${a.venc}">Já paguei</button></div>`).join('')}
      <div class="row wrap" style="margin-top:14px"><button class="btn sm" data-act="ver-fatura" data-arg="${c.id}|${r.venc}">Ver fatura</button><button class="btn sm" data-act="importar" data-arg="${c.id}">${icon('upload')} Importar</button><button class="btn sm" data-act="novo-lanc" data-arg="${c.id}">${icon('plus')} Lançar</button></div>
    </section>`).join('')}
  </div>
  <section class="card">
    <div class="card-h"><h2>Próximos 6 meses</h2>${legenda(meses.reduce((s, m) => s + m.minha, 0), meses.reduce((s, m) => s + m.outros, 0))}</div>
    ${graficoBarras(meses, { largura: larguraGrafico() })}
    <p class="tiny muted" style="margin:8px 0 0">Parcelas e gastos fixos já conhecidos, pelo mês de vencimento. Compras novas ainda não entram.</p>
  </section>
  <section class="card">
    <div class="card-h"><h2>Quem me deve</h2><button class="btn sm ghost" data-act="nav" data-arg="pessoas">Ver tudo ${icon('chev')}</button></div>
    <ul class="lista">${pessoas.filter((p) => p.falta > 0).slice(0, 6).map((p) => `
      <li class="click" data-act="abrir-pessoa" data-arg="${p.pessoa.id}"><div class="desc"><b>${esc(p.pessoa.nome)}</b><small>${p.futuro > 0 ? `+ ${brl(p.futuro)} em parcelas futuras` : 'sem parcelas futuras'}</small></div>
      ${p.atrasado > 0 ? '<span class="tag bad">atrasado</span>' : ''}<div class="valor">${brl(p.falta)}</div></li>`).join('') || '<li class="vazio">Ninguém te deve agora.</li>'}</ul>
  </section>`;
}
function conferenciaTag(r) {
  const v = r.meta?.valorInformado;
  if (r.meta?.totalDeclarado != null && Math.abs(r.meta.totalDeclarado - r.total) < 0.01) return '<span class="tag ok">confere com o PDF</span>';
  if (v == null) return r.estado === 'aberta' && r.total > 0 ? '<span class="tag">não conferida</span>' : '';
  const dif = round2(v - r.total);
  return Math.abs(dif) < 0.01 ? '<span class="tag ok">confere com o banco</span>' : `<span class="tag warn">diferença ${brl(dif)}</span>`;
}

// ======================= FATURAS =======================
function vFaturas() {
  const d = S.dados;
  if (!S.fat.cartao || !cartao(S.fat.cartao)) S.fat.cartao = d.cartoes[0].id;
  const c = cartao(S.fat.cartao);
  const vencs = C.vencimentosDoCartao(d, c.id, S.hoje, 3);
  if (!S.fat.venc || !vencs.includes(S.fat.venc)) S.fat.venc = C.faturaAberta(c, S.hoje);
  const r = C.resumoFatura(d, c.id, S.fat.venc, S.hoje);
  const ant = C.vencAnterior(c, r.venc);
  const filtro = S.fat.filtro;
  const passa = (l) => filtro === 'todos' || (filtro === 'meus' ? C.minhaParte(d, l) > 0.004 : C.minhaParte(d, l) < l.valor - 0.004);
  const lanc = r.lancadas.filter(passa).sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  const prev = r.previstas.filter(passa);
  const pagsDoArquivo = d.lancamentos.filter((l) => l.cartao === c.id && l.venc === r.venc && l.tipo === 'pagamento');
  const pagsDeOutros = r.pagamentos.filter((l) => l.venc !== r.venc);
  const estadoTag = { fechada: '<span class="tag">fechada</span>', aberta: '<span class="tag info">aberta</span>', futura: '<span class="tag">futura</span>' }[r.estado];
  const linha = (l) => {
    const minha = C.minhaParte(d, l);
    const q = quemTexto(l);
    const info = [l.data ? diaMes(l.data) : null, l.parcela ? `parcela ${l.parcela.n}/${l.parcela.total}` : null, l.fixo ? 'fixo' : null, l.origem === 'manual' ? 'lançado à mão' : null, q || null].filter(Boolean).join(' · ');
    const alvo = l.origem === 'projecao' ? l.id.split('_').slice(1, 3).join('_') : l.id;
    return `<li class="click ${l.previsto || l.origem === 'previsto' ? 'previsto' : ''}" data-act="editar-lanc" data-arg="${esc(alvo)}">
      <div class="desc"><b>${esc(l.desc)}</b><small>${esc(info)}</small></div>
      <div class="valor">${brl(l.valor)}${Math.abs(minha - l.valor) > 0.004 ? `<small>minha ${brl(minha)}</small>` : ''}</div></li>`;
  };
  return `
  <div class="row wrap">
    <div class="seg" role="group" aria-label="Cartão">${d.cartoes.map((x) => `<button data-act="fat-cartao" data-arg="${x.id}" aria-pressed="${x.id === c.id}">${esc(x.nome)}</button>`).join('')}</div>
    <select class="inp" style="width:auto;flex:1;min-width:190px" data-chg="fat-venc" aria-label="Fatura">
      ${vencs.map((v) => `<option value="${v}" ${v === r.venc ? 'selected' : ''}>Vence ${dataBR(v)}${v === C.faturaAberta(c, S.hoje) ? ' (aberta)' : ''}</option>`).join('')}
    </select>
  </div>
  <div class="row wrap"><button class="btn pri" data-act="importar" data-arg="${c.id}">${icon('upload')} Importar ${c.id === 'itau' ? 'PDF' : 'CSV'}</button><button class="btn" data-act="novo-lanc" data-arg="${c.id}">${icon('plus')} Lançar compra</button></div>
  <section class="card">
    <div class="card-h">${chipCartao(c)} ${estadoTag}<span class="small muted grow">fecha ${dataBR(r.fechamento)} · ${quando(r.venc)}</span></div>
    <div class="grid g4">
      <div><div class="tiny muted">Total ${r.totalPrevisto > 0 ? '(com previstos)' : ''}</div><div class="num" style="font-size:20px;font-weight:680">${brl(r.totalGeral)}</div></div>
      <div><div class="tiny muted">Minha parte</div><div class="num" style="font-size:20px;font-weight:680">${brl(r.minha)}</div></div>
      <div><div class="tiny muted">Pago ao banco</div><div class="num" style="font-size:20px;font-weight:680">${brl(r.pago)}</div></div>
      <div><div class="tiny muted">Falta pagar</div><div class="num" style="font-size:20px;font-weight:680">${brl(r.faltaPagar)}</div></div>
    </div>
    <div style="margin:14px 0 8px">${barraMinha(r.minha, r.outros)}</div>${legenda(r.minha, r.outros)}
    ${r.pago > (r.estado === 'fechada' ? r.total : r.totalGeral) + 0.009 ? `<div class="alerta info small" style="margin-top:12px">Pagamentos somam ${brl(r.pago - (r.estado === 'fechada' ? r.total : r.totalGeral))} a mais que os lançamentos desta fatura. Pode faltar algum lançamento ou um pagamento estar na fatura errada (veja abaixo).</div>` : ''}
    ${r.estado === 'fechada' && r.faltaPagar > 0.009 ? `<div class="alerta bad" style="margin-top:12px"><div class="grow small">Nenhum pagamento registrado cobre esta fatura.</div><button class="btn sm" data-act="marcar-paga" data-arg="${c.id}|${r.venc}">Já paguei</button></div>` : ''}
    <div class="row wrap" style="margin-top:14px;align-items:flex-end">
      <label class="campo grow" style="min-width:180px"><span>Valor desta fatura no app do banco</span><input class="inp" inputmode="decimal" placeholder="ex.: 2.075,96" data-chg="valor-informado" value="${r.meta?.valorInformado != null ? num(r.meta.valorInformado) : ''}"></label>
      <div style="padding-bottom:10px">${conferenciaTag(r) || ''}</div>
    </div>
    ${r.meta?.valorInformado != null && Math.abs(r.meta.valorInformado - r.total) >= 0.01 ? `<p class="small muted" style="margin:8px 0 0">Lançado aqui: ${brl(r.total)}. ${r.meta.valorInformado > r.total ? 'O banco mostra mais — falta importar compras recentes (exporte o CSV de novo) ou lançar alguma à mão.' : 'O banco mostra menos — algum pagamento pode ter abatido esta fatura (veja Pagamentos) ou há estorno.'}</p>` : ''}
  </section>
  ${pagsDoArquivo.length || pagsDeOutros.length ? `<section class="card">
    <div class="card-h"><h2>Pagamentos</h2><span class="tiny muted">diga de qual fatura é cada pagamento</span></div>
    <ul class="lista">${pagsDoArquivo.map((p) => `<li><div class="desc"><b>${brl(-p.valor)}</b><small>${diaMes(p.data)} · ${esc(p.desc)}</small></div>
      <select class="inp" style="width:auto" data-chg="ref-pag" data-arg="${p.id}">
        <option value="${ant}" ${(p.refVenc || p.venc) === ant ? 'selected' : ''}>Fatura anterior (${diaMes(ant)})</option>
        <option value="${r.venc}" ${(p.refVenc || p.venc) === r.venc ? 'selected' : ''}>Esta fatura (${diaMes(r.venc)})</option>
      </select>${p.origem === 'manual' ? `<button class="btn sm ghost perigo" data-act="apagar-lanc" data-arg="${p.id}" aria-label="Apagar">${icon('x')}</button>` : ''}</li>`).join('')}
      ${pagsDeOutros.map((p) => `<li><div class="desc"><b>${brl(-p.valor)}</b><small>${diaMes(p.data)} · ${esc(p.desc)} — veio na fatura de ${diaMes(p.venc)}</small></div><span class="tag ok">abate esta</span>${p.origem === 'manual' ? `<button class="btn sm ghost perigo" data-act="apagar-lanc" data-arg="${p.id}" aria-label="Apagar">${icon('x')}</button>` : ''}</li>`).join('')}
    </ul></section>` : ''}
  <section class="card">
    <div class="card-h"><h2>Lançamentos <span class="muted small">(${r.lancadas.length})</span></h2>
      <div class="seg">${[['todos', 'Todos'], ['meus', 'Meus'], ['outros', 'Dos outros']].map(([k, t]) => `<button data-act="fat-filtro" data-arg="${k}" aria-pressed="${filtro === k}">${t}</button>`).join('')}</div></div>
    <ul class="lista">${lanc.map(linha).join('') || '<li class="vazio">Nada lançado nesta fatura.</li>'}</ul>
    ${prev.length ? `<div class="sec-tit">Previsto — parcelas e fixos que devem cair</div><ul class="lista">${prev.map(linha).join('')}</ul>` : ''}
  </section>`;
}

// ======================= ME DEVEM =======================
function vPessoas() {
  const d = S.dados;
  const pessoas = C.resumoPessoas(d, S.hoje);
  const cobr = C.cobrancasDevidas(d, S.hoje, d.config?.diasAntesCobranca ?? 2);
  const tot = pessoas.reduce((s, p) => s + p.falta, 0);
  const atr = pessoas.reduce((s, p) => s + p.atrasado, 0);
  const fut = pessoas.reduce((s, p) => s + p.futuro, 0);
  const ultimaCobranca = (pid, cid) => (d.cobrancas || []).filter((x) => x.pessoa === pid && x.cartao === cid).map((x) => x.em).sort().pop();
  const sit = { atrasado: '<span class="tag bad">atrasado</span>', cobrar: '<span class="tag warn">cobrar</span>', aberto: '<span class="tag info">fatura aberta</span>', futuro: '<span class="tag">futuro</span>', pago: '<span class="tag ok">pago</span>' };
  const itemLi = (it) => {
    const c = cartao(it.cartao);
    return `<li class="${it.pago ? 'pago' : ''}"><label class="check"><input type="checkbox" data-chg="item-pago" data-arg="${esc(it.id)}" ${it.pago ? 'checked' : ''} ${it.tipo === 'grupo' && it.pago ? 'disabled' : ''} aria-label="Pago"></label>
      <div class="desc"><b>${esc(it.desc)}</b><small>${esc(c?.nome || '')} · fatura ${diaMes(it.venc)}${it.pagoParcial > 0 && !it.pago ? ` · pagou ${brl(it.pagoParcial)}` : ''}</small></div>
      ${sit[it.situacao] || ''}<div class="valor">${brl(it.pago ? it.valor : it.falta)}</div></li>`;
  };
  return `
  ${cobr.length ? `<section class="card"><div class="card-h"><h2>Cobrar agora</h2><span class="tiny muted">${d.config?.diasAntesCobranca ?? 2} dias antes do vencimento, ou atrasados</span></div>
    <ul class="lista">${cobr.map((cb) => { const u = ultimaCobranca(cb.pessoa, cb.cartao); return `<li><div class="desc"><b>${esc(nome(cb.pessoa))}</b><small>${esc(cartao(cb.cartao).nome)} · ${cb.itens.length} ite${cb.itens.length > 1 ? 'ns' : 'm'}${u ? ` · cobrado em ${diaMes(u)}` : ''}</small></div><div class="valor">${brl(cb.total)}</div><button class="btn sm pri" data-act="cobrar" data-arg="${cb.pessoa}|${cb.cartao}">${icon('chat')} Cobrar</button></li>`; }).join('')}</ul></section>` : ''}
  <div class="grid g4">
    <div class="card kpi"><div class="rot">Falta receber</div><div class="val">${brl(tot)}</div></div>
    <div class="card kpi"><div class="rot">Atrasado</div><div class="val">${brl(atr)}</div></div>
    <div class="card kpi"><div class="rot">Parcelas futuras</div><div class="val">${brl(fut)}</div><div class="sub">ainda não lançadas</div></div>
    <div class="card kpi"><div class="rot">Pessoas devendo</div><div class="val">${pessoas.filter((p) => p.falta > 0).length}</div></div>
  </div>
  <div class="row"><button class="btn" data-act="pessoa-form">${icon('plus')} Pessoa</button><span class="tiny muted grow">Toque no nome para ver as compras e marcar o que já foi pago.</span></div>
  ${pessoas.map((p) => {
    const aberto = S.abertos.has(p.pessoa.id);
    const pend = p.itens.filter((i) => !i.pago && i.situacao !== 'futuro').sort((a, b) => a.venc.localeCompare(b.venc));
    const futuros = p.itens.filter((i) => !i.pago && i.situacao === 'futuro');
    const pagos = p.itens.filter((i) => i.pago).sort((a, b) => b.venc.localeCompare(a.venc));
    const cartoesPend = [...new Set(pend.map((i) => i.cartao))];
    return `<section class="card" id="p-${p.pessoa.id}">
      <div class="spread click" data-act="toggle-pessoa" data-arg="${p.pessoa.id}" style="cursor:pointer">
        <div class="grow"><h2>${esc(p.pessoa.nome)}</h2><div class="tiny muted">${p.futuro > 0 ? `+ ${brl(p.futuro)} futuro · ` : ''}já pagou ${brl(p.pago)}${p.pessoa.telefone ? '' : ' · sem WhatsApp cadastrado'}</div></div>
        ${p.atrasado > 0 ? '<span class="tag bad">atrasado</span>' : ''}
        <div class="valor num" style="font-size:18px;font-weight:680">${brl(p.falta)}</div>
      </div>
      ${aberto ? `<div style="margin-top:10px">
        ${cartoesPend.length ? `<div class="row wrap" style="margin-bottom:6px">${cartoesPend.map((cid) => `<button class="btn sm pri" data-act="cobrar" data-arg="${p.pessoa.id}|${cid}">${icon('chat')} Cobrar ${esc(cartao(cid).nome)}</button>`).join('')}</div>` : ''}
        <ul class="lista">${pend.map(itemLi).join('') || '<li class="vazio">Nada pendente.</li>'}</ul>
        ${futuros.length ? `<div class="sec-tit">Próximas faturas</div><ul class="lista">${futuros.slice(0, 8).map(itemLi).join('')}</ul>` : ''}
        ${pagos.length ? (S.verPagos.has(p.pessoa.id) ? `<div class="sec-tit">Pagos</div><ul class="lista">${pagos.map(itemLi).join('')}</ul>` : `<button class="btn sm ghost" data-act="ver-pagos" data-arg="${p.pessoa.id}">Ver pagos (${pagos.length})</button>`) : ''}
        <div class="row" style="margin-top:8px"><button class="btn sm ghost" data-act="pessoa-form" data-arg="${p.pessoa.id}">Editar ${esc(p.pessoa.nome)}</button></div>
      </div>` : ''}
    </section>`;
  }).join('')}`;
}

// ======================= GRUPOS =======================
function vGrupos() {
  const d = S.dados;
  if (S.grupoSel && C.grupoPorId(d, S.grupoSel)) return vGrupo(C.grupoPorId(d, S.grupoSel));
  return `<div class="row"><button class="btn pri" data-act="grupo-form">${icon('plus')} Nova compra em grupo</button></div>
  <p class="small muted" style="margin:0">Para viagens e compras rachadas: o valor é dividido pelo peso de cada pessoa (ex.: diárias) e cada um vê quanto paga por fatura.</p>
  ${(d.grupos || []).map((g) => {
    const cr = C.cronogramaGrupo(d, g);
    const outros = Object.entries(cr).filter(([pid]) => pid !== EU);
    const devido = outros.reduce((s, [, x]) => s + x.devido, 0);
    const pago = outros.reduce((s, [, x]) => s + x.pago, 0);
    const total = (g.avista?.valor || 0) + (g.parcelado?.total || 0) + (g.extras || []).reduce((s, e) => s + e.valor, 0);
    const c = cartao(g.cartao);
    const ab = C.faturaAberta(c, S.hoje);
    const k = g.parcelado ? Array.from({ length: g.parcelado.parcelas }, (_, i) => C.vencSeguinte(c, g.parcelado.primeiraVenc, i)).filter((v) => v <= ab).length : 0;
    return `<section class="card click" data-act="grupo-abrir" data-arg="${g.id}" style="cursor:pointer">
      <div class="card-h"><h2>${esc(g.nome)}</h2>${chipCartao(c)}</div>
      <div class="grid g3m">
        <div><div class="tiny muted">Total da compra</div><div class="num" style="font-weight:680">${brl(total)}</div></div>
        <div><div class="tiny muted">Parcelas</div><div class="num" style="font-weight:680">${g.parcelado ? `${k}/${g.parcelado.parcelas}` : 'à vista'}</div></div>
        <div><div class="tiny muted">Recebido dos outros</div><div class="num" style="font-weight:680">${brl(pago)} <span class="muted small">de ${brl(devido)}</span></div></div>
      </div>
      <div class="barra" style="margin-top:12px"><span class="p" style="width:${devido ? (pago / devido) * 100 : 0}%"></span></div>
    </section>`;
  }).join('') || '<div class="card vazio">Nenhuma compra em grupo ainda.</div>'}`;
}
function vGrupo(g) {
  const d = S.dados; const c = cartao(g.cartao);
  const cr = C.cronogramaGrupo(d, g);
  const plano = g.parcelado ? Array.from({ length: g.parcelado.parcelas }, (_, i) => C.vencSeguinte(c, g.parcelado.primeiraVenc, i)) : [];
  const refs = [...new Set([...(g.avista ? [g.avista.venc] : []), ...plano].map((v) => v.slice(0, 7)))].sort();
  const ab = C.faturaAberta(c, S.hoje);
  const parc = g.parcelado ? g.parcelado.total / g.parcelado.parcelas : 0;
  const pagoRef = (pid, ref) => round2((g.pagamentos || []).filter((x) => x.pessoa === pid && x.ref === ref).reduce((s, x) => s + Number(x.valor), 0));
  const linhas = g.participantes.map((p) => {
    const x = cr[p.pessoa];
    const agora = round2(x.entradas.filter((e) => e.venc <= ab).reduce((s, e) => s + e.falta, 0));
    return { p, x, agora };
  });
  const tot = (f) => round2(linhas.reduce((s, l) => s + f(l), 0));
  return `
  <div class="row wrap"><button class="btn sm ghost" data-act="grupo-voltar">← Grupos</button><div class="grow"></div><button class="btn sm" data-act="grupo-form" data-arg="${g.id}">Editar</button></div>
  <section class="card">
    <div class="card-h"><h2>${esc(g.nome)}</h2>${chipCartao(c)}</div>
    <div class="grid g4">
      ${g.parcelado ? `<div><div class="tiny muted">Parcelado</div><div class="num" style="font-weight:680">${brl(g.parcelado.total)}</div><div class="tiny muted">${g.parcelado.parcelas}× ${brl(parc)} · 1ª em ${diaMes(g.parcelado.primeiraVenc)}</div></div>` : ''}
      ${g.avista?.valor ? `<div><div class="tiny muted">${esc(g.avista.desc || 'À vista')}</div><div class="num" style="font-weight:680">${brl(g.avista.valor)}</div><div class="tiny muted">fatura ${diaMes(g.avista.venc)}</div></div>` : ''}
      <div><div class="tiny muted">Total de ${esc(g.rotuloPeso || 'peso')}</div><div class="num" style="font-weight:680">${C.pesosGrupo(g).total}</div></div>
      <div><div class="tiny muted">Falta receber</div><div class="num" style="font-weight:680">${brl(tot((l) => (l.p.pessoa === EU ? 0 : l.x.falta)))}</div></div>
    </div>
    <p class="tiny muted" style="margin:10px 0 0">Na fatura, lançamentos com "${esc(g.descContem || '—')}" no ${esc(c.nome)} são ligados a este grupo automaticamente.</p>
  </section>
  <section class="card">
    <div class="card-h"><h2>Por pessoa</h2><span class="tiny muted">digite nos meses o que cada um pagou</span></div>
    <div class="tabela-wrap"><table class="t">
      <thead><tr><th>Nome</th><th class="n">${esc(g.rotuloPeso || 'Peso')}</th><th class="n">Total</th>${refs.map((r) => `<th class="n">${mesCurto(r + '-01')}</th>`).join('')}<th class="n">Pago</th><th class="n">Falta</th><th class="n">Cobrar agora</th></tr></thead>
      <tbody>${linhas.map(({ p, x, agora }) => `<tr>
        <td>${esc(nome(p.pessoa))}${p.pessoa === EU ? ' <span class="tag">eu</span>' : ''}</td><td class="n">${esc(p.peso)}</td><td class="n">${num(x.devido)}</td>
        ${refs.map((r) => p.pessoa === EU ? '<td class="n muted">—</td>' : `<td class="n"><input class="inp" inputmode="decimal" data-chg="grupo-pag" data-arg="${g.id}|${p.pessoa}|${r}" value="${pagoRef(p.pessoa, r) ? num(pagoRef(p.pessoa, r)) : ''}" aria-label="Pago por ${esc(nome(p.pessoa))} em ${mesCurto(r + '-01')}"></td>`).join('')}
        <td class="n">${p.pessoa === EU ? '—' : num(x.pago)}</td><td class="n">${p.pessoa === EU ? '—' : num(x.falta)}</td>
        <td class="n">${p.pessoa !== EU && agora > 0 ? `<span class="tag ${x.entradas.some((e) => e.falta > 0 && e.venc < S.hoje) ? 'bad' : 'warn'}">${num(agora)}</span>` : (p.pessoa === EU ? '' : '<span class="tag ok">em dia</span>')}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="n">${C.pesosGrupo(g).total}</td><td class="n">${num(tot((l) => l.x.devido))}</td>${refs.map((r) => `<td class="n">${num(linhas.reduce((s, l) => s + pagoRef(l.p.pessoa, r), 0))}</td>`).join('')}<td class="n">${num(tot((l) => (l.p.pessoa === EU ? 0 : l.x.pago)))}</td><td class="n">${num(tot((l) => (l.p.pessoa === EU ? 0 : l.x.falta)))}</td><td></td></tr></tfoot>
    </table></div>
    <p class="tiny muted" style="margin:10px 0 0">"Cobrar agora" = o que já venceu ou vence nesta fatura menos o que a pessoa já pagou. Pagou a mais num mês? O excedente abate as próximas parcelas.</p>
  </section>`;
}

// ======================= FUTURO =======================
function vFuturo() {
  const d = S.dados;
  const meses = C.previsaoMeses(d, S.hoje, 12);
  const parc = C.parcelamentos(d, S.hoje);
  const fixos = C.gastosFixos(d, S.hoje);
  const totParc = parc.reduce((s, p) => s + p.restante, 0);
  return `
  <section class="card">
    <div class="card-h"><h2>Próximos 12 meses</h2>${legenda(meses.reduce((s, m) => s + m.minha, 0), meses.reduce((s, m) => s + m.outros, 0))}</div>
    ${graficoBarras(meses, { altura: 220, largura: larguraGrafico() })}
    <div class="tabela-wrap" style="margin-top:12px"><table class="t">
      <thead><tr><th>Mês</th>${d.cartoes.map((c) => `<th class="n">${esc(c.nome)}</th>`).join('')}<th class="n">Total</th><th class="n">Minha parte</th><th class="n">Dos outros</th></tr></thead>
      <tbody>${meses.map((m) => `<tr><td>${mesCurto(m.mes + '-01')}</td>${d.cartoes.map((c) => `<td class="n">${m.porCartao[c.id] ? num(m.porCartao[c.id].total) : '—'}</td>`).join('')}<td class="n">${num(m.total)}</td><td class="n">${num(m.minha)}</td><td class="n">${num(m.outros)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>12 meses</td>${d.cartoes.map((c) => `<td class="n">${num(meses.reduce((s, m) => s + (m.porCartao[c.id]?.total || 0), 0))}</td>`).join('')}<td class="n">${num(meses.reduce((s, m) => s + m.total, 0))}</td><td class="n">${num(meses.reduce((s, m) => s + m.minha, 0))}</td><td class="n">${num(meses.reduce((s, m) => s + m.outros, 0))}</td></tr></tfoot>
    </table></div>
  </section>
  <section class="card">
    <div class="card-h"><h2>Compras parceladas</h2><span class="small muted">ainda falta ${brl(totParc)}</span></div>
    <ul class="lista">${parc.map((p) => `<li class="click" data-act="editar-lanc" data-arg="${p.l.id}">
      <div class="desc"><b>${esc(p.desc)}</b><small>${esc(cartao(p.cartao).nome)} · ${p.n}/${p.total} · ${p.faltam ? `termina ${mesCurto(p.ultimaVenc)}` : 'última parcela'}${p.outros.length ? ' · ' + esc(p.outros.map((o) => nome(o.pessoa)).join(', ')) : ''}</small>
        <div class="barra" style="height:6px;margin-top:6px;max-width:220px"><span class="m" style="width:${(p.n / p.total) * 100}%"></span></div></div>
      <div class="valor">${brl(p.valor)}<small>${p.faltam ? `falta ${brl(p.restante)}` : ''}</small></div>${!p.faltam ? '<span class="tag ok">acaba</span>' : ''}</li>`).join('') || '<li class="vazio">Sem parcelas em andamento.</li>'}</ul>
  </section>
  <section class="card">
    <div class="card-h"><h2>Gastos fixos (todo mês)</h2><span class="small muted">${brl(fixos.reduce((s, f) => s + f.l.valor, 0))}/mês · minha parte ${brl(fixos.reduce((s, f) => s + f.minha, 0))}</span></div>
    <ul class="lista">${fixos.map((f) => `<li class="click" data-act="editar-lanc" data-arg="${f.l.id}"><div class="desc"><b>${esc(f.l.desc)}</b><small>${esc(cartao(f.l.cartao).nome)} · último em ${diaMes(f.l.venc)}${f.outros.length ? ' · ' + esc(f.outros.map((o) => nome(o.pessoa)).join(', ')) : ''}</small></div><div class="valor">${brl(f.l.valor)}</div></li>`).join('') || '<li class="vazio">Nenhum gasto marcado como fixo.</li>'}</ul>
    <p class="tiny muted" style="margin:8px 0 0">Para marcar um gasto como fixo, abra o lançamento e ligue "Gasto fixo". Se uma fatura fechada vier sem ele, o app entende que foi cancelado.</p>
  </section>`;
}

// ======================= AJUSTES =======================
function vAjustes() {
  const d = S.dados; const cfg = S.store.cfg || {};
  const tiposPix = [['cpf', 'CPF'], ['cnpj', 'CNPJ'], ['telefone', 'Telefone'], ['email', 'E-mail'], ['aleatoria', 'Aleatória']];
  return `
  <section class="card pilha">
    <h2>Cartões e chaves Pix</h2>
    <p class="small muted" style="margin:6px 0 0">A chave Pix de cada cartão vai na mensagem de cobrança das compras feitas nele.</p>
    ${d.cartoes.map((c) => `<div class="card plano form" style="background:var(--surface-2)">
      <div class="row">${chipCartao(c)}</div>
      <div class="lado"><label class="campo"><span>Dia do fechamento</span><input class="inp" type="number" min="1" max="31" data-chg="cartao" data-arg="${c.id}|fechamento" value="${c.fechamento}"></label>
      <label class="campo"><span>Dia do vencimento</span><input class="inp" type="number" min="1" max="31" data-chg="cartao" data-arg="${c.id}|vencimento" value="${c.vencimento}"></label></div>
      <div class="lado"><label class="campo"><span>Tipo da chave Pix</span><select class="inp" data-chg="cartao" data-arg="${c.id}|pix.tipo">${tiposPix.map(([v, t]) => `<option value="${v}" ${c.pix?.tipo === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="campo"><span>Chave Pix (${esc(c.pix?.banco || c.nome)})</span><input class="inp" data-chg="cartao" data-arg="${c.id}|pix.chave" value="${esc(c.pix?.chave || '')}" autocapitalize="off"></label></div>
      <div class="lado"><label class="campo"><span>Nome do titular</span><input class="inp" data-chg="cartao" data-arg="${c.id}|pix.nome" value="${esc(c.pix?.nome || '')}"></label>
      <label class="campo"><span>Cidade</span><input class="inp" data-chg="cartao" data-arg="${c.id}|pix.cidade" value="${esc(c.pix?.cidade || '')}"></label></div>
    </div>`).join('')}
  </section>
  <section class="card">
    <div class="card-h"><h2>Pessoas</h2><button class="btn sm" data-act="pessoa-form">${icon('plus')} Pessoa</button></div>
    <ul class="lista">${pessoasOutras().map((p) => `<li class="click" data-act="pessoa-form" data-arg="${p.id}"><div class="desc"><b>${esc(p.nome)}</b><small>${p.telefone ? 'WhatsApp ' + esc(p.telefone) : 'sem WhatsApp'}</small></div>${icon('chev')}</li>`).join('')}</ul>
  </section>
  <section class="card">
    <div class="card-h"><h2>Regras automáticas</h2><button class="btn sm" data-act="regra-nova">${icon('plus')} Regra</button></div>
    <p class="small muted" style="margin:0 0 8px">Quando a descrição tiver o texto, o lançamento já entra com a pessoa e/ou como fixo. Parcelas seguintes de uma compra já herdam a divisão sozinhas.</p>
    <ul class="lista">${(d.regras || []).map((r) => `<li class="row wrap">
      <input class="inp" style="flex:2;min-width:140px" data-chg="regra" data-arg="${r.id}|contem" value="${esc(r.contem)}" aria-label="Texto">
      <select class="inp" style="flex:1;min-width:110px" data-chg="regra" data-arg="${r.id}|pessoa"><option value="eu">Eu</option>${pessoasOutras().map((p) => `<option value="${p.id}" ${r.pessoa === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select>
      <label class="check small"><input type="checkbox" data-chg="regra" data-arg="${r.id}|fixo" ${r.fixo ? 'checked' : ''}> fixo</label>
      <button class="btn sm ghost perigo" data-act="regra-apagar" data-arg="${r.id}" aria-label="Apagar regra">${icon('x')}</button></li>`).join('') || '<li class="vazio">Sem regras.</li>'}</ul>
  </section>
  <section class="card form">
    <h2>Cobrança</h2>
    <label class="campo"><span>Cobrar quantos dias antes do vencimento</span><input class="inp" type="number" min="0" max="10" data-chg="dias-cobranca" value="${d.config?.diasAntesCobranca ?? 2}"></label>
    <p class="tiny muted" style="margin:0">O lembrete automático diário (GitHub Actions no repositório de dados) usa esse mesmo número.</p>
  </section>
  <section class="card pilha">
    <h2>Dados e segurança</h2>
    <p class="small" style="margin:6px 0 0">Conectado a <b>${esc(cfg.owner)}/${esc(cfg.repo)}</b> (${esc(cfg.path)}, branch ${esc(cfg.branch)}). Última gravação: ${d.atualizadoEm ? new Date(d.atualizadoEm).toLocaleString('pt-BR') : '—'}.</p>
    <div class="row wrap">
      <button class="btn" data-act="recarregar">${icon('refresh')} Recarregar do GitHub</button>
      <button class="btn" data-act="backup">Baixar cópia (.json)</button>
      <button class="btn" data-act="bloquear">${icon('lock')} Bloquear agora</button>
      <button class="btn perigo" data-act="sair">Desconectar este aparelho</button>
    </div>
    <p class="tiny muted" style="margin:0">PDFs e CSVs são lidos aqui no aparelho; só os lançamentos vão para o GitHub (CPF, endereço e código de barras da fatura são ignorados). O app trava sozinho depois de 10 minutos em segundo plano.</p>
  </section>`;
}

// ======================= modais =======================
function modalEditarLanc(id, preset = {}) {
  const d = S.dados;
  const l = id ? d.lancamentos.find((x) => x.id === id) : null;
  if (id && !l) return toast('Lançamento não encontrado.');
  const cid = l?.cartao || preset.cartao || d.cartoes[0].id;
  const ed = {
    novo: !l, manual: !l || l.origem === 'manual', cartao: cid, data: l?.data || S.hoje, venc: l?.venc || preset.venc || C.vencDaCompra(cartao(cid), S.hoje), vencManual: !!preset.venc,
    desc: l?.desc || '', valor: l ? l.valor : '', parcN: l?.parcela?.n || 1, parcT: l?.parcela?.total || 1, fixo: !!l?.fixo, obs: l?.obs || '',
    modo: 'meu', pessoa: pessoasOutras()[0]?.id || '', metade: false, sel: new Set([EU]), igual: true, valores: {}, grupo: l?.grupo || '', pagos: {}, criarRegra: false,
  };
  if (l) {
    const dv = l.divisao || [];
    dv.forEach((x) => { ed.pagos[x.pessoa] = !!x.pago; ed.valores[x.pessoa] = x.valor; });
    const minha = C.minhaParte(d, l);
    if (l.grupo) ed.modo = 'grupo';
    else if (dv.length === 1 && minha < 0.005) { ed.modo = 'pessoa'; ed.pessoa = dv[0].pessoa; }
    else if (dv.length === 1 && Math.abs(dv[0].valor - l.valor / 2) < 0.011) { ed.modo = 'pessoa'; ed.pessoa = dv[0].pessoa; ed.metade = true; }
    else if (dv.length) {
      ed.modo = 'dividido'; ed.sel = new Set([...(minha > 0.004 ? [EU] : []), ...dv.map((x) => x.pessoa)]);
      const igual = C.dividirIgual(l.valor, [...ed.sel]);
      ed.igual = igual.every((x, i) => Math.abs(x.valor - dv.find((y) => y.pessoa === x.pessoa)?.valor) < 0.011) && igual.length === dv.length;
      ed.valores[EU] = minha;
    }
  }
  const tela = (m) => {
    const isPag = l?.tipo === 'pagamento';
    const valorN = parseValor(ed.valor);
    const outras = pessoasOutras();
    let corpo = `${cabecalhoModal(ed.novo ? 'Lançar compra' : (isPag ? 'Pagamento' : 'Lançamento'))}<div class="form">`;
    if (ed.manual) {
      corpo += `<div class="lado"><label class="campo"><span>Cartão</span><select class="inp" data-e="cartao">${d.cartoes.map((c) => `<option value="${c.id}" ${c.id === ed.cartao ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
        <label class="campo"><span>Data da compra</span><input class="inp" type="date" data-e="data" value="${ed.data}"></label></div>
        <label class="campo"><span>Descrição</span><input class="inp" data-e="desc" value="${esc(ed.desc)}" placeholder="ex.: Mercado, Uber…"></label>
        <div class="lado"><label class="campo"><span>${ed.parcT > 1 ? 'Valor da parcela' : 'Valor'} (R$)</span><input class="inp" inputmode="decimal" data-e="valor" value="${ed.valor === '' ? '' : esc(typeof ed.valor === 'number' ? num(ed.valor) : ed.valor)}"></label>
        <label class="campo"><span>Parcela</span><span class="row"><input class="inp" type="number" min="1" max="48" data-e="parcN" value="${ed.parcN}" style="width:70px"> de <input class="inp" type="number" min="1" max="48" data-e="parcT" value="${ed.parcT}" style="width:70px"></span></label></div>
        <p class="tiny muted" style="margin:-4px 0 0">Entra na fatura que vence em <b>${dataBR(ed.venc)}</b>${ed.vencManual ? '' : ' (pela data da compra e o fechamento do cartão)'}.</p>`;
    } else {
      corpo += `<div><b>${esc(l.desc)}</b><div class="small muted">${esc(cartao(l.cartao).nome)} · ${l.data ? dataBR(l.data) : ''} · fatura ${dataBR(l.venc)}${l.parcela ? ` · parcela ${l.parcela.n}/${l.parcela.total}` : ''}${l.origem === 'previsto' ? ' · previsto pelo PDF' : ''}</div>
        <div class="num" style="font-size:22px;font-weight:680;margin-top:4px">${brl(l.valor)}</div></div>`;
    }
    if (!isPag) {
      corpo += `<div><div class="small" style="font-weight:550;color:var(--ink-2);margin-bottom:6px">De quem é?</div>
        <div class="seg">${[['meu', 'Só meu'], ['pessoa', 'De uma pessoa'], ['dividido', 'Dividido'], ['grupo', 'Grupo']].map(([k, t]) => `<button type="button" data-e-modo="${k}" aria-pressed="${ed.modo === k}">${t}</button>`).join('')}</div></div>`;
      if (ed.modo === 'pessoa') {
        corpo += `<div class="lado"><label class="campo"><span>Pessoa</span><select class="inp" data-e="pessoa">${outras.map((p) => `<option value="${p.id}" ${p.id === ed.pessoa ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select></label>
          <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" data-e="metade" ${ed.metade ? 'checked' : ''}> meio a meio comigo</label></div>
          <label class="check"><input type="checkbox" data-e-pago="${ed.pessoa}" ${ed.pagos[ed.pessoa] ? 'checked' : ''}> ${esc(nome(ed.pessoa))} já me pagou</label>`;
      }
      if (ed.modo === 'dividido') {
        corpo += `<div class="chips">${[{ id: EU, nome: 'Eu' }, ...outras].map((p) => `<button type="button" data-e-sel="${p.id}" aria-pressed="${ed.sel.has(p.id)}">${esc(p.nome)}</button>`).join('')}</div>
          <div class="seg"><button type="button" data-e-igual="1" aria-pressed="${ed.igual}">Partes iguais</button><button type="button" data-e-igual="0" aria-pressed="${!ed.igual}">Valores diferentes</button></div>`;
        const sel = [...ed.sel];
        if (sel.length) {
          const iguais = Number.isFinite(valorN) ? C.dividirIgual(valorN, sel) : [];
          corpo += `<ul class="lista">${sel.map((pid) => {
            const v = ed.igual ? (pid === EU ? round2(valorN - iguais.reduce((s, x) => s + x.valor, 0)) : iguais.find((x) => x.pessoa === pid)?.valor) : ed.valores[pid];
            return `<li><div class="desc"><b>${esc(nome(pid))}</b></div>
              ${ed.igual ? `<div class="valor">${Number.isFinite(v) ? brl(v) : '—'}</div>` : `<input class="inp" style="width:110px;text-align:right" inputmode="decimal" data-e-val="${pid}" value="${v != null && v !== '' ? num(v) : ''}">`}
              ${pid !== EU ? `<label class="check tiny"><input type="checkbox" data-e-pago="${pid}" ${ed.pagos[pid] ? 'checked' : ''}> pagou</label>` : ''}</li>`;
          }).join('')}</ul>`;
          if (!ed.igual && Number.isFinite(valorN)) {
            const soma = sel.reduce((s, pid) => s + (Number(ed.valores[pid]) || 0), 0);
            if (Math.abs(soma - valorN) > 0.009) corpo += `<div class="alerta warn small">As partes somam ${brl(soma)}; o lançamento é ${brl(valorN)}. ${soma < valorN ? 'A diferença fica como minha.' : ''}</div>`;
          }
        }
      }
      if (ed.modo === 'grupo') {
        corpo += (d.grupos || []).length ? `<label class="campo"><span>Compra em grupo</span><select class="inp" data-e="grupo"><option value="">—</option>${d.grupos.map((g) => `<option value="${g.id}" ${g.id === ed.grupo ? 'selected' : ''}>${esc(g.nome)}</option>`).join('')}</select></label>
          <p class="tiny muted" style="margin:0">A divisão e os pagamentos ficam na tela do grupo.</p>` : '<p class="small muted">Nenhum grupo criado. Crie em Grupos.</p>';
      }
      corpo += `<label class="check"><input type="checkbox" data-e="fixo" ${ed.fixo ? 'checked' : ''}> Gasto fixo (vem todo mês)</label>`;
      if (ed.modo !== 'grupo' && ed.parcT <= 1) {
        corpo += `<label class="check small"><input type="checkbox" data-e="criarRegra" ${ed.criarRegra ? 'checked' : ''}> Criar regra: próximas compras com "${esc(raizDesc(ed.desc || l?.desc || '').slice(0, 30))}" entram assim</label>`;
      }
      corpo += `<label class="campo"><span>Observação</span><input class="inp" data-e="obs" value="${esc(ed.obs)}"></label>`;
    }
    corpo += `</div><div class="modal-f">${!ed.novo && (ed.manual || l.origem === 'previsto') ? '<button class="btn perigo" data-e-apagar>Apagar</button>' : ''}<div class="grow"></div><button class="btn" data-act="fechar-modal">Cancelar</button>${!isPag ? '<button class="btn pri" data-e-salvar>Salvar</button>' : ''}</div>`;
    m.innerHTML = corpo;
  };
  abrirModal('', {
    aoMontar: (m) => {
      tela(m);
      const ler = (e) => {
        const t = e.target;
        if (t.dataset.e) {
          const k = t.dataset.e;
          ed[k] = t.type === 'checkbox' ? t.checked : (['parcN', 'parcT'].includes(k) ? Math.max(1, Number(t.value) || 1) : t.value);
          if ((k === 'data' || k === 'cartao') && !ed.vencManual && ed.data) ed.venc = C.vencDaCompra(cartao(ed.cartao), ed.data);
          if (k === 'parcT' && ed.parcN > ed.parcT) ed.parcN = ed.parcT;
          if (k === 'desc') { const p = detectaParcela(ed.desc); if (p && ed.parcT === 1) { ed.parcN = p.n; ed.parcT = p.total; return true; } }
          // campos de texto não redesenham o formulário (para não perder o foco ao digitar)
          return !['desc', 'valor', 'obs'].includes(k);
        }
        if (t.dataset.eVal) { ed.valores[t.dataset.eVal] = parseValor(t.value); return false; }
        if (t.dataset.ePago) { ed.pagos[t.dataset.ePago] = t.checked; return false; }
        return false;
      };
      m.addEventListener('change', (e) => { if (ler(e)) tela(m); });
      m.addEventListener('input', (e) => { if (e.target.dataset.e === 'valor' || e.target.dataset.eVal != null) ler(e); });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.eModo) { ed.modo = b.dataset.eModo; tela(m); }
        else if (b.dataset.eSel) { ed.sel.has(b.dataset.eSel) ? ed.sel.delete(b.dataset.eSel) : ed.sel.add(b.dataset.eSel); tela(m); }
        else if (b.dataset.eIgual) { ed.igual = b.dataset.eIgual === '1'; tela(m); }
        else if (b.hasAttribute('data-e-apagar')) { if (confirm('Apagar este lançamento?')) { mutar((dd) => { dd.lancamentos = dd.lancamentos.filter((x) => x.id !== id); }, 'app: lançamento apagado'); fecharModal(); } }
        else if (b.hasAttribute('data-e-salvar')) salvarEd();
      });
    },
  });
  function salvarEd() {
    const valor = round2(ed.manual ? parseValor(ed.valor) : l.valor);
    if (ed.manual && (!ed.desc.trim() || !Number.isFinite(valor) || valor === 0)) return toast('Preencha descrição e valor.');
    let divisao = [];
    const keep = (arr) => arr.map((x) => ({ ...x, pago: !!ed.pagos[x.pessoa], pagoEm: ed.pagos[x.pessoa] ? (l?.divisao?.find((y) => y.pessoa === x.pessoa)?.pagoEm || S.hoje) : null }));
    if (ed.modo === 'pessoa') {
      if (!ed.pessoa) return toast('Escolha a pessoa.');
      divisao = keep(ed.metade ? C.dividirIgual(valor, [EU, ed.pessoa]) : [{ pessoa: ed.pessoa, valor }]);
    } else if (ed.modo === 'dividido') {
      const sel = [...ed.sel];
      if (sel.filter((p) => p !== EU).length === 0) return toast('Escolha pelo menos uma pessoa além de você.');
      divisao = keep(ed.igual ? C.dividirIgual(valor, sel) : sel.filter((p) => p !== EU).map((p) => ({ pessoa: p, valor: round2(Number(ed.valores[p]) || 0) })).filter((x) => x.valor > 0));
      if (divisao.reduce((s, x) => s + x.valor, 0) > valor + 0.009) return toast('As partes dos outros passam do valor do lançamento.');
    }
    const grupo = ed.modo === 'grupo' ? (ed.grupo || null) : null;
    mutar((dd) => {
      let alvo = dd.lancamentos.find((x) => x.id === id);
      if (!alvo) {
        alvo = { id: uid('l'), tipo: 'compra', origem: 'manual', refVenc: null };
        dd.lancamentos.push(alvo);
      }
      if (ed.manual) {
        Object.assign(alvo, { cartao: ed.cartao, data: ed.data, venc: ed.venc, desc: ed.desc.trim(), valor, parcela: ed.parcT > 1 ? { n: ed.parcN, total: ed.parcT } : null, tipo: valor < 0 ? 'estorno' : 'compra' });
      }
      Object.assign(alvo, { divisao: grupo ? [] : divisao, grupo, fixo: !!ed.fixo, obs: ed.obs || '' });
      if (ed.criarRegra && ed.modo !== 'grupo') {
        dd.regras ||= [];
        const contem = (alvo.desc || '').replace(/\s*-?\s*(parcela\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*$/i, '').trim();
        dd.regras.push({ id: uid('r'), contem, pessoa: ed.modo === 'pessoa' ? ed.pessoa : EU, modo: ed.metade ? 'metade' : 'inteiro', fixo: !!ed.fixo });
      }
    }, ed.novo ? 'app: compra lançada' : 'app: lançamento editado');
    fecharModal(); toast('Salvo.');
  }
}

function modalCobrar(pid, cid) {
  const d = S.dados;
  const cob = C.cobrancasDevidas(d, S.hoje, d.config?.diasAntesCobranca ?? 2).find((x) => x.pessoa === pid && x.cartao === cid)
    || (() => { // cobrança manual antes do prazo: tudo que está pendente nesse cartão
      const itens = C.itensAReceber(d, S.hoje).filter((i) => i.pessoa === pid && i.cartao === cid && !i.pago && i.falta > 0 && i.situacao !== 'futuro');
      return itens.length ? { pessoa: pid, cartao: cid, itens, total: round2(itens.reduce((s, i) => s + i.falta, 0)), venc: itens[itens.length - 1].venc } : null;
    })();
  if (!cob) return toast('Nada pendente para cobrar.');
  const c = cartao(cid); const p = C.pessoaPorId(d, pid);
  const texto = C.mensagemCobranca(d, cob, S.hoje);
  abrirModal(`${cabecalhoModal(`Cobrar ${p.nome}`)}
    ${!c.pix?.chave ? `<div class="alerta warn small" style="margin-bottom:10px">Cadastre a chave Pix do ${esc(c.nome)} em Ajustes para ela ir na mensagem.</div>` : ''}
    ${!p.telefone ? '<div class="alerta info small" style="margin-bottom:10px">Sem WhatsApp cadastrado: o WhatsApp vai abrir para você escolher o contato.</div>' : ''}
    <label class="campo"><span>Mensagem (pode editar)</span><textarea class="inp" rows="10" id="msg-cob">${esc(texto)}</textarea></label>
    <div class="modal-f">
      <button class="btn" data-cob="copiar">${icon('copy')} Copiar</button>
      ${navigator.share ? `<button class="btn" data-cob="share">${icon('share')} Compartilhar</button>` : ''}
      <a class="btn pri" data-cob="wa" href="#" target="_blank" rel="noopener noreferrer">${icon('chat')} Abrir WhatsApp</a>
    </div>
    <div class="modal-f" style="margin-top:8px"><button class="btn ok" data-cob="pago">${icon('check')} ${esc(p.nome.split(' ')[0])} pagou tudo (${brl(cob.total)})</button></div>`, {
    aoMontar: (m) => {
      const ta = m.querySelector('#msg-cob'); const wa = m.querySelector('[data-cob="wa"]');
      const atual = () => { wa.href = C.linkWhatsApp(d, cob, ta.value); };
      atual(); ta.addEventListener('input', atual);
      const registra = () => mutar((dd) => { dd.cobrancas ||= []; dd.cobrancas.push({ pessoa: pid, cartao: cid, venc: cob.venc, em: S.hoje, total: cob.total }); }, 'app: cobrança enviada');
      m.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-cob]'); if (!b) return;
        const k = b.dataset.cob;
        if (k === 'wa') { setTimeout(registra, 200); }
        if (k === 'copiar') { try { await navigator.clipboard.writeText(ta.value); toast('Mensagem copiada.'); registra(); } catch { ta.select(); toast('Selecionei o texto — copie manualmente.'); } }
        if (k === 'share') { try { await navigator.share({ text: ta.value }); registra(); } catch { /* cancelado */ } }
        if (k === 'pago') { marcarItensPagos(cob.itens); fecharModal(); toast('Marcado como pago.'); }
      });
    },
  });
}

function marcarItensPagos(itens) {
  mutar((dd) => {
    for (const it of itens) {
      if (it.tipo === 'linha') {
        const l = dd.lancamentos.find((x) => x.id === it.lancId);
        const dv = l?.divisao?.find((x) => x.pessoa === it.pessoa);
        if (dv) { dv.pago = true; dv.pagoEm = S.hoje; }
      } else {
        const g = dd.grupos.find((x) => x.id === it.grupoId);
        if (g && it.falta > 0) g.pagamentos.push({ id: uid('pg'), pessoa: it.pessoa, valor: it.falta, data: S.hoje, ref: it.venc.slice(0, 7) });
      }
    }
  }, 'app: recebimento marcado');
}

function modalPessoa(pid) {
  const p = pid ? C.pessoaPorId(S.dados, pid) : null;
  abrirModal(`${cabecalhoModal(p ? 'Editar pessoa' : 'Nova pessoa')}
    <form class="form" id="f-pessoa">
      <label class="campo"><span>Nome</span><input class="inp" name="nome" required value="${esc(p?.nome || '')}"></label>
      <label class="campo"><span>WhatsApp (com DDD)</span><input class="inp" name="telefone" inputmode="tel" placeholder="94 99999-9999" value="${esc(p?.telefone || '')}"></label>
      <div class="modal-f">${p ? '<button type="button" class="btn perigo" id="b-rem">Remover</button><div class="grow"></div>' : ''}<button type="button" class="btn" data-act="fechar-modal">Cancelar</button><button class="btn pri">Salvar</button></div>
    </form>`, {
    aoMontar: (m) => {
      m.querySelector('#f-pessoa').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        mutar((dd) => {
          if (p) Object.assign(dd.pessoas.find((x) => x.id === pid), { nome: f.nome.trim(), telefone: f.telefone.trim() });
          else {
            let id = slug(f.nome); while (dd.pessoas.some((x) => x.id === id)) id += '-2';
            dd.pessoas.push({ id, nome: f.nome.trim(), telefone: f.telefone.trim() });
          }
        }, 'app: pessoa salva');
        fecharModal();
      });
      m.querySelector('#b-rem')?.addEventListener('click', () => {
        const usa = S.dados.lancamentos.some((l) => (l.divisao || []).some((x) => x.pessoa === pid)) || S.dados.grupos.some((g) => g.participantes.some((x) => x.pessoa === pid));
        if (usa) return toast('Essa pessoa tem lançamentos. Remova dela antes.');
        mutar((dd) => { dd.pessoas = dd.pessoas.filter((x) => x.id !== pid); dd.regras = dd.regras.filter((r) => r.pessoa !== pid); }, 'app: pessoa removida');
        fecharModal();
      });
    },
  });
}

function modalGrupo(gid) {
  const d = S.dados;
  const g = gid ? structuredClone(C.grupoPorId(d, gid)) : {
    id: uid('g'), nome: '', cartao: d.cartoes[0].id, descContem: '', rotuloPeso: 'diárias',
    parcelado: { total: '', parcelas: 1, primeiraVenc: C.faturaAberta(d.cartoes[0], S.hoje) }, avista: null,
    participantes: [{ pessoa: EU, peso: 1 }], pagamentos: [],
  };
  const tela = (m) => {
    const c = cartao(g.cartao);
    const vencs = Array.from({ length: 8 }, (_, i) => C.vencSeguinte(c, C.faturaAberta(c, S.hoje), i - 3));
    const parc = g.parcelado || { total: '', parcelas: 1, primeiraVenc: C.faturaAberta(c, S.hoje) };
    m.innerHTML = `${cabecalhoModal(gid ? 'Editar compra em grupo' : 'Nova compra em grupo')}
    <div class="form">
      <label class="campo"><span>Nome</span><input class="inp" data-g="nome" value="${esc(g.nome)}" placeholder="ex.: Viagem Jalapão"></label>
      <div class="lado"><label class="campo"><span>Cartão</span><select class="inp" data-g="cartao">${d.cartoes.map((x) => `<option value="${x.id}" ${x.id === g.cartao ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
      <label class="campo"><span>Texto na fatura</span><input class="inp" data-g="descContem" value="${esc(g.descContem || '')}" placeholder="ex.: Airbnb"></label></div>
      <div class="lado"><label class="campo"><span>Valor parcelado (total)</span><input class="inp" inputmode="decimal" data-g="parcelado.total" value="${parc.total !== '' ? num(parc.total) : ''}"></label>
      <label class="campo"><span>Nº de parcelas</span><input class="inp" type="number" min="1" max="48" data-g="parcelado.parcelas" value="${parc.parcelas}"></label></div>
      <label class="campo"><span>1ª parcela na fatura de</span><select class="inp" data-g="parcelado.primeiraVenc">${[...new Set([parc.primeiraVenc, ...vencs])].sort().map((v) => `<option value="${v}" ${v === parc.primeiraVenc ? 'selected' : ''}>${dataBR(v)}</option>`).join('')}</select></label>
      <div class="lado"><label class="campo"><span>Valor à vista extra (opcional)</span><input class="inp" inputmode="decimal" data-g="avista.valor" value="${g.avista?.valor ? num(g.avista.valor) : ''}"></label>
      <label class="campo"><span>Na fatura de</span><select class="inp" data-g="avista.venc">${[...new Set([g.avista?.venc || parc.primeiraVenc, ...vencs])].sort().map((v) => `<option value="${v}" ${v === (g.avista?.venc || parc.primeiraVenc) ? 'selected' : ''}>${dataBR(v)}</option>`).join('')}</select></label></div>
      <label class="campo"><span>A divisão é por</span><input class="inp" data-g="rotuloPeso" value="${esc(g.rotuloPeso || '')}" placeholder="diárias, pessoas, quartos…"></label>
      <div><div class="small" style="font-weight:550;color:var(--ink-2);margin-bottom:6px">Participantes e ${esc(g.rotuloPeso || 'peso')}</div>
      <ul class="lista">${[{ id: EU, nome: 'Eu' }, ...pessoasOutras()].map((p) => {
        const part = g.participantes.find((x) => x.pessoa === p.id);
        return `<li><label class="check grow"><input type="checkbox" data-gp="${p.id}" ${part ? 'checked' : ''}> ${esc(p.nome)}</label>${part ? `<input class="inp" style="width:80px;text-align:right" type="number" min="0" step="0.5" data-gpeso="${p.id}" value="${part.peso}">` : ''}</li>`;
      }).join('')}</ul></div>
      ${(() => { const tot = (Number(g.parcelado?.total) || 0) + (Number(g.avista?.valor) || 0); const w = C.pesosGrupo(g).total; return tot && w ? `<p class="small muted" style="margin:0">Total ${brl(tot)} ÷ ${w} ${esc(g.rotuloPeso || '')} = ${brl(tot / w)} por unidade${g.parcelado?.parcelas > 1 ? ` (${brl((Number(g.parcelado.total) || 0) / w / g.parcelado.parcelas)} por parcela)` : ''}.</p>` : ''; })()}
    </div>
    <div class="modal-f">${gid ? '<button class="btn perigo" data-g-apagar>Apagar grupo</button><div class="grow"></div>' : ''}<button class="btn" data-act="fechar-modal">Cancelar</button><button class="btn pri" data-g-salvar>Salvar</button></div>`;
  };
  abrirModal('', {
    largo: true,
    aoMontar: (m) => {
      tela(m);
      m.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.g) {
          const [a, b] = t.dataset.g.split('.');
          const v = ['total', 'valor'].includes(b) ? parseValor(t.value) : b === 'parcelas' ? Math.max(1, Number(t.value) || 1) : t.value;
          if (b) { if (a === 'avista' && !g.avista) g.avista = { valor: 0, venc: g.parcelado?.primeiraVenc, desc: 'À vista' }; if (a === 'parcelado' && !g.parcelado) g.parcelado = { total: 0, parcelas: 1, primeiraVenc: C.faturaAberta(cartao(g.cartao), S.hoje) }; g[a][b] = v; } else g[a] = v;
        } else if (t.dataset.gp) {
          if (t.checked) g.participantes.push({ pessoa: t.dataset.gp, peso: 1 }); else g.participantes = g.participantes.filter((x) => x.pessoa !== t.dataset.gp);
        } else if (t.dataset.gpeso) {
          const p = g.participantes.find((x) => x.pessoa === t.dataset.gpeso); if (p) p.peso = Number(t.value) || 0;
        }
        tela(m);
      });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.hasAttribute('data-g-apagar')) {
          if (!confirm('Apagar o grupo? Os lançamentos ligados a ele voltam a ser só seus.')) return;
          mutar((dd) => { dd.grupos = dd.grupos.filter((x) => x.id !== gid); dd.lancamentos.forEach((l) => { if (l.grupo === gid) l.grupo = null; }); }, 'app: grupo apagado');
          S.grupoSel = null; fecharModal();
        }
        if (b.hasAttribute('data-g-salvar')) {
          if (!g.nome.trim()) return toast('Dê um nome ao grupo.');
          if (!g.participantes.some((p) => p.pessoa !== EU)) return toast('Escolha pelo menos uma pessoa além de você.');
          if (g.parcelado && !(Number(g.parcelado.total) > 0)) g.parcelado = null;
          if (g.avista && !(Number(g.avista.valor) > 0)) g.avista = null;
          if (!g.parcelado && !g.avista) return toast('Informe o valor parcelado ou o valor à vista.');
          mutar((dd) => {
            const i = dd.grupos.findIndex((x) => x.id === g.id);
            if (i >= 0) dd.grupos[i] = g; else dd.grupos.push(g);
            if (g.descContem) { // liga lançamentos já existentes
              const alvo = g.descContem.toLowerCase();
              dd.lancamentos.forEach((l) => { if (l.cartao === g.cartao && l.tipo === 'compra' && !l.grupo && l.desc.toLowerCase().includes(alvo)) { l.grupo = g.id; l.divisao = []; } });
            }
          }, 'app: grupo salvo');
          S.grupoSel = g.id; fecharModal();
        }
      });
    },
  });
}

// ---------- importação ----------
let pdfjsMod = null;
async function lerArquivo(file, cartaoPref) {
  const ehPDF = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (ehPDF) {
    if (!pdfjsMod) {
      pdfjsMod = await import('../vendor/pdfjs/pdf.min.js');
      pdfjsMod.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
    }
    const pages = await lerPaginasPDF(pdfjsMod, new Uint8Array(await file.arrayBuffer()));
    return parseItauPages(pages);
  }
  return parseNubankCSV(await file.text(), file.name);
}
async function iniciarImport(file, cartaoPref) {
  let p;
  try { toast('Lendo arquivo…', 1500); p = await lerArquivo(file, cartaoPref); } catch (err) { return abrirModal(`${cabecalhoModal('Não consegui ler')}<p class="erro-txt">${esc(err.message)}</p><div class="modal-f"><button class="btn" data-act="fechar-modal">Ok</button></div>`); }
  const d = S.dados;
  const cid = (d.cartoes.find((c) => c.id === p.banco) || d.cartoes.find((c) => (p.banco === 'itau' ? /ita/i : /nu/i).test(c.nome)) || d.cartoes[0]).id;
  const c = cartao(cid);
  const ultCompra = p.linhas.filter((l) => l.tipo === 'compra' && !l.parcela).map((l) => l.data).sort().pop() || S.hoje;
  const imp = { p, cartao: cid, venc: p.vencimento || C.vencDaCompra(c, ultCompra), valorInformado: null, refs: null };
  const conc0 = C.conciliar(p.linhas, c, imp.venc, null); imp.refs = { ...conc0.refs };
  const tela = (m) => {
    const cc = cartao(imp.cartao);
    const conc = C.conciliar(p.linhas, cc, imp.venc, imp.valorInformado);
    const calc = round2(conc.compras + conc.creditos + conc.pagamentos.reduce((s, x) => s + (imp.refs[x.idx] === imp.venc ? x.valor : 0), 0));
    const dif = imp.valorInformado != null ? round2(imp.valorInformado - calc) : null;
    const ant = C.vencAnterior(cc, imp.venc);
    const existe = d.lancamentos.some((l) => l.cartao === imp.cartao && l.venc === imp.venc && l.origem !== 'previsto');
    m.innerHTML = `${cabecalhoModal(p.banco === 'itau' ? 'Fatura Itaú (PDF)' : 'Fatura Nubank (CSV)')}
    <div class="form">
      <div class="lado"><label class="campo"><span>Cartão</span><select class="inp" data-i="cartao">${d.cartoes.map((x) => `<option value="${x.id}" ${x.id === imp.cartao ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
      <label class="campo"><span>Vencimento da fatura</span><input class="inp" type="date" data-i="venc" value="${imp.venc}"></label></div>
      ${existe ? '<div class="alerta info small">Essa fatura já tem lançamentos. Vou atualizar: o que você já marcou (pessoa, divisão, pago) é mantido.</div>' : ''}
      <div class="grid g3m">
        <div><div class="tiny muted">Compras e encargos</div><div class="num" style="font-weight:680">${brl(conc.compras)}</div><div class="tiny muted">${p.linhas.filter((l) => l.tipo === 'compra').length} lançamentos</div></div>
        <div><div class="tiny muted">Estornos/créditos</div><div class="num" style="font-weight:680">${brl(conc.creditos)}</div></div>
        <div><div class="tiny muted">Total calculado</div><div class="num" style="font-weight:680">${brl(calc)}</div></div>
      </div>
      ${p.banco === 'itau' ? `
        ${p.totalDeclarado != null ? `<div class="alerta ${Math.abs(p.totalDeclarado - p.somaLancamentos) < 0.01 ? 'ok' : 'warn'} small">Total da fatura no PDF: ${brl(p.totalDeclarado)} · lido: ${brl(p.somaLancamentos)} ${Math.abs(p.totalDeclarado - p.somaLancamentos) < 0.01 ? '— confere.' : '— não confere.'}</div>` : ''}
        ${p.proximas?.linhas.length ? `<div class="alerta info small">Parcelas da próxima fatura (${dataBR(p.proximas.vencimento)}): ${p.proximas.linhas.length} itens, ${brl(p.proximas.soma)}${p.proximas.declarada != null ? (Math.abs(p.proximas.soma - p.proximas.declarada) < 0.01 ? ' — confere com o PDF' : ` — PDF diz ${brl(p.proximas.declarada)}`) : ''}. Entram como previstas.</div>` : ''}` : ''}
      ${conc.pagamentos.length ? `<div><div class="small" style="font-weight:550;color:var(--ink-2);margin-bottom:4px">Pagamentos no arquivo — de qual fatura são?</div>
        <p class="tiny muted" style="margin:0 0 6px">Pagamento feito até o vencimento da fatura anterior (${dataBR(ant)}) quita a anterior; depois disso é antecipação desta.</p>
        <ul class="lista">${conc.pagamentos.map((x) => `<li><div class="desc"><b>${brl(-x.valor)}</b><small>${dataBR(x.data)}</small></div>
          <select class="inp" style="width:auto" data-iref="${x.idx}"><option value="${ant}" ${imp.refs[x.idx] === ant ? 'selected' : ''}>Anterior (${diaMes(ant)})</option><option value="${imp.venc}" ${imp.refs[x.idx] === imp.venc ? 'selected' : ''}>Esta (${diaMes(imp.venc)})</option></select></li>`).join('')}</ul></div>` : ''}
      <label class="campo"><span>Valor desta fatura no app do ${esc(cc.nome)} (para conferir)</span><input class="inp" inputmode="decimal" data-i="valorInformado" placeholder="opcional" value="${imp.valorInformado != null ? num(imp.valorInformado) : ''}"></label>
      ${dif != null ? (Math.abs(dif) < 0.01 ? '<div class="alerta ok small">Confere com o banco.</div>'
        : `<div class="alerta warn small"><div class="grow">Diferença de ${brl(dif)}. ${conc.alternativa ? 'Encontrei uma combinação de pagamentos que fecha o valor:' : (dif > 0 ? 'O banco mostra mais: pode haver compras depois da exportação do arquivo.' : 'O banco mostra menos: algum pagamento ou estorno pode ser desta fatura.')}</div>
          ${conc.alternativa && JSON.stringify(conc.alternativa) !== JSON.stringify(imp.refs) ? '<button class="btn sm" data-i-alt>Usar essa combinação</button>' : ''}</div>`) : ''}
      ${p.avisos?.length ? `<div class="alerta warn small">${p.avisos.map(esc).join('<br>')}</div>` : ''}
    </div>
    <div class="modal-f"><button class="btn" data-act="fechar-modal">Cancelar</button><button class="btn pri" data-i-ok>Importar</button></div>`;
    m._conc = conc;
  };
  abrirModal('', {
    aoMontar: (m) => {
      tela(m);
      m.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.i === 'cartao') imp.cartao = t.value;
        if (t.dataset.i === 'venc' && t.value) { imp.venc = t.value; imp.refs = { ...C.conciliar(p.linhas, cartao(imp.cartao), imp.venc, null).refs }; }
        if (t.dataset.i === 'valorInformado') { const v = parseValor(t.value); imp.valorInformado = Number.isFinite(v) ? v : null; }
        if (t.dataset.iref) imp.refs[t.dataset.iref] = t.value;
        tela(m);
      });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.hasAttribute('data-i-alt')) { imp.refs = { ...m._conc.alternativa }; tela(m); }
        if (b.hasAttribute('data-i-ok')) {
          const origem = p.banco === 'itau' ? 'pdf' : 'csv';
          let resumo;
          mutar((dd) => {
            const r = importarFatura(dd, { cartao: imp.cartao, venc: imp.venc, origem, linhas: p.linhas, refs: imp.refs, valorInformado: imp.valorInformado, totalDeclarado: p.totalDeclarado ?? null, proximas: p.proximas || null });
            Object.assign(dd, r.dados); resumo = r.resumo;
          }, `app: fatura ${cartao(imp.cartao).nome} ${imp.venc} importada`);
          S.fat = { cartao: imp.cartao, venc: imp.venc, filtro: 'todos' }; S.view = 'faturas'; render();
          abrirModal(`${cabecalhoModal('Fatura importada')}
            <ul class="lista"><li><div class="desc"><b>Novos lançamentos</b></div><div class="valor">${resumo.novas}</div></li>
            <li><div class="desc"><b>Já existiam (mantidos)</b></div><div class="valor">${resumo.mantidas}</div></li>
            <li><div class="desc"><b>Já com dono/divisão automática</b><small>parcela anterior, fixo ou regra</small></div><div class="valor">${resumo.herdadas + resumo.regras}</div></li>
            ${resumo.manuaisConciliadas ? `<li><div class="desc"><b>Lançados à mão e encontrados na fatura</b></div><div class="valor">${resumo.manuaisConciliadas}</div></li>` : ''}</ul>
            ${resumo.removidas.length ? `<div class="alerta warn small">${resumo.removidas.length} lançamento(s) da importação anterior não vieram desta vez e foram retirados: ${esc(resumo.removidas.map((l) => l.desc).join(', '))}.</div>` : ''}
            ${resumo.manuaisSobrando.length ? `<div class="alerta info small">${resumo.manuaisSobrando.length} lançamento(s) feitos à mão não apareceram no arquivo: ${esc(resumo.manuaisSobrando.map((l) => `${l.desc} ${brl(l.valor)}`).join(', '))}. Confira e apague se forem duplicados.</div>` : ''}
            <p class="small muted">Revise os lançamentos dos outros: toque em cada um para dizer de quem é.</p>
            <div class="modal-f"><button class="btn pri" data-act="fechar-modal">Ok</button></div>`);
        }
      });
    },
  });
}

// ======================= eventos globais =======================
const arquivo = document.getElementById('arquivo');
let cartaoImport = null;
arquivo.addEventListener('change', () => { const f = arquivo.files[0]; arquivo.value = ''; if (f) iniciarImport(f, cartaoImport); });

const ACOES = {
  nav: (a) => { S.view = a; if (a !== 'grupos') S.grupoSel = null; render(); window.scrollTo(0, 0); },
  'fechar-modal': () => fecharModal(),
  'recarregar-pagina': () => location.reload(),
  importar: (a) => { cartaoImport = a || null; arquivo.click(); },
  'novo-lanc': (a) => { const [cid, venc] = (a || '').split('|'); modalEditarLanc(null, { cartao: cid || undefined, venc: venc || undefined }); },
  'editar-lanc': (a) => modalEditarLanc(a),
  'apagar-lanc': (a) => { if (confirm('Apagar este pagamento registrado à mão?')) mutar((dd) => { dd.lancamentos = dd.lancamentos.filter((x) => x.id !== a); }, 'app: pagamento apagado'); },
  'ver-fatura': (a) => { const [c, v] = a.split('|'); S.fat = { cartao: c, venc: v, filtro: 'todos' }; S.view = 'faturas'; render(); window.scrollTo(0, 0); },
  'fat-cartao': (a) => { S.fat.cartao = a; S.fat.venc = null; render(); },
  'fat-filtro': (a) => { S.fat.filtro = a; S.manterScroll = true; render(); },
  'marcar-paga': (a) => {
    const [cid, venc] = a.split('|');
    const r = C.resumoFatura(S.dados, cid, venc, S.hoje);
    if (!confirm(`Registrar pagamento de ${brl(r.faltaPagar)} da fatura de ${dataBR(venc)}?`)) return;
    mutar((dd) => dd.lancamentos.push({ id: uid('l'), cartao: cid, venc, data: S.hoje, desc: 'Pagamento registrado no app', valor: -r.faltaPagar, tipo: 'pagamento', parcela: null, fixo: false, divisao: [], grupo: null, obs: '', origem: 'manual', refVenc: venc }), 'app: fatura marcada como paga');
  },
  'abrir-pessoa': (a) => { S.view = 'pessoas'; S.abertos.add(a); render(); document.getElementById('p-' + a)?.scrollIntoView({ block: 'start' }); },
  'toggle-pessoa': (a) => { S.abertos.has(a) ? S.abertos.delete(a) : S.abertos.add(a); S.manterScroll = true; render(); },
  'ver-pagos': (a) => { S.verPagos.add(a); S.manterScroll = true; render(); },
  cobrar: (a) => { const [p, c] = a.split('|'); modalCobrar(p, c); },
  'pessoa-form': (a) => modalPessoa(a),
  'grupo-form': (a) => modalGrupo(a),
  'grupo-abrir': (a) => { S.grupoSel = a; render(); window.scrollTo(0, 0); },
  'grupo-voltar': () => { S.grupoSel = null; render(); },
  'regra-nova': () => mutar((dd) => { dd.regras.push({ id: uid('r'), contem: 'texto da fatura', pessoa: EU, modo: 'inteiro', fixo: false }); }, 'app: regra criada'),
  'regra-apagar': (a) => mutar((dd) => { dd.regras = dd.regras.filter((r) => r.id !== a); }, 'app: regra apagada'),
  recarregar: async () => { fecharModal(); S.dados = null; await carregarDados(); toast('Dados recarregados.'); },
  'criar-dados': async () => { fecharModal(); S.store.sha = null; S.msgSalvar = 'app: dados.json criado'; await salvarAgora(); render(); },
  'conflito-github': async () => { fecharModal(); S.dados = null; await carregarDados(); },
  'conflito-local': async () => {
    fecharModal();
    try { const atual = await S.store.carregar(); void atual; } catch { /* segue */ }
    S.msgSalvar = 'app: mantidos os dados deste aparelho'; await salvarAgora();
  },
  backup: () => {
    const blob = new Blob([JSON.stringify(S.dados, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dados-cartoes-${S.hoje}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  bloquear: () => { S.store.bloquear(); S.dados = null; telaPin(); },
  sair: () => { if (confirm('Desconectar este aparelho? Você vai precisar do token de novo. Os dados no GitHub continuam lá.')) { S.store.sair(); S.dados = null; telaConfig(); } },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const f = ACOES[el.dataset.act]; if (!f) return;
  if (el.tagName === 'A') e.preventDefault();
  f(el.dataset.arg);
});

const MUDANCAS = {
  'fat-venc': (v) => { S.fat.venc = v; render(); },
  'valor-informado': (v) => {
    const n = parseValor(v);
    mutar((dd) => {
      dd.faturas ||= [];
      let f = dd.faturas.find((x) => x.cartao === S.fat.cartao && x.venc === S.fat.venc);
      if (!f) { f = { id: `${S.fat.cartao}-${S.fat.venc}`, cartao: S.fat.cartao, venc: S.fat.venc, origem: 'manual', valorInformado: null, totalDeclarado: null }; dd.faturas.push(f); }
      f.valorInformado = Number.isFinite(n) ? n : null;
    }, 'app: valor da fatura informado');
  },
  'ref-pag': (v, a) => mutar((dd) => { const l = dd.lancamentos.find((x) => x.id === a); if (l) l.refVenc = v; }, 'app: pagamento reclassificado'),
  'item-pago': (v, a, el) => {
    const it = C.itensAReceber(S.dados, S.hoje).find((x) => x.id === a); if (!it) return;
    S.manterScroll = true;
    if (it.tipo === 'grupo') { if (el.checked) marcarItensPagos([it]); return; }
    mutar((dd) => {
      const l = dd.lancamentos.find((x) => x.id === it.lancId);
      const dv = l?.divisao?.find((x) => x.pessoa === it.pessoa);
      if (dv) { dv.pago = el.checked; dv.pagoEm = el.checked ? S.hoje : null; }
    }, el.checked ? 'app: recebimento marcado' : 'app: recebimento desmarcado');
  },
  'grupo-pag': (v, a) => {
    const [gid, pid, ref] = a.split('|');
    const n = parseValor(v);
    S.manterScroll = true;
    mutar((dd) => {
      const g = dd.grupos.find((x) => x.id === gid);
      g.pagamentos = g.pagamentos.filter((x) => !(x.pessoa === pid && x.ref === ref));
      if (Number.isFinite(n) && n > 0) g.pagamentos.push({ id: uid('pg'), pessoa: pid, valor: round2(n), data: S.hoje, ref });
    }, 'app: pagamento do grupo');
  },
  cartao: (v, a, el) => {
    const [cid, campo] = a.split('|');
    S.manterScroll = true;
    mutar((dd) => {
      const c = dd.cartoes.find((x) => x.id === cid);
      if (campo.startsWith('pix.')) { c.pix ||= {}; c.pix[campo.slice(4)] = v.trim(); } else c[campo] = Math.min(31, Math.max(1, Number(v) || 1));
    }, 'app: cartão atualizado');
  },
  regra: (v, a, el) => {
    const [rid, campo] = a.split('|');
    S.manterScroll = true;
    mutar((dd) => { const r = dd.regras.find((x) => x.id === rid); if (r) r[campo] = el.type === 'checkbox' ? el.checked : v.trim(); }, 'app: regra atualizada');
  },
  'dias-cobranca': (v) => { S.manterScroll = true; mutar((dd) => { dd.config ||= {}; dd.config.diasAntesCobranca = Math.max(0, Math.min(10, Number(v) || 0)); }, 'app: dias de cobrança'); },
};
app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-chg]'); if (!el) return;
  const f = MUDANCAS[el.dataset.chg]; if (f) f(el.value, el.dataset.arg, el);
});
let resizeT; let larguraAnt = window.innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (Math.abs(window.innerWidth - larguraAnt) > 80 && S.dados && !document.querySelector('.modal')) { larguraAnt = window.innerWidth; S.manterScroll = true; render(); } }, 250); });
