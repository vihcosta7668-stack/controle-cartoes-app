import { Store, ErroConflito, CHAVES_COMPARTILHADO } from './store.js';
import {
  hoje as hojeISO, brl, num, dataBR, diaMes, mesCurto, difDias, addMeses, round2, cents, parseValor,
  detectaParcela, raizDesc, uid, slug, partes, ymd, diasNoMes,
} from './util.js';
import * as C from './calc.js';
import { parseNubankCSV, parsePDFFatura, lerPaginasPDF } from './parsers.js';
import * as PL from './planos.js';
import { importarFatura } from './importer.js';
import { esc, icon, toast, abrirModal, fecharModal, cabecalhoModal, chipCartao, graficoBarras, ligarGraficos } from './ui.js';

const EU = C.EU;
const S = {
  store: new Store(), dados: null, view: 'resumo', hoje: hojeISO(),
  fat: { cartao: null, venc: null, filtro: 'todos' }, abertos: new Set(), verPagos: new Set(), grupoSel: null,
  sync: 'ok', timer: null, msgSalvar: '', ocultoEm: null,
  // casa e viagens: arquivo compartilhado num repositório à parte, com token próprio (mesmo PIN)
  comp: { store: new Store(CHAVES_COMPARTILHADO), dados: null, sync: 'ok', timer: null, fila: [], msg: '', erro: '' },
  viagemSel: null,
};
const app = document.getElementById('app');

// ======================= inicialização =======================
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) S.ocultoEm = Date.now();
  else if (S.ocultoEm && Date.now() - S.ocultoEm > 10 * 60 * 1000 && S.store.desbloqueado) { S.store.bloquear(); S.comp.store.bloquear(); S.comp.dados = null; S.dados = null; fecharModal(); telaPin(); }
  else if (S.dados) { const h = hojeISO(); if (h !== S.hoje) { S.hoje = h; render(); } carregarComp(); }
});
window.addEventListener('online', () => { if (S.sync === 'pendente') salvarAgora(); if (S.comp.sync === 'pendente') salvarComp(); });

if (!S.store.configurado) telaConfig(); else telaPin();

// Cartões que o app sabe ler. Fechamento/vencimento são o ponto de partida; cada um ajusta em Ajustes.
const CARTOES_MODELO = {
  nubank: { id: 'nubank', nome: 'Nubank', fechamento: 11, vencimento: 18, cor: '#820ad1', pix: { chave: '', tipo: 'aleatoria', nome: '', cidade: '', banco: 'Nubank' } },
  itau: { id: 'itau', nome: 'Itaú', fechamento: 29, vencimento: 5, cor: '#ec7000', pix: { chave: '', tipo: 'aleatoria', nome: '', cidade: '', banco: 'Itaú' } },
  mercadopago: { id: 'mercadopago', nome: 'Mercado Pago', fechamento: 5, vencimento: 10, cor: '#00a6e0', pix: { chave: '', tipo: 'aleatoria', nome: '', cidade: '', banco: 'Mercado Pago' } },
};
const formatoFatura = (c) => (c.id === 'nubank' ? 'CSV' : 'PDF');
function dadosVazios(ids = ['nubank', 'itau']) {
  return {
    versao: 1, atualizadoEm: new Date().toISOString(),
    pessoas: [{ id: EU, nome: 'Eu', telefone: '' }],
    cartoes: ids.filter((id) => CARTOES_MODELO[id]).map((id) => structuredClone(CARTOES_MODELO[id])),
    regras: [], faturas: [], lancamentos: [], grupos: [], cobrancas: [], config: { diasAntesCobranca: 2 }, orcamento: null,
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
      <details class="small"${erro && /compartilhad|casa/i.test(erro) ? ' open' : ''}><summary class="muted">Casa e viagens (repositório compartilhado do casal — opcional)</summary>
        <p class="tiny muted">Fica numa organização do GitHub da qual vocês dois fazem parte. Use um token separado, criado com a organização como dono, só com esse repositório.</p>
        <div class="lado" style="margin-top:10px">
          <label class="campo"><span>Organização</span><input class="inp" name="comp_owner" autocapitalize="off" spellcheck="false"></label>
          <label class="campo"><span>Repositório</span><input class="inp" name="comp_repo" value="casa-viagens-dados" autocapitalize="off" spellcheck="false"></label>
        </div>
        <label class="campo"><span>Token da organização (github_pat_…)</span><input class="inp" name="comp_token" type="password" autocapitalize="off" spellcheck="false"></label>
        <label class="campo"><span>Seu nome (como o outro vai te ver)</span><input class="inp" name="comp_nome"></label>
      </details>
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
    try { await S.store.configurar(f); } catch (err) { S.store.sair(); return telaConfig(err.message); }
    if (f.comp_owner?.trim() || f.comp_token?.trim()) {
      try { await configurarComp({ owner: f.comp_owner, repo: f.comp_repo, token: f.comp_token, nome: f.comp_nome, pin: f.pin }); }
      catch (err) { S.store.sair(); S.comp.store.sair(); return telaConfig(`Casa e viagens: ${err.message}`); }
    }
    await carregarDados();
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
    try { await S.store.desbloquear(f.pin.value); } catch (err) { return telaPin(err.message); }
    if (S.comp.store.configurado) { try { await S.comp.store.desbloquear(f.pin.value); } catch { toast('Casa e viagens: o PIN deste aparelho não abriu o acesso compartilhado. Reconecte em Ajustes.', 5000); } }
    await carregarDados();
  });
  document.getElementById('b-esqueci').addEventListener('click', () => {
    if (confirm('Isso apaga o acesso salvo neste aparelho (os dados no GitHub não são afetados). Continuar?')) { S.store.sair(); S.comp.store.sair(); telaConfig(); }
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
      abrirModal(`${cabecalhoModal('Primeiro acesso')}<p>Não encontrei <b>${esc(S.store.cfg.path)}</b> no repositório. Vou criar um arquivo novo, vazio. Quais cartões você usa?</p>
        <div class="pilha">${Object.values(CARTOES_MODELO).map((c) => `<label class="check"><input type="checkbox" data-novo-cartao="${c.id}" ${c.id !== 'mercadopago' ? 'checked' : ''}> ${esc(c.nome)} <span class="tiny muted">(fatura em ${formatoFatura(c)})</span></label>`).join('')}</div>
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
  carregarComp();
}
function migrar(d) {
  d.cobrancas ||= []; d.grupos ||= []; d.regras ||= []; d.faturas ||= []; d.config ||= { diasAntesCobranca: 2 }; d.orcamento ??= null;
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
  const st = ['casa', 'viagens'].includes(S.view) && S.comp.store.configurado ? S.comp.sync : S.sync;
  const t = { ok: 'Salvo', salvando: 'Salvando…', pendente: 'Não enviado', erro: 'Sem sincronizar' }[st];
  el.className = 'sync ' + st; el.textContent = t;
}

// ======================= casa e viagens: sincronização =======================
// O arquivo compartilhado é editado pelos dois. Cada alteração é guardada como função (fila):
// se o outro salvou antes, o app baixa a versão nova, reaplica a fila e tenta de novo.
const euId = () => slug(S.comp.store.cfg?.eu || '');

async function configurarComp({ owner, repo, token, nome, pin }) {
  if (!String(nome || '').trim()) throw new Error('Informe seu nome.');
  if (!String(owner || '').trim() || !String(token || '').trim()) throw new Error('Informe a organização e o token.');
  await S.comp.store.configurar({ owner, repo: repo || 'casa-viagens-dados', path: 'compartilhado.json', token, pin, extra: { eu: String(nome).trim() } });
}

async function carregarComp({ forcar = false } = {}) {
  const c = S.comp; const st = c.store;
  if (!st.configurado || !st.desbloqueado) return;
  if (!forcar && (c.fila.length || c.sync === 'salvando' || c.sync === 'pendente')) return;
  if (!c.dados) {
    const cache = await st.lerCache();
    if (cache?.pendente) { c.dados = PL.migrarCompartilhado(cache.dados); st.sha = cache.sha; c.sync = 'pendente'; redesenhar(); salvarComp(); return; }
  }
  try {
    const { dados } = await st.carregar();
    c.erro = '';
    if (!dados) { // primeiro acesso: cria o arquivo com as etapas padrão da obra
      c.dados = PL.compartilhadoVazio(st.cfg.eu); st.sha = null; c.msg = 'app: compartilhado.json criado'; c.sync = 'salvando';
      redesenhar(); await salvarComp(); return;
    }
    const mudou = !c.dados || c.dados.atualizadoEm !== dados.atualizadoEm;
    c.dados = PL.migrarCompartilhado(dados); c.sync = 'ok';
    if (!PL.membroPorId(c.dados, euId())) mutarComp((dd) => { if (!PL.membroPorId(dd, euId())) dd.membros.push({ id: euId(), nome: st.cfg.eu }); }, 'app: novo membro');
    else if (mudou) redesenhar();
  } catch (err) {
    const cache = await st.lerCache();
    if (!c.dados && cache?.dados) { c.dados = PL.migrarCompartilhado(cache.dados); c.sync = 'erro'; }
    c.erro = err.message; redesenhar();
  }
}
function redesenhar() { if (S.dados && ['casa', 'viagens'].includes(S.view)) { S.manterScroll = true; render(); } else atualizarSync(); }

function mutarComp(fn, msg) {
  const c = S.comp;
  const novo = structuredClone(c.dados); fn(novo);
  c.dados = novo; c.fila.push(fn); c.msg = msg || 'app: atualização';
  c.sync = 'salvando'; S.manterScroll = true; render();
  clearTimeout(c.timer); c.timer = setTimeout(salvarComp, 700);
}
async function salvarComp() {
  const c = S.comp; clearTimeout(c.timer);
  if (c.emVoo) { c.denovo = true; return; } // um envio por vez; o próximo sai em seguida
  c.emVoo = true;
  try {
    for (let tentativa = 0; ; tentativa++) {
      c.denovo = false;
      const enviadas = c.fila.length;
      try {
        await c.store.salvar(c.dados, c.msg);
        c.fila = c.fila.slice(enviadas);
        c.sync = c.fila.length ? 'salvando' : 'ok';
        if (!c.fila.length && !c.denovo) break;
        continue; // houve alteração durante o envio
      } catch (err) {
        if (err instanceof ErroConflito && c.fila.length && tentativa < 4) {
          try {
            const { dados } = await c.store.carregar();
            const base = PL.migrarCompartilhado(dados || PL.compartilhadoVazio(c.store.cfg.eu));
            for (const fn of c.fila) fn(base);
            c.dados = base;
            continue;
          } catch { /* sem conexão: fica pendente */ }
        }
        if (err instanceof ErroConflito && !c.fila.length) { c.sync = 'erro'; resolverConflitoComp(); }
        else { c.sync = 'pendente'; await c.store.marcarPendente(c.dados); toast('Casa e viagens: não consegui salvar no GitHub. Fica guardado aqui e envio quando a conexão voltar.', 4000); }
        break;
      }
    }
  } finally { c.emVoo = false; }
  redesenhar();
}
function resolverConflitoComp() {
  abrirModal(`${cabecalhoModal('Casa e viagens mudaram em outro aparelho')}
    <p>Este aparelho tem alterações feitas sem internet, e o arquivo compartilhado também foi alterado (por você em outro aparelho ou pela outra pessoa).</p>
    <div class="modal-f"><button class="btn" data-act="comp-usar-github">Usar os do GitHub</button><button class="btn pri" data-act="comp-manter-local">Manter os daqui</button></div>
    <p class="tiny muted">"Usar os do GitHub" descarta o que foi feito aqui sem internet. "Manter os daqui" sobrescreve o que foi feito lá.</p>`);
}

// ======================= estrutura =======================
const NAV = [
  ['resumo', 'Resumo', 'home'], ['faturas', 'Faturas', 'card'], ['pessoas', 'Me devem', 'people'], ['grupos', 'Grupos', 'group'], ['futuro', 'Futuro', 'chart'],
  ['casa', 'Casa', 'obra'], ['viagens', 'Viagens', 'aviao'],
];
function render() {
  if (!S.dados) return;
  const cobr = C.cobrancasDevidas(S.dados, S.hoje, S.dados.config?.diasAntesCobranca ?? 2).length;
  const views = { resumo: vResumo, faturas: vFaturas, pessoas: vPessoas, grupos: vGrupos, futuro: vFuturo, casa: vCasa, viagens: vViagens, ajustes: vAjustes };
  const titulo = { resumo: 'Resumo', faturas: 'Faturas', pessoas: 'Me devem', grupos: 'Compras em grupo', futuro: 'Parcelas e próximos meses', casa: 'Nossa casa', viagens: 'Viagens', ajustes: 'Ajustes' }[S.view];
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
    <nav class="nav ${NAV.length > 5 ? 'n7' : ''}" style="--nav-n:${NAV.length}" aria-label="Menu">${NAV.map(navBtn).join('')}</nav>
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
    return `<div class="card vazio pilha"><p>Nenhuma fatura ainda. Importe a fatura (CSV do Nubank, PDF do Itaú ou do Mercado Pago) para começar.</p>
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
    return `<li class="click ${l.previsto || l.origem === 'previsto' ? 'previsto' : ''}" data-act="editar-lanc" data-arg="${esc(alvo)}${l.origem === 'projecao' ? '|proj' : ''}">
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
  <div class="row wrap"><button class="btn pri" data-act="importar" data-arg="${c.id}">${icon('upload')} Importar ${formatoFatura(c)}</button><button class="btn" data-act="novo-lanc" data-arg="${c.id}">${icon('plus')} Lançar compra</button></div>
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
    ${prev.length ? `<div class="sec-tit">Previsto — parcelas e fixos que devem cair</div>
      <p class="tiny muted" style="margin:0 0 4px">Já contam no total e em "Me devem". ${formatoFatura(c) === 'PDF' || (d.faturas || []).some((f) => f.cartao === c.id && f.origem === 'pdf') ? `Viram lançamentos quando você importar o PDF desta fatura (depois do fechamento em ${dataBR(r.fechamento)}).` : 'Viram lançamentos quando você importar o CSV de novo.'} Toque para dizer de quem é; gasto fixo dá para trocar de cartão ou cancelar.</p>
      <ul class="lista">${prev.map(linha).join('')}</ul>` : ''}
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
    const marcar = it.tipo === 'projecao'
      ? '<span class="check" style="width:20px" aria-hidden="true"></span>'
      : `<label class="check"><input type="checkbox" data-chg="item-pago" data-arg="${esc(it.id)}" ${it.pago ? 'checked' : ''} ${it.tipo === 'grupo' && it.pago ? 'disabled' : ''} aria-label="Pago"></label>`;
    return `<li class="${it.pago ? 'pago' : ''} ${it.tipo === 'projecao' ? 'previsto' : ''}">${marcar}
      <div class="desc"><b>${esc(it.desc)}</b><small>${esc(c?.nome || '')} · fatura ${diaMes(it.venc)}${it.previsto || it.tipo === 'projecao' ? ' · previsto' : ''}${it.pagoParcial > 0 && !it.pago ? ` · pagou ${brl(it.pagoParcial)}` : ''}</small></div>
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
    const futuros = [...p.itens.filter((i) => !i.pago && i.situacao === 'futuro'), ...p.projetados].sort((a, b) => a.venc.localeCompare(b.venc));
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
        ${futuros.length ? `<div class="sec-tit">Próximas faturas</div><ul class="lista">${futuros.slice(0, 8).map(itemLi).join('')}</ul>${futuros.length > 8 ? `<p class="tiny muted" style="margin:4px 0 0">+ ${futuros.length - 8} parcelas depois dessas.</p>` : ''}` : ''}
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
    <div class="card-h"><h2>Gastos fixos (todo mês)</h2><span class="small muted">${brl(fixos.reduce((s, f) => s + (f.l.valorPrevisto ?? f.l.valor), 0))}/mês · minha parte ${brl(fixos.reduce((s, f) => s + f.minha, 0))}</span></div>
    <ul class="lista">${fixos.map((f) => `<li class="click" data-act="editar-lanc" data-arg="${f.l.id}"><div class="desc"><b>${esc(f.l.desc)}</b><small>${esc(cartao(f.l.cartao).nome)} · último em ${diaMes(f.l.venc)}${f.outros.length ? ' · ' + esc(f.outros.map((o) => nome(o.pessoa)).join(', ')) : ''}</small></div><div class="valor">${brl(f.l.valorPrevisto ?? f.l.valor)}</div></li>`).join('') || '<li class="vazio">Nenhum gasto marcado como fixo.</li>'}</ul>
    <p class="tiny muted" style="margin:8px 0 0">Para marcar um gasto como fixo, abra o lançamento e ligue "Gasto fixo". Se uma fatura fechada vier sem ele, o app entende que foi cancelado.</p>
  </section>`;
}

// ======================= CASA e VIAGENS (compartilhado) =======================
function compIndisponivel() {
  const c = S.comp;
  if (!c.store.configurado) {
    return `<div class="card pilha"><h2>Casa e viagens ficam num arquivo do casal</h2>
      <p class="small" style="margin:6px 0 0">As faturas continuam só suas. Casa e viagens ficam num repositório à parte, que vocês dois acessam, cada um com o próprio token.</p>
      <button class="btn pri" data-act="nav" data-arg="ajustes">Conectar em Ajustes</button></div>`;
  }
  if (!c.store.desbloqueado) return '<div class="card vazio">O PIN deste aparelho não abriu o acesso a casa e viagens. Reconecte em Ajustes.</div>';
  if (!c.dados) {
    return c.erro ? `<div class="card pilha"><p class="erro-txt">${esc(c.erro)}</p><button class="btn" data-act="comp-recarregar">${icon('refresh')} Tentar de novo</button></div>`
      : '<div class="card vazio">Buscando casa e viagens…</div>';
  }
  return null;
}
const nomeM = (id) => PL.nomeMembro(S.comp.dados, id);
const atualizadoComp = () => `<div class="row wrap"><span class="tiny muted grow">Você está como <b>${esc(S.comp.store.cfg.eu)}</b>${S.comp.erro ? ` · <span class="erro-txt">${esc(S.comp.erro)}</span>` : ''}</span><button class="btn sm ghost" data-act="comp-recarregar">${icon('refresh')} Atualizar</button></div>`;

function vCasa() {
  const ind = compIndisponivel(); if (ind) return ind;
  const comp = S.comp.dados; const r = PL.resumoCasa(comp); const eu = euId();
  const pctPago = r.previstoTotal > 0 ? Math.min(1, r.pagoTotal / r.previstoTotal) : 0;
  const estadoTag = { concluida: '<span class="tag ok">concluída</span>', andamento: '<span class="tag info">em andamento</span>', apagar: '' };
  return `${atualizadoComp()}
  <div class="grid g4">
    <div class="card kpi"><div class="rot">Guardado (total)</div><div class="val">${brl(r.guardado)}</div><div class="sub">${r.saldos.map((x) => `${esc(x.membro.nome.split(' ')[0])} ${brl(x.valor)}`).join(' · ') || '—'}</div></div>
    <div class="card kpi"><div class="rot">Custo previsto da obra</div><div class="val">${brl(r.previstoTotal)}</div><div class="sub">${r.semPrevisto ? `${r.semPrevisto} etapa${r.semPrevisto > 1 ? 's' : ''} sem valor` : 'todas as etapas com valor'}</div></div>
    <div class="card kpi"><div class="rot">Já pago</div><div class="val">${brl(r.pagoTotal)}</div><div class="sub">${r.previstoTotal > 0 ? `${Math.round(pctPago * 100)}% do previsto` : ''}</div></div>
    <div class="card kpi"><div class="rot">Falta pagar</div><div class="val">${brl(r.faltaTotal)}</div><div class="sub">${r.faltaTotal > 0 ? (r.guardado >= r.faltaTotal ? 'o guardado cobre' : `faltam ${brl(r.faltaTotal - r.guardado)} além do guardado`) : ''}</div></div>
  </div>
  <section class="card">
    <div class="card-h"><h2>Quanto cada um tem guardado</h2><button class="btn sm pri" data-act="casa-saldo">Atualizar meu saldo</button></div>
    <div class="barra" style="margin-bottom:8px">${r.saldos.map((x, i) => (r.guardado > 0 ? `<span class="${i ? 'o' : 'm'}" style="width:${(x.valor / r.guardado) * 100}%"></span>` : '')).join('')}</div>
    <div class="membros">${r.saldos.map((x, i) => `<div class="card plano" style="background:var(--surface-2)">
      <div class="spread"><b style="color:var(${i ? '--s-outros' : '--s-minha'})">${esc(x.membro.nome)}${x.membro.id === eu ? ' <span class="tag">você</span>' : ''}</b><span class="num" style="font-size:19px;font-weight:680">${brl(x.valor)}</span></div>
      <div class="tiny muted" style="margin-top:4px">${x.data ? `informado em ${dataBR(x.data)}` : 'ainda não informou'}${r.guardado > 0 ? ` · ${Math.round((x.valor / r.guardado) * 100)}% do total` : ''}</div>
      ${x.variacao != null ? `<div class="small" style="margin-top:4px">${x.variacao >= 0 ? 'guardou' : 'saiu'} <b>${brl(Math.abs(x.variacao))}</b> desde ${dataBR(x.anterior.data)}</div>` : ''}
    </div>`).join('')}</div>
    ${r.saldos.length < 2 ? `<div class="row wrap" style="margin-top:10px"><span class="tiny muted grow">A outra pessoa aparece aqui quando conectar o app ao mesmo repositório. Pode cadastrar o nome antes, para já dividir gastos.</span><button class="btn sm" data-act="membro-add">${icon('plus')} Outra pessoa</button></div>` : ''}
    <p class="tiny muted" style="margin:10px 0 0">Cada um guarda na própria conta e informa aqui o saldo atual. Depois de pagar uma etapa, atualize o saldo de quem pagou.</p>
  </section>
  ${r.faltaTotal > 0 ? `<div class="alerta ${r.proxima ? 'info' : 'ok'}"><div class="grow">${r.cobertas.length ? `O guardado cobre ${r.cobertas.map((x) => esc(x.e.nome)).join(', ')}.` : ''}
    ${r.proxima ? ` Para fechar <b>${esc(r.proxima.e.nome)}</b> faltam <b>${brl(r.proxima.faltaParaCobrir)}</b>.` : ` Ainda sobram ${brl(r.sobraDepois)}.`}</div></div>` : ''}
  <section class="card">
    <div class="card-h"><h2>Etapas da obra</h2><button class="btn sm" data-act="casa-etapa">${icon('plus')} Etapa</button></div>
    <ul class="lista">${r.etapas.map((x) => `<li class="click" data-act="casa-etapa" data-arg="${x.e.id}">
      <div class="desc"><b>${esc(x.e.nome)}</b><small>${x.estado === 'andamento' ? 'em andamento · ' : ''}${x.previsto == null ? 'sem valor previsto' : `previsto ${brl(x.previsto)}`}${x.pago > 0 ? ` · pago ${brl(x.pago)}` : ''}${x.estouro ? ` · passou ${brl(x.estouro)}` : ''}</small>
        ${x.previsto ? `<div class="barra" style="height:6px;margin-top:6px;max-width:260px"><span class="${x.estouro ? 'b' : 'p'}" style="width:${Math.min(100, (x.pago / x.previsto) * 100)}%"></span></div>` : ''}</div>
      ${x.estado === 'concluida' ? estadoTag.concluida : ''}<div class="valor">${x.falta > 0 ? brl(x.falta) : ''}${x.falta > 0 ? '<small>falta</small>' : ''}</div></li>`).join('') || '<li class="vazio">Nenhuma etapa.</li>'}</ul>
    <p class="tiny muted" style="margin:8px 0 0">Toque na etapa para pôr o valor previsto e registrar os pagamentos.</p>
  </section>
  ${comp.casa.saldos.length ? `<section class="card"><div class="card-h"><h2>Histórico dos saldos</h2></div>
    <ul class="lista">${[...comp.casa.saldos].sort((a, b) => b.data.localeCompare(a.data) || (b.em || '').localeCompare(a.em || '')).slice(0, 12).map((x) => `<li><div class="desc"><b>${esc(nomeM(x.membro))}</b><small>${dataBR(x.data)}</small></div><div class="valor">${brl(x.valor)}</div>
      ${x.membro === eu ? `<button class="btn sm ghost perigo" data-act="casa-saldo-apagar" data-arg="${x.id}" aria-label="Apagar registro">${icon('x')}</button>` : ''}</li>`).join('')}</ul></section>` : ''}`;
}

function vViagens() {
  const ind = compIndisponivel(); if (ind) return ind;
  const comp = S.comp.dados;
  const v = S.viagemSel && comp.viagens.find((x) => x.id === S.viagemSel);
  if (v) return vViagem(v);
  const via = PL.viabilidade(comp, euId(), S.dados, S.hoje);
  return `${atualizadoComp()}
  <div class="row"><button class="btn pri" data-act="viagem-form">${icon('plus')} Nova viagem</button></div>
  ${comp.membros.length < 2 ? `<div class="alerta info"><div class="grow small">Para dividir gastos, a outra pessoa precisa estar cadastrada. Ela entra sozinha quando conectar o app; se quiser, cadastre o nome agora.</div><button class="btn sm" data-act="membro-add">${icon('plus')} Outra pessoa</button></div>` : ''}
  ${comp.viagens.length ? '' : '<div class="card vazio">Nenhuma viagem ainda. Crie uma, defina o limite e vá lançando os gastos previstos.</div>'}
  ${[...comp.viagens].sort((a, b) => (a.ida || '9').localeCompare(b.ida || '9')).map((x) => {
    const r = PL.resumoViagem(comp, x);
    const meu = via.semRenda ? null : vereditoViagem(via, x);
    return `<section class="card click" data-act="viagem-abrir" data-arg="${x.id}" style="cursor:pointer">
      <div class="card-h"><h2>${esc(x.nome)}</h2>${meu ? `<span class="tag ${meu.estado}">${meu.rotulo}</span>` : ''}</div>
      <div class="small muted" style="margin:-6px 0 10px">${[x.destino, x.ida ? `${dataBR(x.ida)}${x.volta ? ' a ' + dataBR(x.volta) : ''}` : null].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="grid g3m">
        <div><div class="tiny muted">Limite</div><div class="num" style="font-weight:680">${r.limite ? brl(r.limite) : '—'}</div></div>
        <div><div class="tiny muted">Planejado</div><div class="num" style="font-weight:680">${brl(r.total)}</div></div>
        <div><div class="tiny muted">Ainda pode gastar</div><div class="num" style="font-weight:680;${r.disponivel < 0 ? 'color:var(--bad)' : ''}">${r.limite ? brl(r.disponivel) : '—'}</div></div>
      </div>
      ${r.limite ? `<div class="barra" style="margin-top:12px"><span class="${r.pct > 1 ? 'b' : r.pct > 0.9 ? 'w' : 'p'}" style="width:${Math.min(100, r.pct * 100)}%"></span></div>` : ''}
    </section>`;
  }).join('')}`;
}

// Veredito pessoal de uma viagem: o pior mês entre os meses em que ela tira dinheiro de mim.
function vereditoViagem(via, v) {
  const meses = new Set([...via.porMesViagem.keys()].filter((k) => k.endsWith('|' + v.id)).map((k) => k.split('|')[0]));
  const linhas = via.linhas.filter((l) => meses.has(l.mes));
  if (!linhas.length) return { estado: 'ok', rotulo: 'nada a pagar por você', pior: null };
  const pior = linhas.reduce((a, b) => (b.sobra < a.sobra ? b : a));
  const rot = { ok: 'cabe no seu orçamento', warn: 'aperta seu orçamento', bad: 'não cabe no seu orçamento' };
  return { estado: pior.estado, rotulo: rot[pior.estado], pior };
}

function vViagem(v) {
  const comp = S.comp.dados; const eu = euId();
  const r = PL.resumoViagem(comp, v);
  const via = PL.viabilidade(comp, eu, S.dados, S.hoje);
  const forma = (i) => (i.forma === 'cartao' ? `cartão${i.pagador === eu && i.cartao && cartao(i.cartao) ? ' ' + cartao(i.cartao).nome : ''}${Number(i.parcelas) > 1 ? ` ${i.parcelas}x` : ' à vista'}` : 'Pix/débito/dinheiro');
  const divisao = (i) => { const p = Number(i.parteOutro || 0); const o = PL.outroMembro(comp, i.pagador); return p > 0 && o ? (Math.abs(p - 0.5) < 0.001 ? `meio a meio com ${o.nome.split(' ')[0]}` : `${Math.round(p * 100)}% de ${o.nome.split(' ')[0]}`) : 'sem dividir'; };
  const cats = [...new Set([...PL.CATEGORIAS_VIAGEM.filter((c) => r.porCategoria.has(c)), ...[...r.porCategoria.keys()]])];
  let painel;
  if (via.semRenda) painel = `<div class="alerta info"><div class="grow">Para saber se a viagem cabe no seu bolso, informe sua renda e suas contas fixas em Ajustes. Só você vê esses números.</div><button class="btn sm" data-act="nav" data-arg="ajustes">Ajustes</button></div>`;
  else {
    const ver = vereditoViagem(via, v);
    const meses = via.linhas.filter((l) => l.viagens > 0 || l.estado !== 'ok').slice(0, 12);
    const txt = !ver.pior ? 'Nenhum gasto desta viagem está com você.'
      : ver.estado === 'ok' ? `No mês mais apertado (${mesCurto(ver.pior.mes + '-01')}) ainda sobram ${brl(ver.pior.sobra)}.`
        : ver.estado === 'warn' ? `Em ${mesCurto(ver.pior.mes + '-01')} sobram só ${brl(ver.pior.sobra)}, abaixo da sua margem de ${brl(via.margem)}.`
          : `Em ${mesCurto(ver.pior.mes + '-01')} faltam ${brl(-ver.pior.sobra)}.`;
    painel = `<div class="veredito ${ver.estado}"><div class="grow"><b class="t">${ver.rotulo[0].toUpperCase() + ver.rotulo.slice(1)}</b><span class="small">${txt}</span></div></div>
      <div class="tabela-wrap" style="margin-top:12px"><table class="t">
        <thead><tr><th>Mês</th><th class="n">Renda</th><th class="n">Contas + casa</th><th class="n">Faturas (sua parte)</th><th class="n">Viagens</th><th class="n">Sobra</th></tr></thead>
        <tbody>${meses.map((l) => `<tr class="${l.estado}"><td>${mesCurto(l.mes + '-01')}</td><td class="n">${num(l.renda)}</td><td class="n">${num(l.contas + l.casa)}</td><td class="n">${num(l.faturas)}</td><td class="n">${num(l.viagens)}</td><td class="n sobra">${num(l.sobra)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="tiny muted" style="margin:8px 0 0">Faturas = parcelas e gastos fixos já conhecidos dos seus cartões, pelo mês do vencimento. Viagens = gastos ainda não comprados de todas as viagens, na sua parte. Só você vê esta tabela.</p>`;
  }
  return `
  <div class="row wrap"><button class="btn sm ghost" data-act="viagem-voltar">← Viagens</button><div class="grow"></div><button class="btn sm ghost" data-act="comp-recarregar">${icon('refresh')} Atualizar</button><button class="btn sm" data-act="viagem-form" data-arg="${v.id}">Editar</button></div>
  <section class="card">
    <div class="card-h"><h2>${esc(v.nome)}</h2><span class="small muted">${[v.destino, v.ida ? `${dataBR(v.ida)}${v.volta ? ' a ' + dataBR(v.volta) : ''}` : null].filter(Boolean).map(esc).join(' · ')}</span></div>
    <div class="grid g4">
      <div><div class="tiny muted">Limite</div><div class="num" style="font-size:20px;font-weight:680">${r.limite ? brl(r.limite) : '—'}</div></div>
      <div><div class="tiny muted">Planejado</div><div class="num" style="font-size:20px;font-weight:680">${brl(r.total)}</div></div>
      <div><div class="tiny muted">Ainda pode gastar</div><div class="num" style="font-size:20px;font-weight:680;${r.disponivel < 0 ? 'color:var(--bad)' : ''}">${r.limite ? brl(r.disponivel) : '—'}</div></div>
      <div><div class="tiny muted">Já comprado</div><div class="num" style="font-size:20px;font-weight:680">${brl(r.comprado)}</div></div>
    </div>
    ${r.limite ? `<div class="barra" style="margin-top:12px"><span class="${r.pct > 1 ? 'b' : r.pct > 0.9 ? 'w' : 'p'}" style="width:${Math.min(100, r.pct * 100)}%"></span></div>` : ''}
    ${r.disponivel < 0 && r.limite ? `<div class="alerta bad small" style="margin-top:12px">O planejado passou ${brl(-r.disponivel)} do limite.</div>` : ''}
    <div class="small" style="margin-top:12px">${comp.membros.map((m) => `${esc(m.nome.split(' ')[0])}: <b>${brl(r.porMembro[m.id] || 0)}</b>`).join(' · ')}</div>
  </section>
  <section class="card"><div class="card-h"><h2>Cabe no seu bolso?</h2></div>${painel}</section>
  <section class="card">
    <div class="card-h"><h2>Gastos</h2><button class="btn sm pri" data-act="item-form" data-arg="${v.id}">${icon('plus')} Gasto</button></div>
    ${cats.map((c) => `<div class="sec-tit">${esc(c)} · ${brl(r.porCategoria.get(c))}</div>
      <ul class="lista">${v.itens.filter((i) => i.categoria === c).map((i) => `<li class="click" data-act="item-form" data-arg="${v.id}|${i.id}">
        <div class="desc"><b>${esc(i.desc || i.categoria)}</b><small>${esc(nomeM(i.pagador).split(' ')[0])} paga · ${esc(forma(i))} · ${esc(divisao(i))}${i.data ? ` · ${dataBR(i.data)}` : ''}</small></div>
        ${i.status === 'comprado' ? '<span class="tag ok">comprado</span>' : '<span class="tag">previsto</span>'}<div class="valor">${brl(i.valor)}</div></li>`).join('')}</ul>`).join('') || '<p class="vazio">Nenhum gasto ainda.</p>'}
    ${r.semEstimativa.length ? `<div class="sec-tit">Ainda sem estimativa</div><div class="chips">${r.semEstimativa.map((c) => `<button data-act="item-form" data-arg="${v.id}||${esc(c)}">${icon('plus')} ${esc(c)}</button>`).join('')}</div>` : ''}
  </section>`;
}

// ======================= AJUSTES =======================
function vAjustes() {
  const d = S.dados; const cfg = S.store.cfg || {};
  const tiposPix = [['cpf', 'CPF'], ['cnpj', 'CNPJ'], ['telefone', 'Telefone'], ['email', 'E-mail'], ['aleatoria', 'Aleatória']];
  const orc = d.orcamento || {};
  const cc = S.comp.store;
  const faltando = Object.values(CARTOES_MODELO).filter((m) => !d.cartoes.some((c) => c.id === m.id));
  return `
  <section class="card form">
    <h2>Renda e compromissos <span class="tag">só você vê</span></h2>
    <p class="small muted" style="margin:0">Usados para dizer se uma viagem ou compra parcelada cabe no seu mês. Ficam no seu repositório, não no do casal.</p>
    <div class="lado"><label class="campo"><span>Renda líquida por mês (R$)</span><input class="inp" inputmode="decimal" data-chg="orc" data-arg="renda" value="${orc.renda ? num(orc.renda) : ''}"></label>
    <label class="campo"><span>Contas fixas fora do cartão (R$/mês)</span><input class="inp" inputmode="decimal" data-chg="orc" data-arg="compromissos" value="${orc.compromissos ? num(orc.compromissos) : ''}" placeholder="aluguel, luz, internet…"></label></div>
    <div class="lado"><label class="campo"><span>Quanto separa para a casa (R$/mês)</span><input class="inp" inputmode="decimal" data-chg="orc" data-arg="guardarCasa" value="${orc.guardarCasa ? num(orc.guardarCasa) : ''}"></label>
    <label class="campo"><span>Margem de segurança (% da renda)</span><input class="inp" type="number" min="0" max="80" data-chg="orc" data-arg="margem" value="${Math.round((orc.margem ?? 0.1) * 100)}"></label></div>
    <p class="tiny muted" style="margin:0">Mês com sobra abaixo da margem aparece em amarelo; sobra negativa, em vermelho. As faturas entram pela sua parte (o que outras pessoas te devolvem não conta como gasto seu).</p>
  </section>
  <section class="card pilha">
    <h2>Casa e viagens (compartilhado)</h2>
    ${cc.configurado ? `<p class="small" style="margin:6px 0 0">Conectado a <b>${esc(cc.cfg.owner)}/${esc(cc.cfg.repo)}</b> como <b>${esc(cc.cfg.eu)}</b>.${S.comp.erro ? ` <span class="erro-txt">${esc(S.comp.erro)}</span>` : ''}</p>
      <div class="row wrap"><button class="btn" data-act="comp-recarregar">${icon('refresh')} Atualizar agora</button><button class="btn perigo" data-act="comp-sair">Desconectar casa e viagens</button></div>`
    : `<p class="small muted" style="margin:6px 0 0">Para os dois verem e editarem casa e viagens, o arquivo fica num repositório de uma organização do GitHub da qual vocês dois fazem parte. Cada um usa o próprio token, com a organização como dono e só esse repositório (Contents: Read and write).</p>
      <form class="form" id="f-comp" autocomplete="off">
        <div class="lado"><label class="campo"><span>Organização</span><input class="inp" name="owner" required autocapitalize="off" spellcheck="false"></label>
        <label class="campo"><span>Repositório (privado)</span><input class="inp" name="repo" required value="casa-viagens-dados" autocapitalize="off" spellcheck="false"></label></div>
        <label class="campo"><span>Token da organização (github_pat_…)</span><input class="inp" name="token" type="password" required autocapitalize="off" spellcheck="false"></label>
        <div class="lado"><label class="campo"><span>Seu nome</span><input class="inp" name="nome" required></label>
        <label class="campo"><span>PIN deste aparelho</span><input class="inp" name="pin" type="password" inputmode="numeric" required></label></div>
        <button class="btn pri" type="submit">Conectar</button>
      </form>`}
  </section>
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
      ${d.cartoes.length > 1 && !d.lancamentos.some((l) => l.cartao === c.id) ? `<div><button class="btn sm ghost perigo" data-act="cartao-remover" data-arg="${c.id}">Remover ${esc(c.nome)}</button></div>` : ''}
    </div>`).join('')}
    ${faltando.length ? `<div class="row wrap">${faltando.map((m) => `<button class="btn sm" data-act="cartao-add" data-arg="${m.id}">${icon('plus')} ${esc(m.nome)}</button>`).join('')}<span class="tiny muted">confira o dia de fechamento e vencimento depois de adicionar</span></div>` : ''}
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
  // outras parcelas da mesma compra (mesmo cartão, descrição, nº de parcelas e mês de início)
  const inicio = (x) => addMeses(x.venc, -x.parcela.n).slice(0, 7);
  const cadeia = l?.parcela ? d.lancamentos.filter((x) => x.id !== l.id && x.cartao === l.cartao && x.parcela && x.parcela.total === l.parcela.total
    && raizDesc(x.desc) === raizDesc(l.desc) && inicio(x) === inicio(l)) : [];
  ed.todasParcelas = cadeia.length > 0;
  ed.fxValor = l ? (l.valorPrevisto ?? l.valor) : ''; ed.fxCartao = l?.cartao || cid; ed.fxCancelado = !!l?.fixoEncerrado;
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
      if (preset.daProjecao) corpo += `<div class="alerta info small">A previsão vem deste lançamento de ${dataBR(l.venc)}. Mudar "De quem é" aqui vale para ele e para os próximos meses.</div>`;
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
      if (cadeia.length && ed.modo !== 'grupo') {
        corpo += `<label class="check small"><input type="checkbox" data-e="todasParcelas" ${ed.todasParcelas ? 'checked' : ''}> Aplicar essa divisão a todas as parcelas desta compra (${cadeia.length + 1} no app)</label>
          <p class="tiny muted" style="margin:-6px 0 0">As parcelas que ainda vão vir seguem a mesma divisão sozinhas.</p>`;
      }
      corpo += `<label class="check"><input type="checkbox" data-e="fixo" ${ed.fixo ? 'checked' : ''}> Gasto fixo (vem todo mês)</label>`;
      if (!ed.novo && ed.fixo && !l.parcela) {
        const mudou = ed.fxCartao !== l.cartao;
        const nc = cartao(ed.fxCartao);
        corpo += `<div class="card plano form" style="background:var(--surface-2)">
          <div class="small" style="font-weight:600">Próximos meses</div>
          <div class="lado"><label class="campo"><span>Valor previsto (R$)</span><input class="inp" inputmode="decimal" data-e="fxValor" value="${esc(typeof ed.fxValor === 'number' ? num(ed.fxValor) : ed.fxValor)}" ${ed.fxCancelado ? 'disabled' : ''}></label>
          <label class="campo"><span>Vem em qual cartão</span><select class="inp" data-e="fxCartao" ${ed.fxCancelado ? 'disabled' : ''}>${d.cartoes.map((c) => `<option value="${c.id}" ${c.id === ed.fxCartao ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label></div>
          ${mudou && !ed.fxCancelado ? `<p class="tiny" style="margin:0">Para de ser previsto no ${esc(cartao(l.cartao).nome)} e entra como previsto no ${esc(nc.nome)} a partir da fatura de ${dataBR(C.faturaAberta(nc, S.hoje))}.</p>` : ''}
          <label class="check small"><input type="checkbox" data-e="fxCancelado" ${ed.fxCancelado ? 'checked' : ''}> Não vem mais (cancelei)</label>
        </div>`;
      }
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
          return !['desc', 'valor', 'obs', 'fxValor'].includes(k);
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
      if (ed.todasParcelas && cadeia.length) {
        for (const c of cadeia) {
          const x = dd.lancamentos.find((y) => y.id === c.id); if (!x) continue;
          x.grupo = grupo;
          x.divisao = grupo ? [] : divisao.map((p) => {
            const antes = (x.divisao || []).find((y) => y.pessoa === p.pessoa);
            return { pessoa: p.pessoa, valor: round2(p.valor * (x.valor / valor)), pago: !!antes?.pago, pagoEm: antes?.pagoEm || null };
          });
        }
      }
      if (!ed.novo && alvo.fixo && !alvo.parcela) {
        const vp = parseValor(ed.fxValor);
        if (Number.isFinite(vp) && cents(vp) !== cents(alvo.valor)) alvo.valorPrevisto = round2(vp); else delete alvo.valorPrevisto;
        if (ed.fxCancelado) alvo.fixoEncerrado = true;
        else if (ed.fxCartao !== alvo.cartao) {
          alvo.fixoEncerrado = true;
          const nc = dd.cartoes.find((c) => c.id === ed.fxCartao);
          const ab = C.faturaAberta(nc, S.hoje);
          // mesma data do mês da cobrança antiga, dentro do ciclo da fatura aberta do novo cartão
          const dia = alvo.data ? partes(alvo.data).d : partes(S.hoje).d;
          let data = S.hoje;
          for (const k of [-1, 0, -2, 1]) {
            const ref = partes(addMeses(ab.slice(0, 7) + '-01', k));
            const cand = ymd(ref.y, ref.m, Math.min(dia, diasNoMes(ref.y, ref.m)));
            if (C.vencDaCompra(nc, cand) === ab) { data = cand; break; }
          }
          const v = alvo.valorPrevisto ?? alvo.valor;
          dd.lancamentos.push({
            id: uid('l'), cartao: nc.id, venc: ab, data, desc: alvo.desc, valor: v, tipo: 'compra', parcela: null, fixo: true,
            divisao: (alvo.divisao || []).map((p) => ({ pessoa: p.pessoa, valor: round2(p.valor * (v / alvo.valor)), pago: false, pagoEm: null })),
            grupo: null, obs: `Mudou do ${cartao(alvo.cartao).nome}`, origem: 'previsto', refVenc: null,
          });
        } else delete alvo.fixoEncerrado;
      }
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

// ---------- casa e viagens: modais ----------
const valorInp = (v) => (v == null || v === '' ? '' : (typeof v === 'number' ? num(v) : esc(v)));
// Valor digitado: "80.000" é oitenta mil (ponto de milhar), "1.234,56" e "34,9" também valem.
const lerNum = (v) => {
  const t = String(v ?? '').trim().replace(/^R\$\s*/i, '');
  const n = parseValor(/^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t);
  return Number.isFinite(n) ? round2(n) : null;
};

function modalSaldo() {
  const eu = euId();
  const atual = PL.saldosPorMembro(S.comp.dados).find((x) => x.membro.id === eu);
  abrirModal(`${cabecalhoModal('Meu saldo para a casa')}
    <form class="form" id="f-saldo">
      <p class="small muted" style="margin:0">Quanto você tem guardado hoje para a casa, na sua conta.${atual?.data ? ` Último informado: ${brl(atual.valor)} em ${dataBR(atual.data)}.` : ''}</p>
      <div class="lado"><label class="campo"><span>Saldo (R$)</span><input class="inp" name="valor" inputmode="decimal" required autofocus></label>
      <label class="campo"><span>Data</span><input class="inp" type="date" name="data" value="${S.hoje}" required></label></div>
      <div class="modal-f"><button type="button" class="btn" data-act="fechar-modal">Cancelar</button><button class="btn pri" type="submit">Salvar</button></div>
    </form>`, {
    aoMontar: (m) => m.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const valor = lerNum(f.valor);
      if (valor == null || valor < 0) return toast('Informe o saldo.');
      const reg = { id: uid('s'), membro: eu, data: f.data || S.hoje, valor, em: new Date().toISOString() };
      mutarComp((dd) => { if (!dd.casa.saldos.some((x) => x.id === reg.id)) dd.casa.saldos.push(reg); }, 'app: saldo da casa');
      fecharModal();
    }),
  });
}

function modalEtapa(id) {
  const comp = S.comp.dados; const eu = euId();
  const orig = id ? comp.casa.etapas.find((x) => x.id === id) : null;
  const ed = orig ? structuredClone(orig) : { id: uid('e'), nome: '', previsto: null, concluida: false, pagamentos: [] };
  ed.previstoTxt = ed.previsto == null ? '' : num(ed.previsto);
  const novoPag = { data: S.hoje, valor: '', desc: '', quem: eu };
  const tela = (m) => {
    const pago = PL.pagoEtapa(ed);
    m.innerHTML = `${cabecalhoModal(orig ? 'Etapa da obra' : 'Nova etapa')}
    <div class="form">
      <label class="campo"><span>Nome</span><input class="inp" data-t="nome" value="${esc(ed.nome)}" placeholder="ex.: Fundação (radier)"></label>
      <div class="lado"><label class="campo"><span>Valor previsto (R$)</span><input class="inp" inputmode="decimal" data-t="previstoTxt" value="${esc(ed.previstoTxt)}" placeholder="orçamento da etapa"></label>
      <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" data-t="concluida" ${ed.concluida ? 'checked' : ''}> Etapa concluída</label></div>
      <div><div class="small" style="font-weight:600;margin-bottom:4px">Pagamentos · ${brl(pago)}</div>
        <ul class="lista">${ed.pagamentos.map((p, i) => `<li><div class="desc"><b>${brl(p.valor)}</b><small>${dataBR(p.data)} · ${esc(nomeM(p.quem))}${p.desc ? ' · ' + esc(p.desc) : ''}</small></div><button type="button" class="btn sm ghost perigo" data-t-rem="${i}" aria-label="Remover pagamento">${icon('x')}</button></li>`).join('') || '<li class="vazio">Nenhum pagamento registrado.</li>'}</ul>
        <div class="card plano form" style="background:var(--surface-2);margin-top:8px">
          <div class="lado"><label class="campo"><span>Valor pago (R$)</span><input class="inp" inputmode="decimal" data-p="valor" value="${esc(novoPag.valor)}"></label>
          <label class="campo"><span>Data</span><input class="inp" type="date" data-p="data" value="${novoPag.data}"></label></div>
          <div class="lado"><label class="campo"><span>Quem pagou</span><select class="inp" data-p="quem">${comp.membros.map((x) => `<option value="${x.id}" ${x.id === novoPag.quem ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
          <label class="campo"><span>Descrição</span><input class="inp" data-p="desc" value="${esc(novoPag.desc)}" placeholder="ex.: entrada, sinal"></label></div>
          <button type="button" class="btn sm" data-t-add>${icon('plus')} Adicionar pagamento</button>
        </div>
      </div>
    </div>
    <div class="modal-f">${orig ? `<button type="button" class="btn perigo" data-t-apagar>Apagar etapa</button><button type="button" class="btn sm ghost" data-t-mover="-1" aria-label="Subir">↑</button><button type="button" class="btn sm ghost" data-t-mover="1" aria-label="Descer">↓</button>` : ''}<div class="grow"></div><button type="button" class="btn" data-act="fechar-modal">Cancelar</button><button type="button" class="btn pri" data-t-salvar>Salvar</button></div>`;
  };
  abrirModal('', {
    aoMontar: (m) => {
      tela(m);
      m.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.t) ed[t.dataset.t] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.dataset.p) novoPag[t.dataset.p] = t.value;
      });
      m.addEventListener('change', (e) => { const t = e.target; if (t.dataset.t === 'concluida') ed.concluida = t.checked; if (t.dataset.p) novoPag[t.dataset.p] = t.value; });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.tRem != null) { ed.pagamentos.splice(Number(b.dataset.tRem), 1); tela(m); }
        if (b.hasAttribute('data-t-add')) {
          const v = lerNum(novoPag.valor);
          if (!v || v <= 0) return toast('Informe o valor pago.');
          ed.pagamentos.push({ id: uid('pg'), data: novoPag.data || S.hoje, valor: v, desc: novoPag.desc.trim(), quem: novoPag.quem });
          novoPag.valor = ''; novoPag.desc = ''; tela(m);
        }
        if (b.hasAttribute('data-t-apagar') && confirm(`Apagar a etapa "${ed.nome}" e os pagamentos dela?`)) {
          mutarComp((dd) => { dd.casa.etapas = dd.casa.etapas.filter((x) => x.id !== ed.id); }, 'app: etapa apagada'); fecharModal();
        }
        if (b.dataset.tMover) {
          const passo = Number(b.dataset.tMover);
          mutarComp((dd) => {
            const i = dd.casa.etapas.findIndex((x) => x.id === ed.id); const j = i + passo;
            if (i < 0 || j < 0 || j >= dd.casa.etapas.length) return;
            [dd.casa.etapas[i], dd.casa.etapas[j]] = [dd.casa.etapas[j], dd.casa.etapas[i]];
          }, 'app: etapa reordenada');
        }
        if (b.hasAttribute('data-t-salvar')) {
          if (!ed.nome.trim()) return toast('Dê um nome à etapa.');
          const previsto = String(ed.previstoTxt).trim() ? lerNum(ed.previstoTxt) : null;
          if (String(ed.previstoTxt).trim() && previsto == null) return toast('Valor previsto inválido.');
          if (lerNum(novoPag.valor) > 0 && !confirm('Há um pagamento digitado e não adicionado. Salvar sem ele?')) return;
          const final = { id: ed.id, nome: ed.nome.trim(), previsto, concluida: !!ed.concluida, pagamentos: ed.pagamentos };
          mutarComp((dd) => {
            const i = dd.casa.etapas.findIndex((x) => x.id === final.id);
            if (i >= 0) dd.casa.etapas[i] = structuredClone(final); else dd.casa.etapas.push(structuredClone(final));
          }, 'app: etapa salva');
          fecharModal();
        }
      });
    },
  });
}

function modalViagem(id) {
  const comp = S.comp.dados;
  const v = id ? comp.viagens.find((x) => x.id === id) : null;
  abrirModal(`${cabecalhoModal(v ? 'Editar viagem' : 'Nova viagem')}
    <form class="form" id="f-viagem">
      <label class="campo"><span>Nome</span><input class="inp" name="nome" required value="${esc(v?.nome || '')}" placeholder="ex.: Férias de janeiro" autofocus></label>
      <label class="campo"><span>Destino</span><input class="inp" name="destino" value="${esc(v?.destino || '')}"></label>
      <div class="lado"><label class="campo"><span>Ida</span><input class="inp" type="date" name="ida" value="${v?.ida || ''}"></label>
      <label class="campo"><span>Volta</span><input class="inp" type="date" name="volta" value="${v?.volta || ''}"></label></div>
      <label class="campo"><span>Limite de gastos da viagem (R$)</span><input class="inp" name="limite" inputmode="decimal" value="${v?.limite ? num(v.limite) : ''}" placeholder="o máximo que vocês querem gastar"></label>
      <div class="modal-f">${v ? '<button type="button" class="btn perigo" data-v-apagar>Apagar viagem</button><div class="grow"></div>' : ''}<button type="button" class="btn" data-act="fechar-modal">Cancelar</button><button class="btn pri" type="submit">Salvar</button></div>
    </form>`, {
    aoMontar: (m) => {
      m.querySelector('[data-v-apagar]')?.addEventListener('click', () => {
        if (!confirm(`Apagar a viagem "${v.nome}" e todos os gastos dela? Lançamentos já feitos nas faturas continuam lá.`)) return;
        mutarComp((dd) => { dd.viagens = dd.viagens.filter((x) => x.id !== v.id); }, 'app: viagem apagada');
        S.viagemSel = null; fecharModal();
      });
      m.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.ida && f.volta && f.volta < f.ida) return toast('A volta está antes da ida.');
        const limite = String(f.limite).trim() ? lerNum(f.limite) : 0;
        if (limite == null) return toast('Limite inválido.');
        const campos = { nome: f.nome.trim(), destino: f.destino.trim(), ida: f.ida || null, volta: f.volta || null, limite };
        const nid = v?.id || uid('v');
        mutarComp((dd) => {
          const x = dd.viagens.find((y) => y.id === nid);
          if (x) Object.assign(x, campos); else dd.viagens.push({ id: nid, ...campos, criadaPor: euId(), itens: [] });
        }, v ? 'app: viagem editada' : 'app: viagem criada');
        S.viagemSel = nid; fecharModal();
      });
    },
  });
}

function modalItem(vid, iid, categoria) {
  const comp = S.comp.dados; const eu = euId();
  const v = comp.viagens.find((x) => x.id === vid); if (!v) return;
  const orig = iid ? v.itens.find((x) => x.id === iid) : null;
  const outro = PL.outroMembro(comp, eu);
  const ed = orig ? structuredClone(orig) : {
    id: uid('i'), categoria: categoria || PL.CATEGORIAS_VIAGEM[0], desc: '', valor: null, pagador: eu, parteOutro: outro ? 0.5 : 0,
    forma: 'cartao', cartao: S.dados.cartoes[0]?.id || null, parcelas: 1, data: S.hoje, status: 'previsto', lancamento: null,
  };
  ed.valorTxt = ed.valor == null ? '' : num(ed.valor);
  ed.divModo = !ed.parteOutro ? 'nao' : (Math.abs(ed.parteOutro - 0.5) < 0.001 ? 'metade' : 'outra');
  ed.pctTxt = ed.divModo === 'outra' ? String(Math.round(ed.parteOutro * 100)) : '';
  const travado = orig?.status === 'comprado' && orig.lancamento && orig.pagador === eu;

  const montar = () => {
    const valor = lerNum(ed.valorTxt);
    const parteOutro = ed.divModo === 'nao' ? 0 : ed.divModo === 'metade' ? 0.5 : Math.min(100, Math.max(0, Number(ed.pctTxt) || 0)) / 100;
    const outroDoPagador = PL.outroMembro(comp, ed.pagador);
    return { id: ed.id, categoria: ed.categoria, desc: ed.desc.trim(), valor, pagador: ed.pagador, parteOutro: outroDoPagador ? parteOutro : 0,
      forma: ed.forma, cartao: ed.forma === 'cartao' && ed.pagador === eu ? (ed.cartao || S.dados.cartoes[0]?.id || null) : (ed.pagador === eu ? null : (orig?.pagador === ed.pagador ? orig.cartao : null)),
      parcelas: ed.forma === 'cartao' ? Math.max(1, Math.min(24, Number(ed.parcelas) || 1)) : 1, data: ed.data || S.hoje, status: ed.status, lancamento: ed.lancamento || null };
  };
  const impacto = () => {
    const it = montar();
    if (!(it.valor > 0) || !S.dados.orcamento?.renda) return '';
    const antes = PL.viabilidade(comp, eu, S.dados, S.hoje, { semItem: it.id });
    const depois = PL.viabilidade(comp, eu, S.dados, S.hoje, { semItem: it.id, extra: { viagem: v, item: it } });
    const minhas = PL.saidasDoItem(comp, it, eu, S.dados, S.hoje);
    if (!minhas.length) return `<div class="alerta info small">${it.status === 'comprado' ? 'Comprado: o valor já está (ou vai estar) na sua fatura.' : 'Nada deste gasto sai do seu bolso.'}</div>`;
    const piorD = depois.linhas.filter((l) => minhas.some((x) => x.mes === l.mes)).reduce((a, b) => (b.sobra < a.sobra ? b : a));
    const antesMes = antes.linhas.find((l) => l.mes === piorD.mes);
    const cls = { ok: 'ok', warn: 'warn', bad: 'bad' }[piorD.estado];
    return `<div class="alerta ${cls} small"><div class="grow">Sua parte: ${minhas.length > 1 ? `${minhas.length}× ${brl(minhas[0].valor)} (${mesCurto(minhas[0].mes + '-01')} a ${mesCurto(minhas[minhas.length - 1].mes + '-01')})` : `${brl(minhas[0].valor)} em ${mesCurto(minhas[0].mes + '-01')}`}.
      No mês mais apertado (${mesCurto(piorD.mes + '-01')}) a sobra vai de ${brl(antesMes.sobra)} para <b>${brl(piorD.sobra)}</b>${piorD.estado === 'bad' ? ' — não cabe.' : piorD.estado === 'warn' ? ' — abaixo da sua margem.' : '.'}</div></div>`;
  };
  const tela = (m) => {
    const ehMeu = ed.pagador === eu;
    const outroDoPagador = PL.outroMembro(comp, ed.pagador);
    m.innerHTML = `${cabecalhoModal(orig ? 'Gasto da viagem' : 'Novo gasto')}
    <div class="form">
      ${travado ? '<div class="alerta info small">Já lançado na sua fatura. Para mudar valor ou parcelas, edite o lançamento em Faturas.</div>' : ''}
      <div class="lado"><label class="campo"><span>Categoria</span><select class="inp" data-i="categoria">${[...new Set([...PL.CATEGORIAS_VIAGEM, ed.categoria])].map((c) => `<option ${c === ed.categoria ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="campo"><span>Valor total (R$)</span><input class="inp" inputmode="decimal" data-i="valorTxt" value="${esc(ed.valorTxt)}" ${travado ? 'disabled' : ''}></label></div>
      <label class="campo"><span>Descrição</span><input class="inp" data-i="desc" value="${esc(ed.desc)}" placeholder="ex.: hotel 4 diárias, passagem ida e volta"></label>
      <div class="lado"><label class="campo"><span>Quem paga</span><select class="inp" data-i="pagador" ${travado ? 'disabled' : ''}>${comp.membros.map((x) => `<option value="${x.id}" ${x.id === ed.pagador ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
      <label class="campo"><span>Data da compra</span><input class="inp" type="date" data-i="data" value="${ed.data || ''}" ${travado ? 'disabled' : ''}></label></div>
      ${outroDoPagador ? `<div><div class="small" style="font-weight:550;color:var(--ink-2);margin-bottom:6px">Dividir com ${esc(outroDoPagador.nome)}?</div>
        <div class="row wrap"><div class="seg">${[['nao', 'Não'], ['metade', 'Meio a meio'], ['outra', 'Outra parte']].map(([k, t]) => `<button type="button" data-i-div="${k}" aria-pressed="${ed.divModo === k}">${t}</button>`).join('')}</div>
        ${ed.divModo === 'outra' ? `<label class="row small"><input class="inp" style="width:80px" inputmode="numeric" data-i="pctTxt" value="${esc(ed.pctTxt)}"> % fica com ${esc(outroDoPagador.nome.split(' ')[0])}</label>` : ''}</div></div>` : ''}
      <div><div class="small" style="font-weight:550;color:var(--ink-2);margin-bottom:6px">Como vai pagar</div>
        <div class="seg">${[['cartao', 'Cartão de crédito'], ['pix', 'Pix, débito ou dinheiro']].map(([k, t]) => `<button type="button" data-i-forma="${k}" aria-pressed="${ed.forma === k}" ${travado ? 'disabled' : ''}>${t}</button>`).join('')}</div></div>
      ${ed.forma === 'cartao' ? `<div class="lado">
        ${ehMeu ? `<label class="campo"><span>Cartão</span><select class="inp" data-i="cartao" ${travado ? 'disabled' : ''}>${S.dados.cartoes.map((c) => `<option value="${c.id}" ${c.id === ed.cartao ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>` : '<div class="tiny muted" style="align-self:end;padding-bottom:12px">O cartão fica com quem paga.</div>'}
        <label class="campo"><span>Parcelas</span><input class="inp" type="number" min="1" max="24" data-i="parcelas" value="${ed.parcelas}" ${travado ? 'disabled' : ''}></label></div>` : ''}
      ${ehMeu ? `<label class="check"><input type="checkbox" data-i="comprado" ${ed.status === 'comprado' ? 'checked' : ''}> Já comprei${ed.forma === 'cartao' && !orig?.lancamento ? ' <span class="tiny muted">(entra na fatura como lançamento seu)</span>' : ''}</label>`
        : `<div class="small muted">${ed.status === 'comprado' ? 'Comprado' : 'Ainda não comprado'} — quem marca é ${esc(nomeM(ed.pagador))}.</div>`}
      <div data-impacto>${impacto()}</div>
    </div>
    <div class="modal-f">${orig ? '<button type="button" class="btn perigo" data-i-apagar>Apagar</button><div class="grow"></div>' : ''}<button type="button" class="btn" data-act="fechar-modal">Cancelar</button><button type="button" class="btn pri" data-i-salvar>Salvar</button></div>`;
  };
  abrirModal('', {
    aoMontar: (m) => {
      tela(m);
      const atualizaImpacto = () => { const el = m.querySelector('[data-impacto]'); if (el) el.innerHTML = impacto(); };
      m.addEventListener('input', (e) => { const t = e.target; if (['valorTxt', 'desc', 'pctTxt', 'parcelas'].includes(t.dataset.i)) { ed[t.dataset.i] = t.value; atualizaImpacto(); } });
      m.addEventListener('change', (e) => {
        const t = e.target; const k = t.dataset.i; if (!k) return;
        if (k === 'comprado') ed.status = t.checked ? 'comprado' : 'previsto'; else ed[k] = t.value;
        if (['pagador', 'comprado', 'cartao'].includes(k)) tela(m); else atualizaImpacto();
      });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.iDiv) { ed.divModo = b.dataset.iDiv; if (ed.divModo === 'outra' && !ed.pctTxt) ed.pctTxt = '50'; tela(m); }
        if (b.dataset.iForma) { ed.forma = b.dataset.iForma; tela(m); }
        if (b.hasAttribute('data-i-apagar')) {
          if (!confirm('Apagar este gasto?' + (orig.lancamento ? ' O lançamento que já foi para a sua fatura continua lá.' : ''))) return;
          mutarComp((dd) => { const x = dd.viagens.find((y) => y.id === vid); if (x) x.itens = x.itens.filter((y) => y.id !== orig.id); }, 'app: gasto da viagem apagado');
          fecharModal();
        }
        if (b.hasAttribute('data-i-salvar')) salvar();
      });
    },
  });
  function salvar() {
    const it = montar();
    if (!(it.valor > 0)) return toast('Informe o valor.');
    if (it.forma === 'cartao' && it.pagador === eu && !it.cartao) return toast('Escolha o cartão.');
    // comprou agora no cartão → lançamento na minha fatura; desmarcou → tira o lançamento (se ainda for o manual)
    if (it.pagador === eu && it.forma === 'cartao' && it.status === 'comprado' && !it.lancamento) {
      const outroM = PL.outroMembro(comp, eu);
      let lanc;
      mutar((dd) => {
        const pessoa = it.parteOutro > 0 ? PL.pessoaParaMembro(dd, outroM) : null;
        if (pessoa?.nova) dd.pessoas.push(pessoa.nova);
        lanc = PL.lancamentoDoItem(comp, v, it, dd, pessoa?.id);
        dd.lancamentos.push(lanc);
      }, `app: compra da viagem ${v.nome}`);
      it.lancamento = lanc.id;
      toast(`Lançado no ${cartao(it.cartao).nome}, fatura de ${dataBR(lanc.venc)}.`, 3500);
    } else if (orig?.lancamento && it.status !== 'comprado') {
      const l = S.dados.lancamentos.find((x) => x.id === orig.lancamento);
      if (l && l.origem === 'manual') mutar((dd) => { dd.lancamentos = dd.lancamentos.filter((x) => x.id !== orig.lancamento); }, 'app: compra da viagem desfeita');
      else if (l) toast('A fatura com essa compra já foi importada; o lançamento do banco continua.', 4000);
      it.lancamento = null;
    }
    mutarComp((dd) => {
      const x = dd.viagens.find((y) => y.id === vid); if (!x) return;
      const i = x.itens.findIndex((y) => y.id === it.id);
      if (i >= 0) x.itens[i] = structuredClone(it); else x.itens.push(structuredClone(it));
    }, orig ? 'app: gasto da viagem editado' : 'app: gasto da viagem');
    fecharModal();
  }
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
    return parsePDFFatura(pages);
  }
  return parseNubankCSV(await file.text(), file.name);
}
async function iniciarImport(file, cartaoPref) {
  let p;
  try { toast('Lendo arquivo…', 1500); p = await lerArquivo(file, cartaoPref); } catch (err) { return abrirModal(`${cabecalhoModal('Não consegui ler')}<p class="erro-txt">${esc(err.message)}</p><div class="modal-f"><button class="btn" data-act="fechar-modal">Ok</button></div>`); }
  const d = S.dados;
  const reNome = { itau: /ita/i, nubank: /nu/i, mercadopago: /mercado/i }[p.banco] || /./;
  const cid = (d.cartoes.find((c) => c.id === p.banco) || d.cartoes.find((c) => reNome.test(c.nome)) || d.cartoes[0]).id;
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
    m.innerHTML = `${cabecalhoModal({ itau: 'Fatura Itaú (PDF)', mercadopago: 'Fatura Mercado Pago (PDF)' }[p.banco] || 'Fatura Nubank (CSV)')}
    <div class="form">
      <div class="lado"><label class="campo"><span>Cartão</span><select class="inp" data-i="cartao">${d.cartoes.map((x) => `<option value="${x.id}" ${x.id === imp.cartao ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
      <label class="campo"><span>Vencimento da fatura</span><input class="inp" type="date" data-i="venc" value="${imp.venc}"></label></div>
      ${existe ? '<div class="alerta info small">Essa fatura já tem lançamentos. Vou atualizar: o que você já marcou (pessoa, divisão, pago) é mantido.</div>' : ''}
      <div class="grid g3m">
        <div><div class="tiny muted">Compras e encargos</div><div class="num" style="font-weight:680">${brl(conc.compras)}</div><div class="tiny muted">${p.linhas.filter((l) => l.tipo === 'compra').length} lançamentos</div></div>
        <div><div class="tiny muted">Estornos/créditos</div><div class="num" style="font-weight:680">${brl(conc.creditos)}</div></div>
        <div><div class="tiny muted">Total calculado</div><div class="num" style="font-weight:680">${brl(calc)}</div></div>
      </div>
      ${p.banco !== 'nubank' ? `
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
          const origem = p.banco === 'nubank' ? 'csv' : 'pdf';
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
  nav: (a) => { S.view = a; if (a !== 'grupos') S.grupoSel = null; if (a !== 'viagens') S.viagemSel = null; render(); window.scrollTo(0, 0); },
  'fechar-modal': () => fecharModal(),
  'recarregar-pagina': () => location.reload(),
  importar: (a) => { cartaoImport = a || null; arquivo.click(); },
  'novo-lanc': (a) => { const [cid, venc] = (a || '').split('|'); modalEditarLanc(null, { cartao: cid || undefined, venc: venc || undefined }); },
  'editar-lanc': (a) => { const [id, proj] = a.split('|'); modalEditarLanc(id, { daProjecao: !!proj }); },
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
  'criar-dados': async () => {
    const ids = [...document.querySelectorAll('[data-novo-cartao]:checked')].map((x) => x.dataset.novoCartao);
    if (!ids.length) return toast('Escolha pelo menos um cartão.');
    S.dados = dadosVazios(ids);
    fecharModal(); S.store.sha = null; S.msgSalvar = 'app: dados.json criado'; await salvarAgora(); render(); },
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
  'casa-saldo': () => modalSaldo(),
  'membro-add': () => {
    const nomeN = (prompt('Nome da outra pessoa (o mesmo que ela vai digitar ao conectar o app):') || '').trim();
    if (!nomeN) return;
    const id = slug(nomeN);
    if (PL.membroPorId(S.comp.dados, id)) return toast('Essa pessoa já está cadastrada.');
    mutarComp((dd) => { if (!PL.membroPorId(dd, id)) dd.membros.push({ id, nome: nomeN }); }, 'app: membro cadastrado');
  },
  'casa-saldo-apagar': (a) => { if (confirm('Apagar este registro de saldo?')) mutarComp((dd) => { dd.casa.saldos = dd.casa.saldos.filter((x) => x.id !== a); }, 'app: saldo apagado'); },
  'casa-etapa': (a) => modalEtapa(a || null),
  'viagem-form': (a) => modalViagem(a || null),
  'viagem-abrir': (a) => { S.viagemSel = a; render(); window.scrollTo(0, 0); },
  'viagem-voltar': () => { S.viagemSel = null; render(); },
  'item-form': (a) => { const [vid, iid, cat] = a.split('|'); modalItem(vid, iid || null, cat || null); },
  'comp-recarregar': async () => { S.comp.erro = ''; await carregarComp({ forcar: S.comp.sync !== 'pendente' }); if (!S.comp.erro) toast('Casa e viagens atualizadas.'); },
  'comp-sair': () => { if (confirm('Desconectar casa e viagens deste aparelho? O arquivo no GitHub continua lá.')) { S.comp.store.sair(); S.comp.dados = null; S.comp.fila = []; render(); } },
  'comp-usar-github': async () => { fecharModal(); S.comp.dados = null; S.comp.fila = []; S.comp.sync = 'ok'; await S.comp.store.gravarCache({ dados: null, sha: null, pendente: false }); await carregarComp({ forcar: true }); },
  'comp-manter-local': async () => { fecharModal(); try { await S.comp.store.carregar(); } catch { /* segue */ } S.comp.msg = 'app: mantidos os dados deste aparelho'; await salvarComp(); },
  'cartao-add': (a) => { if (!CARTOES_MODELO[a]) return; mutar((dd) => { if (!dd.cartoes.some((c) => c.id === a)) dd.cartoes.push(structuredClone(CARTOES_MODELO[a])); }, 'app: cartão adicionado'); },
  'cartao-remover': (a) => { if (confirm('Remover este cartão?')) mutar((dd) => { dd.cartoes = dd.cartoes.filter((c) => c.id !== a); }, 'app: cartão removido'); },
  bloquear: () => { S.store.bloquear(); S.comp.store.bloquear(); S.comp.dados = null; S.dados = null; telaPin(); },
  sair: () => { if (confirm('Desconectar este aparelho? Você vai precisar do token de novo. Os dados no GitHub continuam lá.')) { S.store.sair(); S.comp.store.sair(); S.comp.dados = null; S.dados = null; telaConfig(); } },
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
  orc: (v, a) => {
    S.manterScroll = true;
    mutar((dd) => {
      dd.orcamento ||= { renda: null, compromissos: 0, guardarCasa: 0, margem: 0.1 };
      if (a === 'margem') dd.orcamento.margem = Math.min(0.8, Math.max(0, (Number(v) || 0) / 100));
      else { const n = lerNum(v); dd.orcamento[a] = n != null && n >= 0 ? n : (a === 'renda' ? null : 0); }
    }, 'app: renda e compromissos');
  },
  'dias-cobranca': (v) => { S.manterScroll = true; mutar((dd) => { dd.config ||= {}; dd.config.diasAntesCobranca = Math.max(0, Math.min(10, Number(v) || 0)); }, 'app: dias de cobrança'); },
};
app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-chg]'); if (!el) return;
  const f = MUDANCAS[el.dataset.chg]; if (f) f(el.value, el.dataset.arg, el);
});
app.addEventListener('submit', async (e) => {
  if (e.target.id !== 'f-comp') return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Conectando…';
  try {
    await new Store().desbloquear(f.pin); // mesmo PIN que abre o app neste aparelho
    await configurarComp({ owner: f.owner, repo: f.repo, token: f.token, nome: f.nome, pin: f.pin });
  } catch (err) { S.comp.store.sair(); btn.disabled = false; btn.textContent = 'Conectar'; return toast(err.message, 4500); }
  toast('Conectado. Buscando casa e viagens…');
  S.comp.dados = null; S.comp.erro = ''; render();
  await carregarComp({ forcar: true });
  render();
});
let resizeT; let larguraAnt = window.innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (Math.abs(window.innerWidth - larguraAnt) > 80 && S.dados && !document.querySelector('.modal')) { larguraAnt = window.innerWidth; S.manterScroll = true; render(); } }, 250); });
