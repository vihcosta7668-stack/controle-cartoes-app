// Leitores de fatura. Funções puras: recebem texto/itens e devolvem lançamentos.
// Nada aqui guarda CPF, endereço, código de barras ou número de cartão.
import { parseValor, round2, ymd, partes, addMeses, difDias, detectaParcela } from './util.js';

// ---------------- Nubank (CSV da fatura) ----------------
function splitCSVLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function tipoPorValor(desc, valor) {
  if (valor < 0 && /pagamento (recebido|efetuado|via)/i.test(desc)) return 'pagamento';
  if (valor < 0) return 'estorno';
  return 'compra';
}

export function parseNubankCSV(texto, nomeArquivo = '') {
  const linhas = String(texto).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) throw new Error('Arquivo vazio.');
  const cab = splitCSVLine(linhas[0]).map((h) => h.toLowerCase());
  const iData = cab.indexOf('date'), iTit = cab.indexOf('title'), iVal = cab.indexOf('amount');
  if (iData < 0 || iTit < 0 || iVal < 0) {
    if (cab.some((h) => h.includes('identificador'))) {
      throw new Error('Este CSV é do extrato da conta Nubank, não da fatura do cartão. No app, exporte a fatura do cartão.');
    }
    throw new Error('Não reconheci o CSV. Esperava as colunas date, title, amount (fatura do cartão Nubank).');
  }
  const out = []; const avisos = [];
  for (let i = 1; i < linhas.length; i++) {
    const c = splitCSVLine(linhas[i]);
    const data = c[iData]; const desc = c[iTit]; const valor = round2(parseValor(c[iVal]));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(valor)) { avisos.push(`Linha ${i + 1} ignorada: ${linhas[i]}`); continue; }
    out.push({ data, desc, valor, tipo: tipoPorValor(desc, valor), parcela: detectaParcela(desc) });
  }
  const m = String(nomeArquivo).match(/(\d{4}-\d{2}-\d{2})/);
  return { banco: 'nubank', vencimento: m ? m[1] : null, linhas: out, avisos, totalDeclarado: null };
}

// ---------------- Itaú (PDF da fatura) ----------------
// pages: [{ width, items: [{ str, x, y }] }] — vindos do pdf.js (getTextContent)

function agrupaLinhas(items, tol = 2.5) {
  const ord = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas = [];
  for (const it of ord) {
    const l = linhas.find((L) => Math.abs(L.y - it.y) <= tol);
    if (l) l.items.push(it); else linhas.push({ y: it.y, items: [it] });
  }
  for (const l of linhas) {
    l.items.sort((a, b) => a.x - b.x);
    l.texto = l.items.map((i) => i.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
  }
  return linhas.sort((a, b) => b.y - a.y);
}

// Ano da compra: a data vem só como dd/mm. Usa o vencimento e, se for parcela,
// o mês esperado da 1ª compra (vencimento - n meses) para escolher o ano certo.
export function inferirData(ddmm, venc, parcela) {
  const [d, m] = ddmm.split('/').map(Number);
  const { y } = partes(venc);
  const alvo = parcela ? addMeses(venc, -parcela.n) : addMeses(venc, -1);
  let melhor = null; let dist = Infinity;
  for (const yy of [y + 1, y, y - 1, y - 2, y - 3, y - 4]) {
    const iso = ymd(yy, m, d);
    if (difDias(iso, venc) < 0) continue; // compra depois do vencimento: impossível
    const dd = Math.abs(difDias(iso, alvo));
    if (dd < dist) { dist = dd; melhor = iso; }
  }
  return melhor || ymd(y, m, d);
}

const RE_LANC = /^(\d{2}\/\d{2})\s+(.+?)\s+(-\s?)?(\d{1,3}(?:\.\d{3})*,\d{2})$/;

export function parseItauPages(pages) {
  if (!pages.length) throw new Error('PDF sem páginas.');
  const textoTodo = pages.map((p) => agrupaLinhas(p.items).map((l) => l.texto).join('\n')).join('\n');
  if (!/ita[uú]/i.test(textoTodo)) throw new Error('Este PDF não parece ser uma fatura do Itaú.');

  const venc = textoTodo.match(/Vencimento:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!venc) throw new Error('Não encontrei a data de vencimento na fatura.');
  const vencimento = `${venc[3]}-${venc[2]}-${venc[1]}`;
  const tot = textoTodo.match(/Total desta fatura\s+(-?[\d.]+,\d{2})/);
  const totLanc = textoTodo.match(/Total dos lan[çc]amentos atuais\s+(-?[\d.]+,\d{2})/);
  const prox = textoTodo.match(/Pr[óo]xima fatura\s+([\d.]+,\d{2})/);
  const demais = textoTodo.match(/Demais faturas\s+([\d.]+,\d{2})/);
  const fech = textoTodo.match(/Previs[ãa]o pr[óo]x\.?\s*Fechamento:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  const totalAnterior = textoTodo.match(/Total da fatura anterior\s+([\d.]+,\d{2})/);

  // Sequência de linhas por coluna (esquerda, depois direita), página a página.
  const seq = [];
  pages.forEach((p, idx) => {
    if (idx === 0) return; // pág. 1 = resumo/boleto (dados pessoais) — ignorada
    const meio = p.width * 0.57;
    const esq = p.items.filter((i) => i.x < meio);
    const dir = p.items.filter((i) => i.x >= meio);
    for (const l of agrupaLinhas(esq)) seq.push(l.texto);
    for (const l of agrupaLinhas(dir)) seq.push(l.texto);
  });

  let secao = null;
  const lancamentos = []; const pagamentos = []; const proximas = []; let ultimaDataIntl = null;
  for (const t of seq) {
    if (/^Pagamentos efetuados/i.test(t)) { secao = 'pag'; continue; }
    if (/^Lan[çc]amentos: compras e saques/i.test(t)) { secao = 'compras'; continue; }
    if (/^Lan[çc]amentos internacionais/i.test(t)) { secao = 'intl'; continue; }
    if (/^Compras parceladas - pr[óo]ximas faturas/i.test(t)) { secao = 'prox'; continue; }
    if (/^(Pr[óo]xima fatura|Limites de cr[ée]dito|Encargos cobrados|Total para pr[óo]ximas)/i.test(t)) { secao = null; continue; }
    if (!secao) continue;
    if (secao === 'intl') {
      const iof = t.match(/^Repasse de IOF em R\$\s+([\d.]+,\d{2})$/i);
      if (iof) { lancamentos.push({ ddmm: ultimaDataIntl, desc: 'Repasse de IOF (compra internacional)', valor: parseValor(iof[1]), intl: true }); continue; }
    }
    const m = t.match(RE_LANC);
    if (!m) continue;
    if (/^Total\s/i.test(m[2])) continue; // linhas de soma ("Total dos ..."), não compras como "TOTALPASS"
    const valor = round2(parseValor((m[3] ? '-' : '') + m[4]));
    const item = { ddmm: m[1], desc: m[2].trim(), valor };
    if (secao === 'pag') pagamentos.push(item);
    else if (secao === 'prox') proximas.push(item);
    else { if (secao === 'intl') { item.intl = true; ultimaDataIntl = m[1]; } lancamentos.push(item); }
  }

  const conv = (it, tipoForcado) => {
    const parcela = detectaParcela(it.desc);
    const valor = tipoForcado === 'pagamento' ? -Math.abs(it.valor) : it.valor;
    return {
      data: inferirData(it.ddmm || '01/' + vencimento.slice(5, 7), vencimento, parcela),
      desc: it.desc, valor, parcela,
      tipo: tipoForcado || (valor < 0 ? 'estorno' : 'compra'),
    };
  };
  const linhas = [...pagamentos.map((p) => conv(p, 'pagamento')), ...lancamentos.map((l) => conv(l))];
  const vencProx = addMeses(vencimento, 1);
  const proximasLinhas = proximas.map((p) => {
    const parcela = detectaParcela(p.desc);
    return { data: inferirData(p.ddmm, vencProx, parcela), desc: p.desc, valor: p.valor, parcela, tipo: 'compra' };
  });

  const somaLanc = round2(lancamentos.reduce((s, l) => s + l.valor, 0));
  const avisos = [];
  const totalDeclarado = totLanc ? parseValor(totLanc[1]) : (tot ? parseValor(tot[1]) : null);
  if (totalDeclarado != null && Math.abs(somaLanc - totalDeclarado) > 0.009) {
    avisos.push(`A soma dos lançamentos lidos (${somaLanc.toFixed(2)}) não bate com o total da fatura (${totalDeclarado.toFixed(2)}). Confira se faltou alguma linha.`);
  }
  const somaProx = round2(proximasLinhas.reduce((s, l) => s + l.valor, 0));
  const proxDeclarada = prox ? parseValor(prox[1]) : null;
  if (proxDeclarada != null && Math.abs(somaProx - proxDeclarada) > 0.009) {
    avisos.push(`Parcelas da próxima fatura lidas (${somaProx.toFixed(2)}) não batem com o total informado no PDF (${proxDeclarada.toFixed(2)}).`);
  }
  return {
    banco: 'itau', vencimento, linhas, avisos,
    totalDeclarado, somaLancamentos: somaLanc,
    totalFatura: tot ? parseValor(tot[1]) : null,
    totalAnterior: totalAnterior ? parseValor(totalAnterior[1]) : null,
    proximas: { vencimento: vencProx, linhas: proximasLinhas, soma: somaProx, declarada: proxDeclarada, demais: demais ? parseValor(demais[1]) : null },
    proximoFechamento: fech ? `${fech[3]}-${fech[2]}-${fech[1]}` : null,
  };
}

// ---------------- Mercado Pago (PDF da fatura) ----------------
// Página 1 = resumo (nome do titular, ignorado). Lançamentos vêm em "Movimentações na fatura"
// (pagamentos, encargos) e em um bloco por cartão ("Cartão Visa [****1234]" — o número é descartado).
// Frases do próprio Mercado Pago (não basta "mercado pago": compras "MERCADOPAGO*" aparecem em faturas de outros bancos).
const RE_MARCA_MP = /Pague sua fatura pelo app Mercado Pago|Cart[ãa]o de Cr[ée]dito Mercado Pago/i;
const RE_LANC_MP = /^(\d{2}\/\d{2})\s+(.+?)\s+(-\s?)?R\$\s?(-\s?)?(\d{1,3}(?:\.\d{3})*,\d{2})$/;

export function parseMercadoPagoPages(pages) {
  if (!pages.length) throw new Error('PDF sem páginas.');
  const porPagina = pages.map((p) => agrupaLinhas(p.items).map((l) => l.texto));
  const textoTodo = porPagina.map((ls) => ls.join('\n')).join('\n');
  if (!RE_MARCA_MP.test(textoTodo)) throw new Error('Este PDF não parece ser uma fatura do Mercado Pago.');

  const venc = textoTodo.match(/Vencimento:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!venc) throw new Error('Não encontrei a data de vencimento na fatura.');
  const vencimento = `${venc[3]}-${venc[2]}-${venc[1]}`;
  const valorDe = (re) => { const m = textoTodo.match(re); return m ? parseValor(m[1]) : null; };
  const consumos = valorDe(/Consumos de \d{2}\/\d{2} a \d{2}\/\d{2}\s+R\$\s*([\d.]+,\d{2})/i);
  const tarifas = valorDe(/Tarifas e encargos\s+R\$\s*([\d.]+,\d{2})/i);
  const multas = valorDe(/Multas por atraso\s+R\$\s*([\d.]+,\d{2})/i);
  const juros = valorDe(/Juros do m[êe]s anterior\s+R\$\s*([\d.]+,\d{2})/i);
  const fech = textoTodo.match(/Pr[óo]ximo fechamento\s+(\d{2})\/(\d{2})\/(\d{4})/i);

  let secao = null;
  const lancamentos = []; const movs = [];
  porPagina.forEach((linhas, idx) => {
    if (idx === 0) return;
    for (const t of linhas) {
      if (/^Movimenta[çc][õo]es na fatura/i.test(t)) { secao = 'mov'; continue; }
      if (/^Cart[ãa]o\s+\S+.*\[/i.test(t)) { secao = 'compras'; continue; }
      if (/^(Parcele a fatura|Seu cart[ãa]o de cr[ée]dito|Compras internacionais|Cobran[çc]as)/i.test(t)) { secao = null; continue; }
      if (!secao) continue;
      const m = t.match(RE_LANC_MP);
      if (!m) continue;
      const negativo = !!(m[3] || m[4]);
      const item = { ddmm: m[1], desc: m[2].trim(), valor: round2(parseValor(m[5])) * (negativo ? -1 : 1) };
      (secao === 'mov' ? movs : lancamentos).push(item);
    }
  });

  // "Parcela 6 de 8" -> "Parcela 6/8", o formato que o resto do app reconhece
  const normaliza = (desc) => desc.replace(/\s*-?\s*Parcela\s+(\d{1,2})\s+de\s+(\d{1,2})\s*$/i, ' - Parcela $1/$2');
  const conv = (it) => {
    const desc = normaliza(it.desc);
    const parcela = detectaParcela(desc);
    const pagamento = /^pagamento/i.test(it.desc);
    const valor = pagamento ? -Math.abs(it.valor) : it.valor;
    return { data: inferirData(it.ddmm, vencimento, parcela), desc, valor, parcela, tipo: pagamento ? 'pagamento' : (valor < 0 ? 'estorno' : 'compra') };
  };
  const linhas = [...movs.map(conv), ...lancamentos.map(conv)];

  const somaLanc = round2(linhas.filter((l) => l.tipo !== 'pagamento').reduce((s, l) => s + l.valor, 0));
  const totalDeclarado = consumos != null ? round2(consumos + (tarifas || 0) + (multas || 0) + (juros || 0)) : null;
  const avisos = [];
  if (totalDeclarado != null && Math.abs(somaLanc - totalDeclarado) > 0.009) {
    avisos.push(`A soma dos lançamentos lidos (${somaLanc.toFixed(2)}) não bate com consumos + encargos da fatura (${totalDeclarado.toFixed(2)}). Confira se faltou alguma linha.`);
  }
  return {
    banco: 'mercadopago', vencimento, linhas, avisos, totalDeclarado, somaLancamentos: somaLanc,
    proximas: null, proximoFechamento: fech ? `${fech[3]}-${fech[2]}-${fech[1]}` : null,
  };
}

// Escolhe o leitor pelo conteúdo do PDF.
export function parsePDFFatura(pages) {
  const texto = pages.map((p) => agrupaLinhas(p.items).map((l) => l.texto).join('\n')).join('\n');
  if (RE_MARCA_MP.test(texto)) return parseMercadoPagoPages(pages);
  return parseItauPages(pages);
}

// Extrai itens de texto com pdf.js (navegador ou Node). pdfjs = módulo carregado.
export async function lerPaginasPDF(pdfjs, bytes) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    // Lê o stream com getReader(): o getTextContent() do pdf.js usa `for await` em ReadableStream,
    // que o Safari do iPhone não suporta ("undefined is not a function").
    const reader = page.streamTextContent().getReader();
    const tc = { items: [] };
    for (let r = await reader.read(); !r.done; r = await reader.read()) tc.items.push(...r.value.items);
    pages.push({ width: vp.width, items: tc.items.filter((i) => typeof i.str === 'string').map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] })) });
  }
  await task.destroy();
  return pages;
}

// ---------------- Texto colado (fatura ainda aberta) ----------------
// Para quando o banco ainda não deixa baixar o arquivo: o texto copiado da tela de lançamentos
// (internet banking ou app) ou digitado, uma compra por linha. Aceita a data, a descrição e o valor
// na mesma linha ("05/11 UBER TRIP 23,90") ou em linhas separadas, como sai ao copiar de muitas telas.
const MESES_TXT = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const RE_DATA = /^(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?(?!\d)|^(\d{1,2})\s*(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç.]*(?:\s*(?:de\s+)?(\d{4}))?/i;
// valor no fim da linha: com centavos ("23,90", "12,5", "1.234,56") ou inteiro precedido de R$ ("R$ 30")
const RE_VALOR = /(-|−)?\s*(?:R\$\s*)?(-|−)?\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{1,2})\s*(-|−)?\s*$|(-|−)?\s*R\$\s*(-|−)?\s*(\d{1,3}(?:\.\d{3})*|\d+)\s*$/;
const CABECALHO = /^(data|lan[cç]amentos?|descri[cç][aã]o|estabelecimento|valor( em r\$)?|total|subtotal|fatura|compras|cart[aã]o|titular|adicional)\b/i;

function dataDoTexto(m, hoje) {
  const dia = Number(m[1] || m[4]);
  const mes = m[2] ? Number(m[2]) : MESES_TXT[String(m[5]).slice(0, 3).toLowerCase()];
  let ano = m[3] || m[6];
  if (!mes || mes > 12 || dia < 1 || dia > 31) return null;
  if (ano) ano = Number(ano.length === 2 ? '20' + ano : ano);
  else { // sem ano: a ocorrência mais recente que não passa de hoje (+3 dias de folga)
    const { y } = partes(hoje);
    ano = y;
    if (difDias(hoje, ymd(y, mes, Math.min(dia, 28))) > 3) ano = y - 1;
  }
  return ymd(ano, mes, dia);
}

export function parseTextoLancamentos(texto, hoje) {
  const linhas = String(texto || '').replace(/ /g, ' ').split(/\r?\n/).map((l) => l.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = []; const ignoradas = [];
  let atual = null; // { data, desc: [] }
  const fechar = (valorTxt, negativo) => {
    const desc = atual.desc.join(' ').replace(/\s+/g, ' ').trim();
    const v = round2(parseValor(valorTxt) * (negativo ? -1 : 1));
    if (!desc || !Number.isFinite(v) || v === 0) { ignoradas.push([atual.data, desc, valorTxt].filter(Boolean).join(' ')); atual = null; return; }
    out.push({ data: atual.data, desc, valor: v, tipo: tipoPorValor(desc, v), parcela: detectaParcela(desc) });
    atual = { data: atual.data, desc: [] }; // próximas linhas sem data herdam a mesma data (telas que agrupam por dia)
    atual.semValor = true;
  };
  for (const bruta of linhas) {
    let l = bruta;
    if (CABECALHO.test(l) && !RE_VALOR.test(l)) continue;
    const md = l.match(RE_DATA);
    if (md) {
      const data = dataDoTexto(md, hoje);
      if (data) {
        if (atual && atual.desc.length && !atual.semValor) ignoradas.push(`${atual.data} ${atual.desc.join(' ')}`);
        atual = { data, desc: [] };
        l = l.slice(md[0].length).trim();
      }
    }
    if (!atual) { ignoradas.push(bruta); continue; }
    const mv = l.match(RE_VALOR);
    if (mv) {
      const resto = l.slice(0, mv.index).replace(/R\$\s*$/i, '').trim();
      if (resto) atual.desc.push(resto);
      atual.semValor = false;
      fechar(mv[3] || mv[7], !!(mv[1] || mv[2] || mv[4] || mv[5] || mv[6]));
    } else if (l) { atual.desc.push(l); atual.semValor = false; }
  }
  if (atual && atual.desc.length && !atual.semValor) ignoradas.push(`${atual.data} ${atual.desc.join(' ')}`);
  return { linhas: out, ignoradas };
}

// ---------------- Planilha .xlsx (fatura aberta baixada do site do Itaú) ----------------
// Lê o .xlsx no próprio aparelho, sem biblioteca: o arquivo é um zip com XML dentro.
async function lerZip(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  let fim = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error('Arquivo .xlsx inválido.');
  const n = dv.getUint16(fim + 10, true); let p = dv.getUint32(fim + 16, true);
  const dec = new TextDecoder(); const arqs = {};
  for (let k = 0; k < n; k++) {
    const metodo = dv.getUint16(p + 10, true); const tam = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true); const le = dv.getUint16(p + 30, true); const lc = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true); const nome = dec.decode(u8.subarray(p + 46, p + 46 + ln));
    const ini = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    arqs[nome] = { metodo, dados: u8.subarray(ini, ini + tam) };
    p += 46 + ln + le + lc;
  }
  return async (nome) => {
    const a = arqs[nome]; if (!a) return null;
    if (a.metodo === 0) return dec.decode(a.dados);
    const s = new Blob([a.dados]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(s).text();
  };
}
const desXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).replace(/&amp;/g, '&');
const colunaN = (ref) => [...ref.replace(/\d+/g, '')].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// Devolve as linhas da primeira planilha como matriz de valores (texto ou número).
async function linhasXlsx(buf) {
  const ler = await lerZip(buf);
  const ss = await ler('xl/sharedStrings.xml');
  const compart = ss ? [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => desXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))) : [];
  const sheet = (await ler('xl/worksheets/sheet1.xml')) || '';
  const rows = [];
  for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const linha = [];
    for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (c[1].match(/r="([A-Z]+\d+)"/) || [])[1]; if (!ref) continue;
      const t = (c[1].match(/t="(\w+)"/) || [])[1]; const corpo = c[2] || '';
      const v = (corpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (t === 's') val = compart[Number(v)] ?? null;
      else if (t === 'inlineStr') val = desXml([...corpo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else if (t === 'str' || t === 'b') val = v != null ? desXml(v) : null;
      else if (v != null) val = Number(v);
      linha[colunaN(ref)] = val;
    }
    rows.push(linha);
  }
  return rows;
}
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
// Data em número de série do Excel ou em texto dd/mm/aaaa.
function dataCelula(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return d.toISOString().slice(0, 10); }
  const m = String(v ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export async function parseXlsxFatura(buf) {
  const rows = await linhasXlsx(buf);
  let cab = -1; let col = {};
  let vencimento = null; let totalParcial = null; let nomeCartao = '';
  rows.forEach((r, i) => {
    r.forEach((v, j) => {
      const t = semAcento(v);
      if (t === 'vencimento' && rows[i + 1]) vencimento = dataCelula(rows[i + 1][j]) || vencimento;
      if (t.startsWith('valor (parcial)') || t === 'valor total' || t === 'total da fatura') { const n = rows[i + 1]?.[j]; if (typeof n === 'number') totalParcial = n; }
      if (t === 'cartao' && rows[i + 1]) nomeCartao = String(rows[i + 1][j] ?? '');
    });
    if (cab < 0) {
      const idx = (nome) => r.findIndex((v) => semAcento(v) === nome);
      if (idx('data') >= 0 && idx('lancamento') >= 0 && idx('valor') >= 0) { cab = i; col = { data: idx('data'), desc: idx('lancamento'), valor: idx('valor'), parc: idx('parcelamento') }; }
    }
  });
  if (cab < 0) throw new Error('Não encontrei a tabela de lançamentos (colunas Data, Lançamento e Valor) nessa planilha.');
  const linhas = []; const ignoradas = [];
  for (const r of rows.slice(cab + 1)) {
    const data = dataCelula(r[col.data]); const desc = String(r[col.desc] ?? '').replace(/\s+/g, ' ').trim();
    const valor = typeof r[col.valor] === 'number' ? round2(r[col.valor]) : parseValor(r[col.valor]);
    if (!data || !desc || !Number.isFinite(valor) || valor === 0) { const txt = r.filter((x) => x != null && x !== '').join(' '); if (txt && data) ignoradas.push(txt); continue; }
    const mp = String(r[col.parc] ?? '').match(/(\d+)\s*(?:de|\/)\s*(\d+)/i);
    const parcela = mp ? { n: Number(mp[1]), total: Number(mp[2]) } : detectaParcela(desc);
    const tipo = valor < 0 && /^pagamento/i.test(desc) ? 'pagamento' : tipoPorValor(desc, valor);
    linhas.push({ data, desc, valor, tipo, parcela });
  }
  const banco = /ita[uú]/i.test(nomeCartao) ? 'itau' : /nubank/i.test(nomeCartao) ? 'nubank' : /mercado ?pago/i.test(nomeCartao) ? 'mercadopago' : null;
  return { banco, vencimento, totalParcial, linhas, ignoradas };
}
