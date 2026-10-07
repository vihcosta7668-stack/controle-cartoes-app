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
    if (/^Total/i.test(m[2])) continue;
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
    const tc = await page.getTextContent();
    pages.push({ width: vp.width, items: tc.items.filter((i) => typeof i.str === 'string').map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] })) });
  }
  await task.destroy();
  return pages;
}
