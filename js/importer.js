// Junta uma fatura lida (CSV/PDF) com os dados existentes, sem perder o que você já marcou.
import { round2, cents, difDias, difMeses, normDesc, raizDesc, uid, addMeses } from './util.js';
import { EU, cartaoPorId, vencAnterior, vencSeguinte, escalarDivisao, dividirIgual } from './calc.js';

const IMPORTADA = new Set(['csv', 'pdf', 'planilha']);
const chaveLinha = (l) => `${l.data}|${normDesc(l.desc)}|${cents(l.valor)}`;

function aplicarRegras(dados, l) {
  const d = normDesc(l.desc);
  for (const g of dados.grupos || []) {
    if (g.cartao === l.cartao && g.descContem && d.includes(normDesc(g.descContem))) { l.grupo = g.id; return 'grupo'; }
  }
  for (const r of dados.regras || []) {
    if (!r.contem || !d.includes(normDesc(r.contem))) continue;
    if (r.fixo) l.fixo = true;
    if (r.pessoa && r.pessoa !== EU) {
      l.divisao = r.modo === 'metade' ? dividirIgual(l.valor, [EU, r.pessoa]) : [{ pessoa: r.pessoa, valor: l.valor, pago: false, pagoEm: null }];
    }
    return 'regra';
  }
  return null;
}

// Herda dono/divisão da parcela anterior da mesma compra, ou de um fixo do mês anterior
function herdar(dados, l, antigas) {
  if (l.tipo !== 'compra') return null;
  const r = raizDesc(l.desc);
  if (l.parcela && l.parcela.n > 1) {
    const ant = antigas.filter((x) => x.parcela && x.parcela.total === l.parcela.total && raizDesc(x.desc) === r
      && x.parcela.n === l.parcela.n - difMeses(x.venc, l.venc))
      .sort((a, b) => b.venc.localeCompare(a.venc))[0];
    if (ant) {
      l.divisao = escalarDivisao(ant.divisao, ant.valor, l.valor);
      l.grupo = ant.grupo || null; l.fixo = !!ant.fixo;
      return 'parcela anterior';
    }
  }
  return null;
}
function herdarFixo(l, antigas) {
  if (l.tipo !== 'compra' || l.parcela) return null;
  const r = raizDesc(l.desc);
  const ant = antigas.filter((x) => x.fixo && !x.parcela && raizDesc(x.desc) === r).sort((a, b) => b.venc.localeCompare(a.venc))[0];
  if (!ant) return null;
  l.fixo = true; l.divisao = escalarDivisao(ant.divisao, ant.valor, l.valor); l.grupo = ant.grupo || null;
  return 'fixo anterior';
}

function novaLinha(base, cartao, venc, origem) {
  return {
    id: uid('l'), cartao, venc, data: base.data, desc: base.desc, valor: round2(base.valor), tipo: base.tipo,
    parcela: base.parcela || null, fixo: false, divisao: [], grupo: null, obs: '', origem,
    refVenc: null,
  };
}

/**
 * @param dados  objeto completo (será copiado)
 * @param imp    { cartao, venc, origem:'csv'|'pdf', linhas:[{data,desc,valor,tipo,parcela}], refs?:{idx:venc},
 *                 valorInformado?, totalDeclarado?, proximas?:{vencimento, linhas} }
 */
export function importarFatura(dadosIn, imp) {
  const dados = structuredClone(dadosIn);
  const cartao = cartaoPorId(dados, imp.cartao);
  if (!cartao) throw new Error('Cartão não cadastrado: ' + imp.cartao);
  const { venc } = imp;
  const resumo = { novas: 0, mantidas: 0, removidas: [], manuaisConciliadas: 0, manuaisSobrando: [], herdadas: 0, regras: 0 };

  const daFatura = dados.lancamentos.filter((l) => l.cartao === imp.cartao && l.venc === venc);
  const outras = dados.lancamentos.filter((l) => !(l.cartao === imp.cartao && l.venc === venc));
  const antigasCartao = outras.filter((l) => l.cartao === imp.cartao && l.venc < venc && l.origem !== 'previsto');

  const pool = new Map();
  for (const l of daFatura.filter((x) => IMPORTADA.has(x.origem))) {
    const k = chaveLinha(l); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(l);
  }
  let manuais = daFatura.filter((l) => l.origem === 'manual');
  let previstas = daFatura.filter((l) => l.origem === 'previsto');
  const anterior = vencAnterior(cartao, venc);

  const resultado = [];
  imp.linhas.forEach((b, idx) => {
    const k = chaveLinha(b);
    const existente = pool.get(k)?.shift();
    let l;
    if (existente) {
      l = { ...existente, desc: b.desc, valor: round2(b.valor), tipo: b.tipo, parcela: b.parcela || null, origem: imp.origem === 'pdf' || imp.origem === 'csv' ? (existente.origem === 'planilha' ? 'planilha' : imp.origem) : existente.origem };
      resumo.mantidas++;
    } else {
      l = novaLinha(b, imp.cartao, venc, imp.origem);
      // compra lançada à mão antes: mesmo valor, data até 3 dias de diferença
      const m = manuais.find((x) => cents(x.valor) === cents(b.valor) && x.data && Math.abs(difDias(x.data, b.data)) <= 3);
      const chave = (s) => (raizDesc(s).split(/[^a-z0-9]+/).find((w) => w.length >= 4) || '');
      const p = m ? null : b.parcela
        ? previstas.find((x) => x.parcela && x.parcela.total === b.parcela.total && x.parcela.n === b.parcela.n && raizDesc(x.desc) === raizDesc(b.desc))
        : previstas.find((x) => x.fixo && !x.parcela && chave(x.desc) && normDesc(b.desc).includes(chave(x.desc)));
      const fonte = m || p;
      if (fonte) {
        l.divisao = escalarDivisao(fonte.divisao, fonte.valor, l.valor).map((d, i) => ({ ...d, pago: !!fonte.divisao[i]?.pago, pagoEm: fonte.divisao[i]?.pagoEm || null }));
        l.grupo = fonte.grupo || null; l.fixo = !!fonte.fixo; l.obs = fonte.obs || '';
        if (m) { manuais = manuais.filter((x) => x !== m); resumo.manuaisConciliadas++; }
        if (p) previstas = previstas.filter((x) => x !== p);
      } else if (herdar(dados, l, antigasCartao)) resumo.herdadas++;
      else if (aplicarRegras(dados, l)) resumo.regras++;
      else if (herdarFixo(l, antigasCartao)) resumo.herdadas++;
      resumo.novas++;
    }
    if (l.tipo === 'pagamento') {
      const ref = imp.refs && imp.refs[idx];
      l.refVenc = ref || l.refVenc || (l.data <= anterior ? anterior : venc);
      l.divisao = []; l.grupo = null;
    }
    resultado.push(l);
  });
  for (const sobras of pool.values()) for (const l of sobras) resumo.removidas.push(l);
  // pagamento marcado à mão ("Já paguei") que agora veio no arquivo: fica só o do arquivo
  const pagsArquivo = resultado.filter((l) => l.tipo === 'pagamento');
  const removerManuais = new Set(outras.filter((x) => x.tipo === 'pagamento' && x.origem === 'manual'
    && pagsArquivo.some((p) => p.refVenc === x.refVenc && cents(p.valor) === cents(x.valor))).map((x) => x.id));
  resumo.pagamentosManuaisSubstituidos = removerManuais.size;
  resumo.manuaisSobrando = manuais;

  dados.lancamentos = [...outras.filter((x) => !removerManuais.has(x.id)), ...resultado, ...manuais];

  // Itaú: parcelas da próxima fatura (vêm no PDF) ficam como "previsto"
  if (imp.proximas && imp.proximas.linhas?.length) {
    const vp = imp.proximas.vencimento;
    const fontes = dados.lancamentos.filter((l) => l.cartao === imp.cartao && l.venc <= venc && l.origem !== 'previsto');
    dados.lancamentos = dados.lancamentos.filter((l) => !(l.cartao === imp.cartao && l.venc === vp && l.origem === 'previsto'));
    const jaReais = dados.lancamentos.filter((l) => l.cartao === imp.cartao && l.venc === vp && l.origem !== 'manual');
    for (const b of imp.proximas.linhas) {
      if (jaReais.some((x) => x.parcela && b.parcela && x.parcela.n === b.parcela.n && x.parcela.total === b.parcela.total && raizDesc(x.desc) === raizDesc(b.desc))) continue;
      const l = novaLinha(b, imp.cartao, vp, 'previsto');
      if (!herdar(dados, l, fontes)) aplicarRegras(dados, l);
      dados.lancamentos.push(l);
    }
  }

  dados.faturas = (dados.faturas || []).filter((f) => !(f.cartao === imp.cartao && f.venc === venc));
  dados.faturas.push({
    id: `${imp.cartao}-${venc}`, cartao: imp.cartao, venc, origem: imp.origem, importadaEm: new Date().toISOString(),
    valorInformado: imp.valorInformado ?? null, totalDeclarado: imp.totalDeclarado ?? null,
  });
  return { dados, resumo };
}

export { vencSeguinte, addMeses };
