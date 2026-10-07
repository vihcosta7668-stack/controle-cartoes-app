// Armazenamento: dados.json num repositório PRIVADO do GitHub (API Contents).
// O token fica no aparelho apenas cifrado (AES-GCM) com uma chave derivada do seu PIN.

const K = { cfg: 'cc_cfg', tok: 'cc_tok', cache: 'cc_cache' };
const API = 'https://api.github.com';
const ITER = 310000;

const enc = new TextEncoder(); const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function utf8ToB64(str) {
  const bytes = enc.encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64ToUtf8 = (s) => dec.decode(unb64(s.replace(/\s/g, '')));

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço/privado */ } };

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

export class ErroConflito extends Error {}

export class Store {
  constructor() { this.key = null; this.token = null; this.sha = null; this.cfg = lsGet(K.cfg); }

  get configurado() { return !!(this.cfg && lsGet(K.tok)); }
  get desbloqueado() { return !!this.token; }

  async gh(caminho, opts = {}) {
    const r = await fetch(API + caminho, {
      ...opts, cache: 'no-store',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
    });
    return r;
  }

  // Primeira configuração: testa o acesso e exige repositório privado.
  async configurar({ owner, repo, branch = 'main', path = 'dados.json', token, pin }) {
    if (!pin || pin.length < 6) throw new Error('Use um PIN/senha com pelo menos 6 caracteres.');
    this.token = token.trim();
    this.cfg = { owner: owner.trim(), repo: repo.trim(), branch: branch.trim() || 'main', path: path.trim() || 'dados.json' };
    const r = await this.gh(`/repos/${this.cfg.owner}/${this.cfg.repo}`);
    if (r.status === 401) throw new Error('Token inválido ou expirado.');
    if (r.status === 404) throw new Error('Repositório não encontrado — confira o nome e se o token tem acesso a ele.');
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status}.`);
    const info = await r.json();
    if (!info.private) { this.token = null; throw new Error('Esse repositório é PÚBLICO. Os dados só podem ficar num repositório privado.'); }
    if (info.permissions && !info.permissions.push) throw new Error('O token não tem permissão de escrita (Contents: Read and write).');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await derivar(pin, salt);
    lsSet(K.cfg, this.cfg);
    lsSet(K.tok, { salt: b64(salt), ...(await cifrar(this.key, this.token)) });
  }

  async desbloquear(pin) {
    const t = lsGet(K.tok); if (!t) throw new Error('Aparelho não configurado.');
    const key = await derivar(pin, unb64(t.salt));
    try { this.token = await decifrar(key, t); } catch { throw new Error('PIN incorreto.'); }
    this.key = key;
  }

  bloquear() { this.token = null; this.key = null; }

  sair() { this.bloquear(); Object.values(K).forEach((k) => localStorage.removeItem(k)); this.cfg = null; this.sha = null; }

  async lerCache() {
    const c = lsGet(K.cache); if (!c || !this.key) return null;
    try { return JSON.parse(await decifrar(this.key, c)); } catch { return null; }
  }
  async gravarCache(obj) { if (this.key) lsSet(K.cache, await cifrar(this.key, JSON.stringify(obj))); }

  // Retorna { dados, sha } ou { dados:null } se o arquivo ainda não existe.
  async carregar() {
    const { owner, repo, branch, path } = this.cfg;
    const r = await this.gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    if (r.status === 404) { this.sha = null; return { dados: null }; }
    if (r.status === 401) throw new Error('Token inválido ou expirado. Gere um novo em Ajustes.');
    if (!r.ok) throw new Error(`Erro ao ler do GitHub (${r.status}).`);
    const j = await r.json();
    let conteudo = j.content;
    if (!conteudo && j.size > 0) { // > 1 MB: lê pelo blob
      const b = await this.gh(`/repos/${owner}/${repo}/git/blobs/${j.sha}`);
      conteudo = (await b.json()).content;
    }
    this.sha = j.sha;
    const dados = JSON.parse(b64ToUtf8(conteudo));
    await this.gravarCache({ dados, sha: this.sha, pendente: false });
    return { dados, sha: this.sha };
  }

  async salvar(dados, mensagem) {
    const { owner, repo, branch, path } = this.cfg;
    dados.atualizadoEm = new Date().toISOString();
    const corpo = { message: mensagem || 'app: atualização', content: utf8ToB64(JSON.stringify(dados, null, 1)), branch };
    if (this.sha) corpo.sha = this.sha;
    const r = await this.gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify(corpo), headers: { 'Content-Type': 'application/json' } });
    if (r.status === 409 || r.status === 422) throw new ErroConflito('Os dados foram alterados em outro aparelho.');
    if (!r.ok) throw new Error(`Erro ao salvar no GitHub (${r.status}).`);
    const j = await r.json();
    this.sha = j.content.sha;
    await this.gravarCache({ dados, sha: this.sha, pendente: false });
  }

  async marcarPendente(dados) { await this.gravarCache({ dados, sha: this.sha, pendente: true }); }
}
