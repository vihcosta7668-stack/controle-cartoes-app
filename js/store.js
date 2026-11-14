// Armazenamento: tabelas SQL no Supabase (ver supabase/schema.sql), lidas e gravadas pelas funções
// carregar_pessoal/salvar_pessoal e carregar_comp/salvar_comp. O login é o do Supabase (e-mail e senha);
// a sessão fica no aparelho apenas cifrada (AES-GCM) com uma chave derivada do seu PIN.

const K = {
  cfg: 'cc_sb_cfg', ses: 'cc_sb_ses', cache: 'cc_sb_cache',
  comp: 'cc_sb_comp', compCache: 'cc_sb_comp_cache',
};
// Chaves da versão com GitHub: apagadas quando este aparelho entra no Supabase.
const ANTIGAS = ['cc_cfg', 'cc_tok', 'cc_cache', 'cc_comp_cfg', 'cc_comp_tok', 'cc_comp_cache'];
import { SUPABASE } from './config.js';

const ITER = 310000;

const enc = new TextEncoder(); const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço/privado */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* idem */ } };

async function derivar(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function cifrar(key, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(texto));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decifrar(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return dec.decode(pt);
}

// "Manter conectado": guarda no IndexedDB a chave AES já derivada do PIN, como CryptoKey NÃO exportável.
// A sessão continua cifrada no localStorage; o script do app consegue usar a chave, mas ninguém consegue
// copiar os bytes dela para fora do navegador. Quem abrir o app neste aparelho entra sem PIN.
const IDB = 'cc_chaves';
function idb(modo, fn) {
  return new Promise((ok, erro) => {
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('k');
    req.onerror = () => erro(req.error);
    req.onsuccess = () => {
      const db = req.result; const tx = db.transaction('k', modo); const r = fn(tx.objectStore('k'));
      tx.oncomplete = () => { db.close(); ok(r?.result); };
      tx.onerror = () => { db.close(); erro(tx.error); };
    };
  });
}

export class ErroConflito extends Error {}
export class ErroLogin extends Error {}

function normalizarUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u)) throw new Error('Use o endereço do projeto no formato https://xxxx.supabase.co (Project Settings → API).');
  return u.toLowerCase();
}
const msgErro = (j, padrao) => j?.msg || j?.message || j?.error_description || j?.error || padrao;

// ======================= sessão (login + PIN) =======================
export class Sessao {
  constructor() { this.cfg = lsGet(K.cfg); this.key = null; this.ses = null; this._renovando = null; }

  get configurado() { return !!(this.cfg && lsGet(K.ses)); }
  get desbloqueado() { return !!this.ses; }
  get usuario() { return this.ses?.user || this.cfg?.user || null; }

  async auth(caminho, corpo) {
    const r = await fetch(`${this.cfg.url}/auth/v1/${caminho}`, {
      method: 'POST', cache: 'no-store',
      headers: { apikey: this.cfg.chave, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const j = await r.json().catch(() => null);
    return { r, j };
  }

  // Primeiro acesso neste aparelho: entra com e-mail e senha e guarda a sessão cifrada pelo PIN.
  async entrar({ url, chave, email, senha, pin }) {
    if (!pin || pin.length < 6) throw new Error('Use um PIN/senha com pelo menos 6 caracteres.');
    this.cfg = { url: normalizarUrl(url || SUPABASE.url), chave: String(chave || SUPABASE.chave || '').trim() };
    if (!this.cfg.chave) throw new Error('Cole a chave anon (pública) do projeto.');
    let resp;
    try { resp = await this.auth('token?grant_type=password', { email: String(email).trim(), password: senha }); }
    catch { throw new Error('Não consegui falar com o Supabase. Confira o endereço do projeto e a internet.'); }
    const { r, j } = resp;
    if (r.status === 401 && /api key/i.test(msgErro(j, ''))) throw new Error('Chave anon inválida para esse projeto.');
    if (r.status === 400 || r.status === 401) throw new Error(/confirm/i.test(msgErro(j, '')) ? 'Confirme o e-mail antes de entrar (ou marque o usuário como confirmado no Supabase).' : 'E-mail ou senha incorretos.');
    if (!r.ok) throw new Error(`Supabase respondeu ${r.status}: ${msgErro(j, '')}`);
    this.ses = this.sessaoDe(j);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await derivar(pin, salt);
    this.cfg.user = this.ses.user; this.cfg.salt = b64(salt);
    lsSet(K.cfg, this.cfg);
    await this.guardar();
    ANTIGAS.forEach(lsDel);
  }

  sessaoDe(j) {
    return {
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      user: { id: j.user?.id, email: j.user?.email },
    };
  }
  async guardar() { if (this.key && this.ses) lsSet(K.ses, await cifrar(this.key, JSON.stringify(this.ses))); }
  async lerGuardada(key = this.key) {
    const b = lsGet(K.ses); if (!b || !key) return null;
    return JSON.parse(await decifrar(key, b));
  }

  async desbloquear(pin) {
    if (!this.configurado) throw new Error('Aparelho não configurado.');
    const key = await derivar(pin, unb64(this.cfg.salt));
    try { this.ses = await this.lerGuardada(key); } catch { throw new Error('PIN incorreto.'); }
    this.key = key;
  }
  bloquear() { this.ses = null; this.key = null; }

  async lembrar() { if (this.key) await idb('readwrite', (st) => st.put(this.key, K.ses)); }
  async esquecer() { try { await idb('readwrite', (st) => st.delete(K.ses)); } catch { /* sem IndexedDB */ } }
  // Abre sem PIN, se este aparelho foi marcado para manter conectado. Retorna true se abriu.
  async desbloquearSalvo() {
    if (!this.configurado) return false;
    let key;
    try { key = await idb('readonly', (st) => st.get(K.ses)); } catch { return false; }
    if (!key) return false;
    try { this.ses = await this.lerGuardada(key); } catch { await this.esquecer(); return false; }
    this.key = key;
    return true;
  }

  // O Supabase troca o refresh token a cada renovação e derruba a sessão se um token velho for reusado.
  // Por isso: uma renovação por vez, e antes de renovar confere se outra aba já renovou e guardou.
  async token() {
    if (!this.ses) throw new ErroLogin('App bloqueado.');
    if (this.ses.expires_at - 60 > Date.now() / 1000) return this.ses.access_token;
    await this.renovar();
    return this.ses.access_token;
  }
  renovar() {
    this._renovando ||= (async () => {
      try {
        const g = await this.lerGuardada().catch(() => null);
        if (g && g.expires_at > this.ses.expires_at) { this.ses = g; if (g.expires_at - 60 > Date.now() / 1000) return; }
        const { r, j } = await this.auth('token?grant_type=refresh_token', { refresh_token: this.ses.refresh_token });
        if (r.status === 400 || r.status === 401) throw new ErroLogin('Sua sessão no Supabase expirou. Desconecte este aparelho e entre de novo.');
        if (!r.ok) throw new Error(`Supabase respondeu ${r.status}.`);
        this.ses = this.sessaoDe(j);
        await this.guardar();
      } finally { this._renovando = null; }
    })();
    return this._renovando;
  }

  async rpc(nome, args = {}, tentativa = 0) {
    const r = await fetch(`${this.cfg.url}/rest/v1/rpc/${nome}`, {
      method: 'POST', cache: 'no-store',
      headers: { apikey: this.cfg.chave, Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (r.status === 401 && tentativa === 0) { this.ses.expires_at = 0; return this.rpc(nome, args, 1); }
    const texto = await r.text();
    const j = texto ? JSON.parse(texto) : null;
    if (r.status === 409) throw new ErroConflito('Os dados foram alterados em outro aparelho.');
    if (r.status === 401) throw new ErroLogin('Sua sessão no Supabase expirou. Desconecte este aparelho e entre de novo.');
    if (r.status === 404 && /function|schema cache/i.test(msgErro(j, ''))) throw new Error('As tabelas do app ainda não existem no Supabase. Rode o arquivo supabase/schema.sql no SQL Editor.');
    if (!r.ok) throw new Error(msgErro(j, `Erro no Supabase (${r.status}).`));
    return j;
  }

  sair() {
    if (this.ses && this.cfg) this.token().then((t) => fetch(`${this.cfg.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.cfg.chave, Authorization: `Bearer ${t}` } })).catch(() => {});
    this.bloquear(); this.esquecer();
    Object.values(K).forEach(lsDel);
    this.cfg = null;
  }

  async lerCacheDe(k) {
    const c = lsGet(k); if (!c || !this.key) return null;
    try { return JSON.parse(await decifrar(this.key, c)); } catch { return null; }
  }
  async gravarCacheEm(k, obj) { if (this.key) lsSet(k, await cifrar(this.key, JSON.stringify(obj))); }
}

// ======================= dados pessoais =======================
export class Store {
  constructor(sessao) { this.s = sessao; this.revisao = null; }
  get configurado() { return this.s.configurado; }
  get desbloqueado() { return this.s.desbloqueado; }

  lerCache() { return this.s.lerCacheDe(K.cache); }
  gravarCache(obj) { return this.s.gravarCacheEm(K.cache, obj); }

  // Retorna { dados } ou { dados: null } se este usuário ainda não tem dados no Supabase.
  async carregar() {
    const r = await this.s.rpc('carregar_pessoal');
    if (!r) { this.revisao = null; return { dados: null }; }
    this.revisao = r.revisao;
    await this.gravarCache({ dados: r.dados, revisao: this.revisao, pendente: false });
    return { dados: r.dados };
  }

  async salvar(dados) {
    dados.atualizadoEm = new Date().toISOString();
    this.revisao = await this.s.rpc('salvar_pessoal', { p_dados: dados, p_revisao: this.revisao });
    await this.gravarCache({ dados, revisao: this.revisao, pendente: false });
  }

  async marcarPendente(dados) { await this.gravarCache({ dados, revisao: this.revisao, pendente: true }); }
}

// ======================= casa e viagens (espaço do casal) =======================
export class StoreComp {
  constructor(sessao) { this.s = sessao; this.revisao = null; this.cfg = lsGet(K.comp); }
  get configurado() { return !!(this.cfg?.espaco && this.s.configurado); }
  get desbloqueado() { return this.s.desbloqueado; }

  // Cria o espaço (com os dados iniciais) ou entra num existente pelo código que a outra pessoa passou.
  async conectar({ nome, codigo, dadosIniciais }) {
    const eu = String(nome || '').trim();
    if (!eu) throw new Error('Informe seu nome.');
    let espaco; let cod = null;
    if (codigo) espaco = await this.s.rpc('entrar_espaco', { p_codigo: String(codigo).trim() });
    else { const r = await this.s.rpc('criar_espaco', { p_dados: dadosIniciais }); espaco = r.id; cod = r.codigo; }
    this.cfg = { espaco, eu, codigo: cod };
    lsSet(K.comp, this.cfg);
  }

  sair() { this.cfg = null; this.revisao = null; lsDel(K.comp); lsDel(K.compCache); }

  lerCache() { return this.s.lerCacheDe(K.compCache); }
  gravarCache(obj) { return this.s.gravarCacheEm(K.compCache, obj); }

  async carregar() {
    const r = await this.s.rpc('carregar_comp', { p_espaco: this.cfg.espaco });
    this.revisao = r.revisao;
    if (r.codigo && r.codigo !== this.cfg.codigo) { this.cfg.codigo = r.codigo; lsSet(K.comp, this.cfg); }
    await this.gravarCache({ dados: r.dados, revisao: this.revisao, pendente: false });
    return { dados: r.dados };
  }

  async salvar(dados) {
    dados.atualizadoEm = new Date().toISOString();
    this.revisao = await this.s.rpc('salvar_comp', { p_espaco: this.cfg.espaco, p_dados: dados, p_revisao: this.revisao });
    await this.gravarCache({ dados, revisao: this.revisao, pendente: false });
  }

  async marcarPendente(dados) { await this.gravarCache({ dados, revisao: this.revisao, pendente: true }); }
}
