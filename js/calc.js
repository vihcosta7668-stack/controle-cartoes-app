// Regras de negócio: faturas, parcelas, previsões, quem me deve e cobranças.
// Puro (sem DOM) — usado pelo app e pelo lembrete diário no GitHub Actions.
import {
  round2, cents, ymd, partes, addMeses, addDias, difDias, difMeses, diasNoMes,
  normDesc, raizDesc, brl, dataBR, diaMes, semAcento,
} from './util.js';
import { pixCopiaECola } from './pix.js';

export const EU = 'eu';
export const MESES_PREVISAO = 12;

export const cartaoPorId = (dados, id) => dados.cartoes.find((c) => c.id === id);
export const pessoaPorId = (dados, id) => dados.pessoas.find((p) => p.id === id);
export const nomePessoa = (dados, id) => (id === EU ? 'Eu' : (pessoaPorId(dados, id)?.nome || id));
export const grupoPorId = (dados, id) => (dados.grupos || []).find((g) => g.id === id);

// ---------- ciclo do cartão ----------
// Compra feita em `data` cai em qual vencimento?
export function vencDaCompra(cartao, data) {
  const { y, m, d } = partes(data);
  let fech = ymd(y, m, Math.min(cartao.fechamento, diasNoMes(y, m)));
  if (d >= cartao.fechamento) fech = addMeses(fech, 1, cartao.fechamento);
  const mesesAteVenc = cartao.vencimento > cartao.fechamento ? 0 : 1;
  return addMeses(fech, mesesAteVenc, cartao.vencimento);
}
export const faturaAberta = (cartao, hoje) => vencDaCompra(cartao, hoje);
export const vencAnterior = (cartao, venc) => addMeses(venc, -1, cartao.vencimento);
export const vencSeguinte = (cartao, venc, n = 1) => addMeses(venc, n, cartao.vencimento);
export function fechamentoDe(cartao, venc) {
  const mesesAteVenc = cartao.vencimento > cartao.fechamento ? 0 : 1;
  return addMeses(venc, -mesesAteVenc, cartao.fechamento);
}

// ---------- partes de um lançamento ----------
export function pesosGrupo(g) {
  const total = g.participantes.reduce((s, p) => s + Number(p.peso || 0), 0) || 1;
  return { total, de: (pid) => Number(g.participantes.find((p) => p.pessoa === pid)?.peso || 0) / total };
}
export function minhaParte(dados, l) {
  if (l.tipo === 'pagamento') return 0;
  if (l.grupo) {
    const g = grupoPorId(dados, l.grupo);
    if (g) return round2(l.valor * pesosGrupo(g).de(EU));
  }
  const outros = (l.divisao || []).reduce((s, d) => s + Number(d.valor || 0), 0);
  return round2(l.valor - outros);
}
export function partesOutros(dados, l) {
  if (l.tipo === 'pagamento') return [];
  if (l.grupo) {
    const g = grupoPorId(dados, l.grupo);
    if (g) {
      const w = pesosGrupo(g);
      return g.participantes.filter((p) => p.pessoa !== EU).map((p) => ({ pessoa: p.pessoa, valor: round2(l.valor * w.de(p.pessoa)) }));
    }
  }
  return (l.divisao || []).map((d) => ({ pessoa: d.pessoa, valor: d.valor, pago: d.pago }));
}

// Divide `valor` entre pessoas (ids, podendo incluir EU) em partes iguais; centavos que sobram ficam comigo.
export function dividirIgual(valor, pessoas) {
  const n = pessoas.length || 1;
  const base = Math.floor(cents(valor) / n) / 100;
  return pessoas.filter((p) => p !== EU).map((p) => ({ pessoa: p, valor: round2(base), pago: false, pagoEm: null }));
}
export function escalarDivisao(divisao, de, para) {
  if (!divisao?.length) return [];
  const f = de ? para / de : 1;
  return divisao.map((d) => ({ pessoa: d.pessoa, valor: round2(d.valor * f), pago: false, pagoEm: null }));
}

// ---------- previsão (parcelas e fixos que ainda vão cair) ----------
const chaveCadeia = (l, n) => `${l.cartao}|${raizDesc(l.desc)}|${l.parcela.total}|${n}`;

// Linhas previstas (não lançadas ainda) para a fatura (cartao, venc).
export function previstasPara(dados, cartaoId, venc, hoje) {
  const cartao = cartaoPorId(dados, cartaoId);
  const aberta = hoje ? faturaAberta(cartao, hoje) : '9999-12-31';
  const reaisFechadas = new Set(dados.lancamentos.filter((l) => l.cartao === cartaoId && l.origem !== 'previsto' && l.origem !== 'manual' && l.venc < aberta).map((l) => l.venc));
  const doCartao = dados.lancamentos.filter((l) => l.cartao === cartaoId);
  const reais = doCartao.filter((l) => l.venc === venc);
  const presentes = new Map();
  for (const l of reais) if (l.parcela) { const k = chaveCadeia(l, l.parcela.n); presentes.set(k, (presentes.get(k) || 0) + 1); }
  const raizesPresentes = new Set(reais.map((l) => raizDesc(l.desc)));

  // parcelas: cada cadeia projetada a partir da fatura mais recente que a contém
  const porChave = new Map();
  for (const l of doCartao) {
    if (!l.parcela || l.tipo !== 'compra' || l.venc >= venc) continue;
    const n2 = l.parcela.n + difMeses(l.venc, venc);
    if (n2 > l.parcela.total) continue;
    const k = chaveCadeia(l, n2);
    const atual = porChave.get(k);
    if (!atual || l.venc > atual.venc) porChave.set(k, { venc: l.venc, linhas: [{ l, n2 }] });
    else if (l.venc === atual.venc) atual.linhas.push({ l, n2 });
  }
  const out = [];
  for (const [k, { linhas }] of porChave) {
    const jaTem = presentes.get(k) || 0;
    linhas.slice(jaTem).forEach(({ l, n2 }, i) => {
      out.push({
        id: `prev_${l.id}_${n2}_${i}`, cartao: cartaoId, venc, data: l.data,
        desc: l.desc.replace(/(\d{1,2})\s*\/\s*(\d{1,2})\s*$/, (_, a, b) => `${String(n2).padStart(a.length, '0')}/${b}`),
        valor: l.valor, tipo: 'compra', parcela: { n: n2, total: l.parcela.total }, fixo: false,
        divisao: escalarDivisao(l.divisao, l.valor, l.valor), grupo: l.grupo || null, origem: 'projecao', previsto: true,
      });
    });
  }
  // fixos: última ocorrência de cada gasto fixo nos 3 meses anteriores
  const fixos = new Map();
  for (const l of doCartao) {
    if (!l.fixo || l.parcela || l.tipo !== 'compra' || l.venc >= venc) continue;
    if (difMeses(l.venc, hoje ? aberta : venc) > 3) continue; // sem aparecer há 3+ meses: inativo
    const r = raizDesc(l.desc);
    if (!fixos.has(r) || l.venc > fixos.get(r).venc) fixos.set(r, l);
  }
  for (const [r, l] of fixos) {
    if (l.fixoEncerrado) continue; // cancelado ou mudou de cartão
    if (raizesPresentes.has(r)) continue;
    // se uma fatura fechada posterior não trouxe esse fixo, ele foi cancelado
    if ([...reaisFechadas].some((v) => v > l.venc && v < venc)) continue;
    out.push({
      id: `prev_${l.id}_fixo_${venc}`, cartao: cartaoId, venc, data: null, desc: l.desc, valor: l.valorPrevisto ?? l.valor,
      tipo: 'compra', parcela: null, fixo: true, divisao: escalarDivisao(l.divisao, l.valor, l.valorPrevisto ?? l.valor),
      grupo: l.grupo || null, origem: 'projecao', previsto: true,
    });
  }
  return out;
}

// Resumo de uma fatura
export function resumoFatura(dados, cartaoId, venc, hoje) {
  const cartao = cartaoPorId(dados, cartaoId);
  const aberta = faturaAberta(cartao, hoje);
  const linhas = dados.lancamentos.filter((l) => l.cartao === cartaoId && l.venc === venc && l.tipo !== 'pagamento');
  const projetadas = venc >= aberta ? previstasPara(dados, cartaoId, venc, hoje) : [];
  const lancadas = linhas.filter((l) => l.origem !== 'previsto');
  const previstas = [...linhas.filter((l) => l.origem === 'previsto'), ...projetadas];
  const soma = (arr, f) => round2(arr.reduce((s, l) => s + f(l), 0));
  const total = soma(lancadas, (l) => l.valor);
  const totalPrevisto = soma(previstas, (l) => l.valor);
  const pagamentos = dados.lancamentos.filter((l) => l.cartao === cartaoId && l.tipo === 'pagamento' && (l.refVenc || l.venc) === venc);
  const pago = round2(-soma(pagamentos, (l) => l.valor));
  const todas = [...lancadas, ...previstas];
  const minha = soma(todas, (l) => minhaParte(dados, l));
  const meta = (dados.faturas || []).find((f) => f.cartao === cartaoId && f.venc === venc) || null;
  const estado = venc < aberta ? 'fechada' : (venc === aberta ? 'aberta' : 'futura');
  const totalGeral = round2(total + totalPrevisto);
  return {
    cartao, venc, estado, fechamento: fechamentoDe(cartao, venc), lancadas, previstas, pagamentos,
    total, totalPrevisto, totalGeral, pago, faltaPagar: round2(Math.max(0, (estado === 'fechada' ? total : totalGeral) - pago)),
    minha, outros: round2(totalGeral - minha), meta,
  };
}

// Como fechar a fatura: o que ainda me devem nela (por pessoa), o que já recebi dos outros
// e quanto sai do meu bolso. Sempre fecha: faltaPagar = pendente + doBolso.
export function fechamentoFatura(dados, r, hoje) {
  const porPessoa = new Map();
  const soma = (pid, v) => porPessoa.set(pid, round2((porPessoa.get(pid) || 0) + v));
  for (const it of itensAReceber(dados, hoje)) {
    if (it.cartao === r.cartao.id && it.venc === r.venc && !it.pago && it.falta > 0.004) soma(it.pessoa, it.falta);
  }
  // parcelas e fixos projetados ainda não são itens a receber, mas já contam em "Dos outros"
  for (const l of r.previstas) {
    if (l.origem !== 'projecao' || l.grupo) continue;
    for (const p of partesOutros(dados, l)) if (p.pessoa !== EU) soma(p.pessoa, p.valor);
  }
  const pessoas = [...porPessoa].map(([pessoa, falta]) => ({ pessoa, falta })).sort((a, b) => b.falta - a.falta);
  const pendente = round2(pessoas.reduce((s, p) => s + p.falta, 0));
  const recebido = round2(r.outros - pendente);
  const devido = r.estado === 'fechada' ? r.total : r.totalGeral;
  const doBolso = round2(devido - r.pago - pendente);
  return { pessoas, pendente, recebido, doBolso };
}

// Vencimentos que existem para um cartão (com lançamentos) + aberta + próximas
export function vencimentosDoCartao(dados, cartaoId, hoje, futuras = 2) {
  const cartao = cartaoPorId(dados, cartaoId);
  const s = new Set(dados.lancamentos.filter((l) => l.cartao === cartaoId).map((l) => l.venc));
  const ab = faturaAberta(cartao, hoje);
  for (let i = 0; i <= futuras; i++) s.add(vencSeguinte(cartao, ab, i));
  return [...s].sort();
}

// Próximos meses: total por mês (por vencimento), minha parte x dos outros, por cartão.
// Agrupado pelo mês do vencimento (mês em que a fatura é paga). Só faturas abertas/futuras.
export function previsaoMeses(dados, hoje, meses = MESES_PREVISAO) {
  const linhas = [];
  const inicio = dados.cartoes.map((c) => faturaAberta(c, hoje)).sort()[0].slice(0, 7) + '-01';
  for (let k = 0; k < meses; k++) {
    const mes = addMeses(inicio, k).slice(0, 7);
    const linha = { k, porCartao: {}, total: 0, minha: 0, outros: 0, parcelas: 0, fixos: 0, mes };
    for (const c of dados.cartoes) {
      const v = addMeses(mes + '-01', 0, c.vencimento);
      if (v < faturaAberta(c, hoje)) continue;
      const r = resumoFatura(dados, c.id, v, hoje);
      linha.porCartao[c.id] = { venc: v, total: r.totalGeral, minha: r.minha };
      linha.total += r.totalGeral; linha.minha += r.minha; linha.outros += r.outros;
      for (const l of [...r.lancadas, ...r.previstas]) {
        if (l.parcela) linha.parcelas += l.valor; else if (l.fixo) linha.fixos += l.valor;
      }
    }
    for (const f of ['total', 'minha', 'outros', 'parcelas', 'fixos']) linha[f] = round2(linha[f]);
    linhas.push(linha);
  }
  return linhas;
}

// Parcelamentos em andamento (cadeias) e gastos fixos
export function parcelamentos(dados, hoje) {
  const cadeias = new Map();
  for (const l of dados.lancamentos) {
    if (!l.parcela || l.tipo !== 'compra') continue;
    // a cadeia é identificada pelo mês de início (vencimento - n), que é igual em todas as parcelas
    const base = `${l.cartao}|${raizDesc(l.desc)}|${l.parcela.total}|${addMeses(l.venc, -l.parcela.n).slice(0, 7)}`;
    const atual = cadeias.get(base);
    if (!atual || l.venc > atual.venc) cadeias.set(base, l);
  }
  const out = [];
  for (const l of cadeias.values()) {
    const c = cartaoPorId(dados, l.cartao);
    const ab = faturaAberta(c, hoje);
    const ultimaVenc = vencSeguinte(c, l.venc, l.parcela.total - l.parcela.n);
    if (ultimaVenc < ab) continue; // já terminou
    const faltam = l.parcela.total - l.parcela.n;
    const minha = minhaParte(dados, l);
    out.push({
      l, cartao: l.cartao, desc: l.desc.replace(/\s*-?\s*(parcela\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*$/i, ''),
      valor: l.valor, n: l.parcela.n, total: l.parcela.total, faltam, ultimaVenc,
      restante: round2(l.valor * faltam), restanteMinha: round2(minha * faltam), restanteOutros: round2((l.valor - minha) * faltam),
      outros: partesOutros(dados, l),
    });
  }
  return out.sort((a, b) => a.ultimaVenc.localeCompare(b.ultimaVenc) || b.valor - a.valor);
}
export function gastosFixos(dados, hoje) {
  const ult = new Map();
  for (const l of dados.lancamentos) {
    if (!l.fixo || l.parcela || l.tipo !== 'compra') continue;
    const k = `${l.cartao}|${raizDesc(l.desc)}`;
    if (!ult.has(k) || l.venc > ult.get(k).venc) ult.set(k, l);
  }
  return [...ult.values()].filter((l) => {
    if (l.fixoEncerrado) return false;
    const c = cartaoPorId(dados, l.cartao);
    const ab = faturaAberta(c, hoje);
    if (difMeses(l.venc, ab) > 3) return false;
    // cancelado: uma fatura fechada posterior veio sem ele
    return !dados.lancamentos.some((x) => x.cartao === l.cartao && x.venc > l.venc && x.venc < ab && ['csv', 'pdf', 'planilha'].includes(x.origem));
  }).map((l) => ({ l, minha: minhaParte(dados, l), outros: partesOutros(dados, l) }));
}

// ---------- compras em grupo ----------
// Cronograma de cada participante: entradas {venc, valor, rotulo}
export function cronogramaGrupo(dados, g) {
  const c = cartaoPorId(dados, g.cartao);
  const w = pesosGrupo(g);
  const res = {};
  for (const p of g.participantes) {
    const f = w.de(p.pessoa);
    const ent = [];
    if (g.avista && g.avista.valor) ent.push({ venc: g.avista.venc, valor: round2(g.avista.valor * f), rotulo: 'À vista' });
    if (g.parcelado && g.parcelado.total) {
      const parc = g.parcelado.total / g.parcelado.parcelas;
      for (let k = 1; k <= g.parcelado.parcelas; k++) {
        ent.push({ venc: vencSeguinte(c, g.parcelado.primeiraVenc, k - 1), valor: round2(parc * f), rotulo: `Parcela ${k}/${g.parcelado.parcelas}` });
      }
    }
    if (g.extras) for (const e of g.extras) ent.push({ venc: e.venc, valor: round2(e.valor * f), rotulo: e.desc || 'Extra' });
    ent.sort((a, b) => a.venc.localeCompare(b.venc));
    // centavos: a última entrada absorve o arredondamento para o total da pessoa bater
    const alvo = round2(((g.avista?.valor || 0) + (g.parcelado?.total || 0) + (g.extras || []).reduce((s, e) => s + e.valor, 0)) * f);
    if (ent.length) { const soma = round2(ent.reduce((s, e) => s + e.valor, 0)); ent[ent.length - 1].valor = round2(ent[ent.length - 1].valor + alvo - soma); }
    const devido = round2(ent.reduce((s, e) => s + e.valor, 0));
    const pagos = (g.pagamentos || []).filter((x) => x.pessoa === p.pessoa);
    const pago = round2(pagos.reduce((s, x) => s + Number(x.valor), 0));
    // distribui o que foi pago nas entradas em ordem (mais antiga primeiro)
    let saldo = pago;
    for (const e of ent) {
      const usa = Math.min(saldo, e.valor);
      e.pago = round2(usa); e.falta = round2(e.valor - usa); saldo = round2(saldo - usa);
    }
    res[p.pessoa] = { peso: p.peso, fracao: f, entradas: ent, devido, pago, falta: round2(Math.max(0, devido - pago)), pagamentos: pagos };
  }
  return res;
}

// ---------- quem me deve ----------
// Itens a receber (pendentes ou pagos), de lançamentos e de grupos.
export function itensAReceber(dados, hoje) {
  const itens = [];
  for (const l of dados.lancamentos) {
    if (l.tipo === 'pagamento' || l.grupo) continue;
    for (const d of l.divisao || []) {
      if (d.pessoa === EU) continue;
      itens.push({
        id: `${l.id}|${d.pessoa}`, tipo: 'linha', lancId: l.id, pessoa: d.pessoa, cartao: l.cartao, venc: l.venc,
        data: l.data, desc: l.desc, valor: round2(d.valor), falta: d.pago ? 0 : round2(d.valor), pago: !!d.pago, pagoEm: d.pagoEm || null,
        previsto: l.origem === 'previsto',
      });
    }
  }
  for (const g of dados.grupos || []) {
    const cr = cronogramaGrupo(dados, g);
    for (const [pid, info] of Object.entries(cr)) {
      if (pid === EU) continue;
      info.entradas.forEach((e, i) => itens.push({
        id: `${g.id}|${pid}|${i}`, tipo: 'grupo', grupoId: g.id, pessoa: pid, cartao: g.cartao, venc: e.venc,
        data: null, desc: `${g.nome} — ${e.rotulo}`, valor: e.valor, falta: e.falta, pago: e.falta <= 0.004, pagoParcial: e.pago,
      }));
    }
  }
  return itens.map((it) => ({ ...it, situacao: situacaoItem(dados, it, hoje) }));
}
export function situacaoItem(dados, it, hoje) {
  if (it.pago) return 'pago';
  const c = cartaoPorId(dados, it.cartao);
  if (it.venc < hoje) return 'atrasado';
  if (difDias(hoje, it.venc) <= 2) return 'cobrar';
  if (it.venc <= faturaAberta(c, hoje)) return 'aberto';
  return 'futuro';
}

// Parcelas futuras (ainda não lançadas) que vão gerar dívida por pessoa
// Parcelas que ainda nem estão em nenhuma fatura (projeção). { pessoa: { total, itens } }
export function futurasPorPessoa(dados, hoje, meses = 24) {
  const out = {};
  for (const c of dados.cartoes) {
    const ab = faturaAberta(c, hoje);
    for (let k = 0; k < meses; k++) {
      const v = vencSeguinte(c, ab, k);
      for (const l of previstasPara(dados, c.id, v, hoje)) {
        if (l.grupo || l.fixo) continue; // grupos entram pelo cronograma; fixos não são dívida futura
        for (const d of l.divisao || []) {
          if (d.pessoa === EU) continue;
          out[d.pessoa] ||= { total: 0, itens: [] };
          out[d.pessoa].total = round2(out[d.pessoa].total + d.valor);
          out[d.pessoa].itens.push({ id: `${l.id}|${d.pessoa}`, tipo: 'projecao', pessoa: d.pessoa, cartao: c.id, venc: v, desc: l.desc, valor: d.valor, falta: d.valor, pago: false, situacao: 'futuro' });
        }
      }
    }
  }
  return out;
}

export function resumoPessoas(dados, hoje) {
  const itens = itensAReceber(dados, hoje);
  const futuras = futurasPorPessoa(dados, hoje);
  const res = dados.pessoas.filter((p) => p.id !== EU).map((p) => {
    const meus = itens.filter((i) => i.pessoa === p.id);
    const pend = meus.filter((i) => !i.pago && i.situacao !== 'futuro');
    const fut = meus.filter((i) => i.situacao === 'futuro');
    const proj = futuras[p.id] || { total: 0, itens: [] };
    return {
      pessoa: p, itens: meus, projetados: proj.itens,
      falta: round2(pend.reduce((s, i) => s + i.falta, 0)),
      atrasado: round2(pend.filter((i) => i.situacao === 'atrasado').reduce((s, i) => s + i.falta, 0)),
      cobrarAgora: pend.some((i) => i.situacao === 'cobrar' || i.situacao === 'atrasado'),
      futuro: round2(fut.reduce((s, i) => s + i.falta, 0) + proj.total),
      pago: round2(meus.reduce((s, i) => s + (i.tipo === 'grupo' ? (i.pagoParcial || 0) : (i.pago ? i.valor : 0)), 0)),
    };
  });
  return res.sort((a, b) => b.falta - a.falta || b.futuro - a.futuro);
}

// ---------- cobranças ----------
// Cobranças por pessoa e cartão cujo dia de cobrança (vencimento - diasAntes) já chegou.
export function cobrancasDevidas(dados, hoje, diasAntes = 2) {
  const itens = itensAReceber(dados, hoje).filter((i) => !i.pago && i.falta > 0.004 && i.situacao !== 'futuro' && difDias(hoje, i.venc) <= diasAntes);
  const mapa = new Map();
  for (const it of itens) {
    const k = `${it.pessoa}|${it.cartao}`;
    if (!mapa.has(k)) mapa.set(k, { pessoa: it.pessoa, cartao: it.cartao, itens: [] });
    mapa.get(k).itens.push(it);
  }
  return [...mapa.values()].map((c) => {
    c.itens.sort((a, b) => a.venc.localeCompare(b.venc));
    c.total = round2(c.itens.reduce((s, i) => s + i.falta, 0));
    c.venc = c.itens[c.itens.length - 1].venc;
    c.primeiroDia = difDias(hoje, c.venc) === diasAntes; // hoje é exatamente o D-2
    return c;
  }).sort((a, b) => a.venc.localeCompare(b.venc));
}

export function mensagemCobranca(dados, cob, hoje) {
  const p = pessoaPorId(dados, cob.pessoa);
  const c = cartaoPorId(dados, cob.cartao);
  const primeiro = (p?.nome || '').split(' ')[0];
  const linhas = cob.itens.map((i) => {
    const atras = i.venc < hoje ? ` (venceu ${diaMes(i.venc)})` : '';
    return `• ${i.desc}: ${brl(i.falta)}${atras}`;
  });
  const vence = cob.venc >= hoje ? `a fatura vence em ${dataBR(cob.venc)}` : `a fatura venceu em ${dataBR(cob.venc)}`;
  let msg = `Oi, ${primeiro}! Passando pra lembrar do que ficou no meu cartão ${c.nome} — ${vence}.\n\n${linhas.join('\n')}\n\nTotal: ${brl(cob.total)}`;
  const pix = c.pix || {};
  if (pix.chave) {
    msg += `\n\nPix (${pix.banco || c.nome}): ${pix.chave}`;
    if (pix.nome) msg += ` — ${pix.nome}`;
    try {
      const code = pixCopiaECola({ chave: pix.chave, tipo: pix.tipo, nome: pix.nome || 'RECEBEDOR', cidade: pix.cidade || 'BRASIL', valor: cob.total });
      msg += `\n\nPix copia e cola:\n${code}`;
    } catch { /* chave inválida: manda só a chave */ }
  }
  msg += '\n\nObrigada!';
  return msg;
}
export function linkWhatsApp(dados, cob, texto) {
  const p = pessoaPorId(dados, cob.pessoa);
  const tel = String(p?.telefone || '').replace(/\D/g, '');
  const num = tel ? (tel.length <= 11 ? `55${tel}` : tel) : '';
  return `https://wa.me/${num}?text=${encodeURIComponent(texto)}`;
}

// ---------- conciliação Nubank (pagamentos de qual fatura?) ----------
// linhas: as do arquivo. Retorna sugestão de quais pagamentos são desta fatura.
export function conciliar(linhas, cartao, venc, valorInformado) {
  const anterior = vencAnterior(cartao, venc);
  const compras = round2(linhas.filter((l) => l.tipo === 'compra').reduce((s, l) => s + l.valor, 0));
  const creditos = round2(linhas.filter((l) => l.tipo === 'estorno').reduce((s, l) => s + l.valor, 0));
  const pags = linhas.map((l, idx) => ({ ...l, idx })).filter((l) => l.tipo === 'pagamento')
    .map((l) => ({ idx: l.idx, data: l.data, valor: l.valor, refSugerido: l.data <= anterior ? anterior : venc }));
  const calc = (refs) => round2(compras + creditos + pags.reduce((s, p) => s + (refs[p.idx] === venc ? p.valor : 0), 0));
  const padrao = Object.fromEntries(pags.map((p) => [p.idx, p.refSugerido]));
  const res = { anterior, compras, creditos, pagamentos: pags, refs: padrao, totalCalculado: calc(padrao), valorInformado, diferenca: null, ok: null, alternativa: null };
  if (valorInformado == null || !Number.isFinite(valorInformado)) return res;
  res.diferenca = round2(valorInformado - res.totalCalculado);
  res.ok = Math.abs(res.diferenca) < 0.01;
  if (!res.ok && pags.length && pags.length <= 16) {
    let melhor = null;
    for (let mask = 0; mask < (1 << pags.length); mask++) {
      const refs = {}; let trocas = 0;
      pags.forEach((p, i) => { refs[p.idx] = (mask >> i) & 1 ? venc : anterior; if (refs[p.idx] !== p.refSugerido) trocas++; });
      if (Math.abs(calc(refs) - valorInformado) < 0.01 && (!melhor || trocas < melhor.trocas)) melhor = { refs, trocas };
    }
    if (melhor) res.alternativa = melhor.refs;
  }
  return res;
}

export { semAcento, normDesc };
