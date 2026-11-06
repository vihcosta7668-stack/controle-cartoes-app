// Casa e viagens: regras puras sobre o arquivo compartilhado (compartilhado.json)
// e a checagem "cabe no meu bolso?", que cruza esse arquivo com os dados pessoais de quem está usando.
import { round2, addMeses, addDias, difMeses, slug, uid, normDesc, partes, ymd, diasNoMes } from './util.js';
import { previsaoMeses, vencDaCompra, cartaoPorId, faturaAberta, resumoFatura, previstasPara, minhaParte, vencSeguinte, fechamentoFatura } from './calc.js';

export const ETAPAS_PADRAO = [
  'Lote', 'Projeto, documentação e taxas', 'Fundação (radier)', 'Estrutura metálica', 'Alvenaria',
  'Laje e cobertura', 'Instalações elétricas e hidráulicas', 'Esquadrias (portas e janelas)', 'Revestimentos e acabamento', 'Pintura',
];
export const CATEGORIAS_VIAGEM = [
  'Passagens', 'Hospedagem', 'Deslocamento até o aeroporto/rodoviária', 'Transporte no destino', 'Alimentação',
  'Passeios e ingressos', 'Seguro viagem', 'Documentos e taxas', 'Compras', 'Imprevistos',
];

export function compartilhadoVazio(nomeMembro) {
  return {
    versao: 1, atualizadoEm: new Date().toISOString(),
    membros: [{ id: slug(nomeMembro), nome: nomeMembro.trim() }],
    casa: {
      etapas: ETAPAS_PADRAO.map((nome) => ({ id: uid('e'), nome, previsto: null, concluida: false, pagamentos: [] })),
      saldos: [],
    },
    viagens: [],
  };
}
export function migrarCompartilhado(d) {
  d.membros ||= []; d.casa ||= { etapas: [], saldos: [] }; d.casa.etapas ||= []; d.casa.saldos ||= []; d.viagens ||= [];
  return d;
}
export const membroPorId = (comp, id) => comp.membros.find((m) => m.id === id);
export const nomeMembro = (comp, id) => membroPorId(comp, id)?.nome || id;
export const outroMembro = (comp, id) => comp.membros.find((m) => m.id !== id) || null;

// ======================= CASA =======================
export const pagoEtapa = (e) => round2((e.pagamentos || []).reduce((s, p) => s + Number(p.valor || 0), 0));

// Último saldo informado por cada membro e a variação em relação ao registro anterior dele.
export function saldosPorMembro(comp) {
  return comp.membros.map((m) => {
    const regs = comp.casa.saldos.filter((s) => s.membro === m.id).sort((a, b) => a.data.localeCompare(b.data) || (a.em || '').localeCompare(b.em || ''));
    const ult = regs[regs.length - 1] || null;
    const ant = regs[regs.length - 2] || null;
    return { membro: m, valor: ult ? round2(ult.valor) : 0, data: ult?.data || null, anterior: ant, variacao: ult && ant ? round2(ult.valor - ant.valor) : null, registros: regs };
  });
}

export function resumoCasa(comp) {
  const etapas = comp.casa.etapas.map((e) => {
    const pago = pagoEtapa(e);
    const previsto = e.previsto == null ? null : round2(e.previsto);
    const falta = e.concluida || previsto == null ? 0 : round2(Math.max(0, previsto - pago));
    const estado = e.concluida ? 'concluida' : (pago > 0 ? 'andamento' : 'apagar');
    return { e, pago, previsto, falta, estado, estouro: previsto != null && pago > previsto + 0.004 ? round2(pago - previsto) : 0 };
  });
  const saldos = saldosPorMembro(comp);
  const guardado = round2(saldos.reduce((s, x) => s + x.valor, 0));
  const previstoTotal = round2(etapas.reduce((s, x) => s + (x.previsto ?? 0), 0));
  const pagoTotal = round2(etapas.reduce((s, x) => s + x.pago, 0));
  const faltaTotal = round2(etapas.reduce((s, x) => s + x.falta, 0));
  const semPrevisto = etapas.filter((x) => x.previsto == null && !x.e.concluida).length;
  // Até onde o guardado alcança, seguindo a ordem das etapas que ainda têm valor a pagar.
  let resta = guardado; const cobertas = []; let proxima = null;
  for (const x of etapas) {
    if (x.falta <= 0) continue;
    if (resta >= x.falta) { cobertas.push(x); resta = round2(resta - x.falta); } else { proxima = { ...x, faltaParaCobrir: round2(x.falta - resta) }; break; }
  }
  return { etapas, saldos, guardado, previstoTotal, pagoTotal, faltaTotal, semPrevisto, cobertas, proxima, sobraDepois: proxima ? 0 : resta };
}

// ======================= VIAGENS =======================
export const totalViagem = (v) => round2(v.itens.reduce((s, i) => s + Number(i.valor || 0), 0));

// Quanto do item é custo de cada membro.
export function partesItem(comp, item) {
  const outro = outroMembro(comp, item.pagador);
  const p = outro ? Math.min(1, Math.max(0, Number(item.parteOutro || 0))) : 0;
  const out = { [item.pagador]: round2(item.valor * (1 - p)) };
  if (outro && p > 0) out[outro.id] = round2(item.valor - out[item.pagador]);
  return out;
}

export function resumoViagem(comp, v) {
  const total = totalViagem(v);
  const limite = Number(v.limite || 0);
  const comprado = round2(v.itens.filter((i) => i.status === 'comprado').reduce((s, i) => s + i.valor, 0));
  const porCategoria = new Map();
  for (const i of v.itens) porCategoria.set(i.categoria, round2((porCategoria.get(i.categoria) || 0) + i.valor));
  const porMembro = Object.fromEntries(comp.membros.map((m) => [m.id, 0]));
  for (const i of v.itens) for (const [mid, val] of Object.entries(partesItem(comp, i))) porMembro[mid] = round2((porMembro[mid] || 0) + val);
  const semEstimativa = CATEGORIAS_VIAGEM.filter((c) => !porCategoria.has(c));
  return { total, limite, disponivel: round2(limite - total), comprado, aComprar: round2(total - comprado), porCategoria, porMembro, semEstimativa, pct: limite > 0 ? total / limite : 0 };
}

// Saídas de dinheiro de um item para o membro `eu`, por mês (AAAA-MM).
// Cartão: mês do vencimento de cada parcela (no meu cartão, pelo ciclo dele; no do outro, a partir do mês seguinte à compra).
// Pix/débito/dinheiro: mês da compra. O que eu mesmo já comprei não entra (no cartão está nas faturas; à vista já saiu).
// A parte que eu devolvo a quem pagou continua contando, comprado ou não.
export function saidasDoItem(comp, item, eu, dadosPessoais, hoje) {
  if (item.status === 'comprado' && item.pagador === eu) return [];
  const minha = partesItem(comp, item)[eu] || 0;
  if (minha <= 0) return [];
  const data = !item.data || item.data < hoje ? hoje : item.data;
  if (item.forma !== 'cartao') return [{ mes: data.slice(0, 7), valor: round2(minha) }];
  const n = Math.max(1, Math.min(48, Number(item.parcelas || 1)));
  const c = item.pagador === eu && item.cartao ? cartaoPorId(dadosPessoais, item.cartao) : null;
  const primeiro = c ? vencDaCompra(c, data) : addMeses(data.slice(0, 7) + '-01', 1);
  const base = Math.floor(round2(minha) * 100 / n) / 100;
  return Array.from({ length: n }, (_, k) => ({ mes: addMeses(primeiro, k).slice(0, 7), valor: k === n - 1 ? round2(minha - base * (n - 1)) : base }));
}

/**
 * Mês a mês: renda − contas fora do cartão − guardar para a casa − minha parte das faturas − viagens planejadas.
 * @param opts.extra  item avulso (ainda não salvo) para simular o impacto
 * @param opts.semItem id de item a desconsiderar (ao editar, para comparar antes/depois)
 */
export function viabilidade(comp, eu, dadosPessoais, hoje, { meses: minMeses = 6, extra = null, semItem = null } = {}) {
  const orc = dadosPessoais.orcamento;
  if (!orc || !(rendaMensal(orc) > 0)) return { semRenda: true };
  const itens = [];
  for (const v of comp.viagens) for (const i of v.itens) if (i.id !== semItem) itens.push({ v, i });
  if (extra) itens.push({ v: extra.viagem, i: extra.item });

  const porMes = new Map(); const porMesViagem = new Map();
  let ultimo = hoje.slice(0, 7);
  for (const { v, i } of itens) {
    for (const s of saidasDoItem(comp, i, eu, dadosPessoais, hoje)) {
      porMes.set(s.mes, round2((porMes.get(s.mes) || 0) + s.valor));
      const k = `${s.mes}|${v.id}`; porMesViagem.set(k, round2((porMesViagem.get(k) || 0) + s.valor));
      if (s.mes > ultimo) ultimo = s.mes;
    }
  }
  const n = Math.min(24, Math.max(minMeses, difMeses(hoje.slice(0, 7) + '-01', ultimo + '-01') + 1));
  const faturas = new Map(dadosPessoais.cartoes.length ? previsaoMeses(dadosPessoais, hoje, n + 1).map((m) => [m.mes, m]) : []);
  // Mês atual: a previsão só olha faturas abertas; as que já fecharam e vencem neste mês também saem do salário dele.
  const fechadasMes = faturasFechadasDoMes(dadosPessoais, hoje);
  const renda = rendaMensal(orc);
  const contas = round2(Number(orc.compromissos || 0));
  const casa = round2(Number(orc.guardarCasa || 0));
  const margem = round2(renda * Math.max(0, Number(orc.margem ?? 0.1)));
  const linhas = [];
  for (let k = 0; k < n; k++) {
    const mes = addMeses(hoje.slice(0, 7) + '-01', k).slice(0, 7);
    const f = faturas.get(mes);
    const extra = k === 0 ? fechadasMes : { minha: 0, total: 0 };
    const fat = round2((f?.minha || 0) + extra.minha);
    const viagens = round2(porMes.get(mes) || 0);
    const sobra = round2(renda - contas - casa - fat - viagens);
    linhas.push({ mes, renda, contas, casa, faturas: fat, faturasTotal: round2((f?.total || 0) + extra.total), viagens, sobra, estado: sobra < 0 ? 'bad' : (sobra < margem ? 'warn' : 'ok') });
  }
  const pior = linhas.reduce((a, b) => (b.sobra < a.sobra ? b : a), linhas[0]);
  const estado = linhas.some((l) => l.estado === 'bad') ? 'bad' : (linhas.some((l) => l.estado === 'warn') ? 'warn' : 'ok');
  return { linhas, pior, estado, margem, porMesViagem };
}

// Faturas que vencem no mês de `hoje` mas já fecharam. Sem fatura importada, usa as parcelas e fixos previstos.
export function faturasFechadasDoMes(dados, hoje) {
  let minha = 0; let total = 0;
  for (const c of dados.cartoes) {
    const v = addMeses(hoje.slice(0, 7) + '-01', 0, c.vencimento);
    if (v >= faturaAberta(c, hoje)) continue; // aberta: já está na previsão
    const temLanc = dados.lancamentos.some((l) => l.cartao === c.id && l.venc === v && l.tipo !== 'pagamento');
    if (temLanc) { const r = resumoFatura(dados, c.id, v, hoje); minha += r.minha; total += r.total; }
    else for (const l of previstasPara(dados, c.id, v, hoje)) { minha += minhaParte(dados, l); total += l.valor; }
  }
  return { minha: round2(minha), total: round2(total) };
}

// Lançamento manual (1ª parcela) que entra na fatura do pagador quando ele marca o item como comprado no cartão.
// Quando a fatura for importada, o importador troca este lançamento pelo do banco (mesmo valor, até 3 dias de diferença).
export function lancamentoDoItem(comp, viagem, item, dadosPessoais, pessoaOutroId) {
  const c = cartaoPorId(dadosPessoais, item.cartao);
  if (!c) throw new Error('Escolha em qual cartão a compra foi feita.');
  const n = Math.max(1, Number(item.parcelas || 1));
  const parcela = Math.floor(round2(item.valor) * 100 / n) / 100;
  const p = Math.min(1, Math.max(0, Number(item.parteOutro || 0)));
  const desc = `${item.desc || item.categoria} (viagem ${viagem.nome})${n > 1 ? ` - Parcela 1/${n}` : ''}`;
  return {
    id: uid('l'), cartao: c.id, venc: vencDaCompra(c, item.data), data: item.data, desc, valor: parcela, tipo: 'compra',
    parcela: n > 1 ? { n: 1, total: n } : null, fixo: false,
    divisao: p > 0 && pessoaOutroId ? [{ pessoa: pessoaOutroId, valor: round2(parcela * p), pago: false, pagoEm: null }] : [],
    grupo: null, obs: `viagem:${viagem.id}:${item.id}`, origem: 'manual', refVenc: null,
  };
}

// Encontra (ou cria) a pessoa da lista pessoal que corresponde ao outro membro, pelo nome.
export function pessoaParaMembro(dadosPessoais, membro) {
  if (!membro) return null;
  const alvo = normDesc(membro.nome);
  const achada = dadosPessoais.pessoas.find((p) => p.id !== 'eu' && (normDesc(p.nome) === alvo || normDesc(p.nome).split(' ')[0] === alvo.split(' ')[0]));
  if (achada) return { id: achada.id, nova: null };
  const id = dadosPessoais.pessoas.some((p) => p.id === membro.id) ? uid('p') : membro.id;
  return { id, nova: { id, nome: membro.nome, telefone: '' } };
}

// ======================= SALÁRIO x FATURAS =======================
// orcamento.salario = { adiant: { valor, dia, util }, saldo: { valor, dia, util }, contasNo: 'saldo' | 'adiant' | 'dividir' }
// valor = o que cai na conta (já sem INSS, refeição, plano e demais descontos do holerite).
// dia = dia do mês; util = true quando é o "N-ésimo dia útil".
export const PAGAMENTOS = [['adiant', 'Adiantamento'], ['saldo', 'Salário']];
const pagOk = (p) => p && Number(p.valor) > 0 && Number(p.dia) >= 1;
export const salarioConfigurado = (orc) => !!orc?.salario && PAGAMENTOS.every(([k]) => pagOk(orc.salario[k]));
// Com os dois pagamentos preenchidos, a renda do mês é a soma deles.
export function rendaMensal(orc) {
  if (salarioConfigurado(orc)) return round2(Number(orc.salario.adiant.valor) + Number(orc.salario.saldo.valor));
  return round2(Number(orc?.renda || 0));
}
const fimDeSemana = (iso) => { const { y, m, d } = partes(iso); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 || w === 6; };
// Data do pagamento num mês. Dia fixo que cai no sábado/domingo vai para a sexta anterior (feriados não são considerados).
export function dataPagamento(p, y, m) {
  const dia = Math.max(1, Math.min(31, Math.round(Number(p.dia))));
  if (p.util) {
    let d = ymd(y, m, 1); let n = 0;
    for (let i = 0; i < 31; i++, d = addDias(d, 1)) { if (!fimDeSemana(d) && ++n === dia) return d; }
    return d;
  }
  let d = ymd(y, m, Math.min(dia, diasNoMes(y, m)));
  while (fimDeSemana(d)) d = addDias(d, -1);
  return d;
}

// Períodos entre um pagamento e o seguinte, começando pelo que está em curso hoje.
// Em cada período: o que entra, as contas fixas e casa (no pagamento escolhido) e as faturas que vencem nele.
export function periodosSalario(dados, hoje, n = 4) {
  const orc = dados.orcamento;
  if (!salarioConfigurado(orc)) return null;
  const sal = orc.salario;
  const datas = [];
  for (let k = -2; k <= Math.ceil(n / 2) + 2; k++) {
    const { y, m } = partes(addMeses(hoje.slice(0, 7) + '-01', k));
    for (const [tipo, nomeP] of PAGAMENTOS) datas.push({ tipo, nome: nomeP, data: dataPagamento(sal[tipo], y, m), valor: round2(Number(sal[tipo].valor)) });
  }
  datas.sort((a, b) => a.data.localeCompare(b.data));
  let i0 = datas.findIndex((x) => x.data > hoje) - 1;
  if (i0 < 0) i0 = 0;
  const contasMes = round2(Number(orc.compromissos || 0) + Number(orc.guardarCasa || 0));
  const margemPct = Math.max(0, Number(orc.margem ?? 0.1));
  const out = [];
  for (let i = i0; i < i0 + n && i + 1 < datas.length; i++) {
    const pag = datas[i]; const fim = datas[i + 1].data; // período = [pag.data, fim)
    const contas = sal.contasNo === 'dividir' ? round2(contasMes / 2) : ((sal.contasNo || 'saldo') === pag.tipo ? contasMes : 0);
    const faturas = [];
    for (const c of dados.cartoes) {
      let v = vencSeguinte(c, addMeses(pag.data.slice(0, 7) + '-01', -1, c.vencimento), 0);
      for (let g = 0; g < 3; g++, v = vencSeguinte(c, v)) {
        if (v < pag.data || v >= fim) continue;
        const r = resumoFatura(dados, c.id, v, hoje);
        const f = r.outros > 0.004 && r.faltaPagar > 0.009 ? fechamentoFatura(dados, r, hoje) : null;
        faturas.push({ cartao: c, venc: v, estado: r.estado, total: r.estado === 'fechada' ? r.total : r.totalGeral, minha: r.minha, pago: r.pago, faltaPagar: r.faltaPagar, pendente: f ? f.pendente : 0 });
      }
    }
    faturas.sort((a, b) => a.venc.localeCompare(b.venc));
    const minha = round2(faturas.reduce((s, f) => s + f.minha, 0));
    const pendente = round2(faturas.reduce((s, f) => s + f.pendente, 0));
    const sobra = round2(pag.valor - contas - minha);
    const margem = round2(pag.valor * margemPct);
    const estado = sobra < 0 ? 'bad' : (sobra < margem || sobra - pendente < 0 ? 'warn' : 'ok');
    out.push({ ...pag, ate: addDias(fim, -1), atual: pag.data <= hoje, contas, faturas, minha, pendente, sobra, margem, estado });
  }
  return out;
}
