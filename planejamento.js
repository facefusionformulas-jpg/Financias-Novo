"use strict";

/* ===========================================================
   Módulo Planejamento — motoboy iFood + dívidas + caixa
   Foco: sair de dívidas em ~3 meses + formar reserva.
   Estende o app principal. Persistência via dbGet/dbSet do db.js.
   =========================================================== */

/* Estado em memória — carregado uma vez do IDB, re-persistido a cada salvar. */
let pl_dividas = [];
let pl_ifood = [];
let pl_caixa = { meta: 0, saldo: 0, movimentos: [] };
let pl_config = {
  salario_fixo: 2000,
  parcela_moto: 1213,
  parcelas_moto_restantes: 34,
  internet: 40,
  das_mei: 80,
  custos_operacionais_estimados: 900, // gasolina + manutenção (estimativa)
  manutencao_mensal: 200,
  meta_ifood_mes: 4000,
  custo_km_estimado: 0.21,
  km_por_litro: 30,
  preco_litro: 6.30,
  cnh_resolvida: false
};
let pl_editandoDividaId = null;

/* Tipos de dívida — peso usado pra ordenar avalanche quando juros é desconhecido.
   Cartão e fintech topo (juro alto presumido). Pessoal/imposto embaixo (sem juro). */
const PL_TIPOS_DIVIDA = [
  { id: "cartao",    label: "Cartão",     peso: 100, cor: "#f87171" },
  { id: "fintech",   label: "Fintech",    peso: 90,  cor: "#fb923c" },
  { id: "conta",     label: "Conta",      peso: 60,  cor: "#facc15" },
  { id: "parcelado", label: "Parcelado",  peso: 50,  cor: "#a78bfa" },
  { id: "transito",  label: "Trânsito",   peso: 45,  cor: "#fb7185" },
  { id: "imposto",   label: "Imposto",    peso: 30,  cor: "#60a5fa" },
  { id: "pessoal",   label: "Pessoal",    peso: 10,  cor: "#34d399" }
];

/* Dívidas reais do Daividson — usadas pelo botão "Importar minhas dívidas".
   Datas previstas pra vencimento são chutes razoáveis (15 e 30 do mês). */
const PL_DIVIDAS_INICIAIS = [
  { nome: "Cartão de crédito", valor_total: 2300,   tipo: "cartao",    juros: 0, observacao: "Verificar se está no rotativo. Parcelar a fatura se necessário pra fugir do juro.", vence_em: null, prioridade: "alta" },
  { nome: "Mercado",           valor_total: 1227,   tipo: "conta",     juros: 0, observacao: "Parcela em 6×.", vence_em: null, prioridade: "media" },
  { nome: "Baú da moto",       valor_total: 608,    tipo: "parcelado", juros: 0, observacao: "4 parcelas (1 em atraso).", vence_em: null, prioridade: "media" },
  { nome: "Carlos",            valor_total: 355,    tipo: "pessoal",   juros: 0, observacao: "Empréstimo pessoal.", vence_em: null, prioridade: "baixa" },
  { nome: "Pay Joy",           valor_total: 342,    tipo: "fintech",   juros: 0, observacao: "2 parcelas de R$ 171, vence de 15 em 15 dias.", vence_em: null, prioridade: "alta" },
  { nome: "MEI em atraso",     valor_total: 306.05, tipo: "imposto",   juros: 0, observacao: "120 + 100 + 86,05.", vence_em: null, prioridade: "media" },
  { nome: "Tela do celular",   valor_total: 250,    tipo: "parcelado", juros: 0, observacao: "", vence_em: null, prioridade: "baixa" },
  { nome: "Blipay",            valor_total: 225,    tipo: "fintech",   juros: 0, observacao: "Fintech — juro alto provável.", vence_em: null, prioridade: "alta" },
  { nome: "IPVA",              valor_total: 195,    tipo: "imposto",   juros: 0, observacao: "Parcelado: 100 + 95.", vence_em: null, prioridade: "media" },
  { nome: "Multa",             valor_total: 131,    tipo: "transito",  juros: 0, observacao: "", vence_em: null, prioridade: "media" },
  { nome: "Facio",             valor_total: 58.39,  tipo: "fintech",   juros: 0, observacao: "Quitar logo — valor baixo, tira da lista.", vence_em: null, prioridade: "alta" }
];

/* ===========================================================
   Persistência
   =========================================================== */
async function plCarregar() {
  try {
    pl_dividas = (await dbGet("pl_dividas")) || [];
    pl_ifood = (await dbGet("pl_ifood")) || [];
    const c = (await dbGet("pl_caixa")) || {};
    pl_caixa = Object.assign({ meta: 0, saldo: 0, movimentos: [] }, c);
    if (!Array.isArray(pl_caixa.movimentos)) pl_caixa.movimentos = [];
    const cfg = (await dbGet("pl_config")) || {};
    pl_config = Object.assign(pl_config, cfg);
  } catch (e) {
    console.warn("[pl] carregar:", e);
  }
}

async function plSalvar() {
  try {
    await dbSetMany({
      pl_dividas: pl_dividas,
      pl_ifood: pl_ifood,
      pl_caixa: pl_caixa,
      pl_config: pl_config
    });
  } catch (e) {
    console.warn("[pl] salvar:", e);
  }
}

/* ===========================================================
   Utilidades
   =========================================================== */
function plId() {
  return "pl_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now().toString(36);
}
function plDinheiro(v) {
  const n = Number(v || 0);
  const s = Math.abs(n).toFixed(2).replace(".", ",").replace(/(\d)(?=(\d{3})+,)/g, "$1.");
  return (n < 0 ? "-R$ " : "R$ ") + s;
}
function plHoje() {
  return new Date().toISOString().slice(0, 10);
}
function plChaveMes(d) {
  const x = d ? new Date(d) : new Date();
  const y = x.getFullYear(), m = String(x.getMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}
function plDataBR(s) {
  if (!s) return "—";
  const p = String(s).split("-");
  return p.length === 3 ? (p[2] + "/" + p[1] + "/" + p[0]) : s;
}
function plEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c];
  });
}
function plPesoTipo(tipo) {
  const t = PL_TIPOS_DIVIDA.find(function (x) { return x.id === tipo; });
  return t ? t.peso : 50;
}
function plCorTipo(tipo) {
  const t = PL_TIPOS_DIVIDA.find(function (x) { return x.id === tipo; });
  return t ? t.cor : "#a1a1aa";
}
function plLabelTipo(tipo) {
  const t = PL_TIPOS_DIVIDA.find(function (x) { return x.id === tipo; });
  return t ? t.label : tipo;
}

/* ===========================================================
   Cálculos
   =========================================================== */
function plRestante(d) {
  return Math.max(0, Number(d.valor_total || 0) - Number(d.valor_pago || 0));
}

function plTotalDividas() {
  return pl_dividas.reduce(function (s, d) { return s + plRestante(d); }, 0);
}

function plTotalPago() {
  return pl_dividas.reduce(function (s, d) { return s + Number(d.valor_pago || 0); }, 0);
}

/** Avalanche: maior juros primeiro; juros desconhecido cai no peso por tipo. */
function plOrdenarDividas(dividas) {
  return dividas.slice().filter(function (d) { return d.status !== "quitada"; }).sort(function (a, b) {
    const ja = Number(a.juros || 0), jb = Number(b.juros || 0);
    if (ja && jb) return jb - ja;
    if (ja && !jb) return -1;
    if (!ja && jb) return 1;
    return plPesoTipo(b.tipo) - plPesoTipo(a.tipo);
  });
}

/** Custos essenciais − salário fixo. Quanto o iFood precisa cobrir só pra empatar. */
function plPisoSobrevivencia() {
  const fixos = Number(pl_config.parcela_moto || 0)
              + Number(pl_config.internet || 0)
              + Number(pl_config.das_mei || 0);
  const operacional = Number(pl_config.custos_operacionais_estimados || 0);
  const salario = Number(pl_config.salario_fixo || 0);
  return Math.max(0, fixos + operacional - salario);
}

function plIfoodPeriodo(filtroData) {
  return pl_ifood.filter(filtroData).reduce(function (s, r) { return s + Number(r.ganho || 0); }, 0);
}
function plIfoodMes(mes) {
  mes = mes || plChaveMes();
  return plIfoodPeriodo(function (r) { return (r.data || "").slice(0, 7) === mes; });
}
function plHorasMes(mes) {
  mes = mes || plChaveMes();
  return pl_ifood
    .filter(function (r) { return (r.data || "").slice(0, 7) === mes; })
    .reduce(function (s, r) { return s + Number(r.horas || 0); }, 0);
}
function plKmMes(mes) {
  mes = mes || plChaveMes();
  return pl_ifood
    .filter(function (r) { return (r.data || "").slice(0, 7) === mes; })
    .reduce(function (s, r) { return s + Number(r.km || 0); }, 0);
}
function plCombustivelMes(mes) {
  mes = mes || plChaveMes();
  return pl_ifood
    .filter(function (r) { return (r.data || "").slice(0, 7) === mes; })
    .reduce(function (s, r) { return s + Number(r.gasto_combustivel || 0); }, 0);
}

/** Sobra do mês atual usando dados reais quando há, estimativa quando não. */
function plSobraMesAtual() {
  const mes = plChaveMes();
  const entradas = Number(pl_config.salario_fixo || 0) + plIfoodMes(mes);
  const fixos = Number(pl_config.parcela_moto || 0) + Number(pl_config.internet || 0) + Number(pl_config.das_mei || 0);
  const combustivelReal = plCombustivelMes(mes);
  const operacional = combustivelReal > 0
    ? (combustivelReal + Number(pl_config.manutencao_mensal || 0))
    : Number(pl_config.custos_operacionais_estimados || 0);
  return { entradas: entradas, fixos: fixos, operacional: operacional, sobra: entradas - fixos - operacional };
}

/** Simula 3 meses à frente. Aplica avalanche e joga sobra pro caixa. */
function plProjecao(cenarioIfoodMensal) {
  let dividas = pl_dividas
    .filter(function (d) { return d.status !== "quitada"; })
    .map(function (d) { return Object.assign({}, d, { _rest: plRestante(d) }); });
  let caixa = Number(pl_caixa.saldo || 0);
  const fixos = Number(pl_config.parcela_moto || 0) + Number(pl_config.internet || 0) + Number(pl_config.das_mei || 0);
  const operacional = Number(pl_config.custos_operacionais_estimados || 0);
  const meses = [];

  for (let i = 1; i <= 3; i++) {
    const entradas = Number(pl_config.salario_fixo || 0) + Number(cenarioIfoodMensal || 0);
    let sobra = entradas - fixos - operacional;
    let pagoDividas = 0;
    const quitadasMes = [];

    plOrdenarDividas(dividas).forEach(function (d) {
      if (sobra <= 0) return;
      const idx = dividas.findIndex(function (x) { return x.id === d.id; });
      if (idx < 0 || dividas[idx]._rest <= 0) return;
      const pagar = Math.min(sobra, dividas[idx]._rest);
      dividas[idx]._rest -= pagar;
      sobra -= pagar;
      pagoDividas += pagar;
      if (dividas[idx]._rest <= 0.01) quitadasMes.push(d.nome);
    });

    const proCaixa = Math.max(0, sobra);
    caixa += proCaixa;
    meses.push({
      mes: i,
      pago_dividas: pagoDividas,
      pro_caixa: proCaixa,
      caixa_acumulado: caixa,
      divida_restante: dividas.reduce(function (s, d) { return s + d._rest; }, 0),
      quitadas: quitadasMes
    });
  }
  return meses;
}

/* ===========================================================
   Ações — dívidas
   =========================================================== */
async function plSalvarDividaForm() {
  const nome = (document.getElementById("plDivNome").value || "").trim();
  const valor = Number(document.getElementById("plDivValor").value || 0);
  const tipo = document.getElementById("plDivTipo").value || "conta";
  const juros = Number(document.getElementById("plDivJuros").value || 0);
  const vence = document.getElementById("plDivVence").value || "";
  const obs = (document.getElementById("plDivObs").value || "").trim();
  if (!nome || valor <= 0) {
    if (window.toast) toast("Informe nome e valor.", "error");
    return;
  }
  if (pl_editandoDividaId) {
    const idx = pl_dividas.findIndex(function (d) { return d.id === pl_editandoDividaId; });
    if (idx >= 0) {
      pl_dividas[idx] = Object.assign({}, pl_dividas[idx], {
        nome: nome, valor_total: valor, tipo: tipo, juros: juros, vence_em: vence, observacao: obs
      });
    }
    pl_editandoDividaId = null;
  } else {
    pl_dividas.push({
      id: plId(),
      nome: nome, valor_total: valor, valor_pago: 0,
      tipo: tipo, juros: juros, vence_em: vence,
      observacao: obs, status: "aberta",
      criada_em: new Date().toISOString()
    });
  }
  await plSalvar();
  plLimparFormDivida();
  renderPlanejamento();
  if (window.toast) toast("Dívida salva.", "success");
}

function plLimparFormDivida() {
  ["plDivNome", "plDivValor", "plDivJuros", "plDivVence", "plDivObs"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const tipo = document.getElementById("plDivTipo");
  if (tipo) tipo.value = "conta";
  pl_editandoDividaId = null;
  const btn = document.getElementById("btnPlSalvarDivida");
  if (btn) btn.innerText = "Adicionar dívida";
  const btnC = document.getElementById("btnPlCancelarDivida");
  if (btnC) btnC.classList.add("hidden");
}

function plEditarDivida(id) {
  const d = pl_dividas.find(function (x) { return x.id === id; });
  if (!d) return;
  document.getElementById("plDivNome").value = d.nome || "";
  document.getElementById("plDivValor").value = d.valor_total || "";
  document.getElementById("plDivTipo").value = d.tipo || "conta";
  document.getElementById("plDivJuros").value = d.juros || "";
  document.getElementById("plDivVence").value = d.vence_em || "";
  document.getElementById("plDivObs").value = d.observacao || "";
  pl_editandoDividaId = id;
  const btn = document.getElementById("btnPlSalvarDivida");
  if (btn) btn.innerText = "Salvar alterações";
  const btnC = document.getElementById("btnPlCancelarDivida");
  if (btnC) btnC.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function plExcluirDivida(id) {
  if (!confirm("Excluir esta dívida?")) return;
  pl_dividas = pl_dividas.filter(function (d) { return d.id !== id; });
  await plSalvar();
  renderPlanejamento();
}

async function plRegistrarPagamento(id) {
  const d = pl_dividas.find(function (x) { return x.id === id; });
  if (!d) return;
  const rest = plRestante(d);
  const raw = prompt("Quanto você pagou agora?\nRestante: " + plDinheiro(rest));
  if (raw === null) return;
  const v = Number(String(raw).replace(",", "."));
  if (!(v > 0)) return;
  d.valor_pago = Number(d.valor_pago || 0) + v;
  if (plRestante(d) <= 0.01) {
    d.status = "quitada";
    d.quitada_em = new Date().toISOString();
    if (window.toast) toast("🎉 Dívida quitada: " + d.nome, "success");
  } else {
    if (window.toast) toast("Pago: " + plDinheiro(v), "success");
  }
  await plSalvar();
  renderPlanejamento();
}

async function plMarcarQuitada(id) {
  const d = pl_dividas.find(function (x) { return x.id === id; });
  if (!d) return;
  if (!confirm("Marcar \"" + d.nome + "\" como quitada?")) return;
  d.valor_pago = d.valor_total;
  d.status = "quitada";
  d.quitada_em = new Date().toISOString();
  await plSalvar();
  renderPlanejamento();
  if (window.toast) toast("🎉 Dívida quitada: " + d.nome, "success");
}

async function plImportarDividasIniciais() {
  if (pl_dividas.length > 0) {
    if (!confirm("Já existem dívidas cadastradas. Importar mesmo assim (adiciona às existentes)?")) return;
  }
  PL_DIVIDAS_INICIAIS.forEach(function (raw) {
    pl_dividas.push(Object.assign({
      id: plId(),
      valor_pago: 0,
      status: "aberta",
      criada_em: new Date().toISOString()
    }, raw));
  });
  await plSalvar();
  renderPlanejamento();
  if (window.toast) toast("Dívidas importadas: " + PL_DIVIDAS_INICIAIS.length, "success");
}

/* ===========================================================
   Ações — iFood
   =========================================================== */
async function plSalvarIfoodForm() {
  const data = document.getElementById("plIfoodData").value || plHoje();
  const ganho = Number(document.getElementById("plIfoodGanho").value || 0);
  const horas = Number(document.getElementById("plIfoodHoras").value || 0);
  const km = Number(document.getElementById("plIfoodKm").value || 0);
  const gasto = Number(document.getElementById("plIfoodCombustivel").value || 0);
  const obs = (document.getElementById("plIfoodObs").value || "").trim();
  if (ganho <= 0) {
    if (window.toast) toast("Informe quanto ganhou.", "error");
    return;
  }
  pl_ifood.push({
    id: plId(),
    data: data,
    ganho: ganho,
    horas: horas,
    km: km,
    gasto_combustivel: gasto,
    observacao: obs,
    criado_em: new Date().toISOString()
  });
  // Limpa o form
  document.getElementById("plIfoodGanho").value = "";
  document.getElementById("plIfoodHoras").value = "";
  document.getElementById("plIfoodKm").value = "";
  document.getElementById("plIfoodCombustivel").value = "";
  document.getElementById("plIfoodObs").value = "";
  await plSalvar();
  renderPlanejamento();
  if (window.toast) toast("Dia registrado: " + plDinheiro(ganho), "success");
}

async function plExcluirIfood(id) {
  if (!confirm("Excluir este registro?")) return;
  pl_ifood = pl_ifood.filter(function (r) { return r.id !== id; });
  await plSalvar();
  renderPlanejamento();
}

/* ===========================================================
   Ações — caixa
   =========================================================== */
async function plSalvarMetaCaixa() {
  const v = Number(document.getElementById("plCaixaMeta").value || 0);
  pl_caixa.meta = v;
  await plSalvar();
  renderPlanejamento();
  if (window.toast) toast("Meta do caixa atualizada.", "success");
}

async function plMovimentarCaixa(tipo) {
  const raw = prompt(tipo === "entrada" ? "Quanto entrou no caixa?" : "Quanto saiu do caixa?");
  if (raw === null) return;
  const v = Number(String(raw).replace(",", "."));
  if (!(v > 0)) return;
  const desc = prompt("Descrição (opcional):") || "";
  pl_caixa.movimentos.push({
    id: plId(),
    data: plHoje(),
    valor: v,
    tipo: tipo,
    descricao: desc
  });
  pl_caixa.saldo = Number(pl_caixa.saldo || 0) + (tipo === "entrada" ? v : -v);
  if (pl_caixa.saldo < 0) pl_caixa.saldo = 0;
  await plSalvar();
  renderPlanejamento();
}

async function plExcluirMovimentoCaixa(id) {
  if (!confirm("Apagar este movimento?")) return;
  const mov = pl_caixa.movimentos.find(function (m) { return m.id === id; });
  if (mov) {
    pl_caixa.saldo = Number(pl_caixa.saldo || 0) - (mov.tipo === "entrada" ? mov.valor : -mov.valor);
    if (pl_caixa.saldo < 0) pl_caixa.saldo = 0;
  }
  pl_caixa.movimentos = pl_caixa.movimentos.filter(function (m) { return m.id !== id; });
  await plSalvar();
  renderPlanejamento();
}

/* ===========================================================
   Ações — config
   =========================================================== */
async function plSalvarConfig() {
  pl_config.salario_fixo = Number(document.getElementById("plCfgSalario").value || 0);
  pl_config.parcela_moto = Number(document.getElementById("plCfgMoto").value || 0);
  pl_config.internet = Number(document.getElementById("plCfgInternet").value || 0);
  pl_config.das_mei = Number(document.getElementById("plCfgDas").value || 0);
  pl_config.custos_operacionais_estimados = Number(document.getElementById("plCfgOperacional").value || 0);
  pl_config.meta_ifood_mes = Number(document.getElementById("plCfgMetaIfood").value || 0);
  pl_config.preco_litro = Number(document.getElementById("plCfgPrecoLitro").value || 0);
  pl_config.km_por_litro = Number(document.getElementById("plCfgKmL").value || 0);
  await plSalvar();
  renderPlanejamento();
  if (window.toast) toast("Configurações salvas.", "success");
}

async function plMarcarCnhResolvida() {
  pl_config.cnh_resolvida = !pl_config.cnh_resolvida;
  await plSalvar();
  renderPlanejamento();
}

/* ===========================================================
   Render — painel principal
   =========================================================== */
function renderPlPainel() {
  const root = document.getElementById("planejamento");
  if (!root || root.classList.contains("hidden")) return;

  const mes = plChaveMes();
  const piso = plPisoSobrevivencia();
  const sobraInfo = plSobraMesAtual();
  const totalDiv = plTotalDividas();
  const totalPago = plTotalPago();
  const totalOriginal = totalDiv + totalPago;
  const pctPago = totalOriginal > 0 ? (totalPago / totalOriginal * 100) : 0;
  const ifoodMes = plIfoodMes(mes);
  const horasMes = plHorasMes(mes);
  const rhora = horasMes > 0 ? (ifoodMes / horasMes) : 0;
  const caixaPct = pl_caixa.meta > 0 ? Math.min(100, (pl_caixa.saldo / pl_caixa.meta) * 100) : 0;

  const proximas = pl_dividas
    .filter(function (d) { return d.status !== "quitada" && d.vence_em; })
    .sort(function (a, b) { return new Date(a.vence_em) - new Date(b.vence_em); })
    .slice(0, 3);

  const projMeta = plProjecao(Number(pl_config.meta_ifood_mes || 0));
  const projReal = plProjecao(ifoodMes); // se ele tá só salário, mostra realidade

  const html = ''
    + (pl_config.cnh_resolvida ? '' : ''
        + '<div class="pl-alerta pl-alerta-vermelho">'
        + '  <div><strong>⚠️ CNH vencida</strong> — prioridade máxima. Renovar protege sua renda (multa grave + risco de apreensão da moto).</div>'
        + '  <button class="btn btn-small btn-dark" onclick="plMarcarCnhResolvida()">Marquei como resolvida</button>'
        + '</div>')
    + '<div class="grid-2">'
    + '  <div class="card pl-hero">'
    + '    <p class="metric-title">Piso de sobrevivência</p>'
    + '    <p class="metric-value">' + plDinheiro(piso) + '</p>'
    + '    <p class="item-meta">Quanto o iFood precisa cobrir só pra empatar o mês (custos fixos + operacional − salário).</p>'
    + '  </div>'
    + '  <div class="card pl-hero">'
    + '    <p class="metric-title">Sobra prevista deste mês</p>'
    + '    <p class="metric-value ' + (sobraInfo.sobra >= 0 ? 'metric-green' : 'metric-red') + '">' + plDinheiro(sobraInfo.sobra) + '</p>'
    + '    <p class="item-meta">' + plDinheiro(sobraInfo.entradas) + ' entradas − ' + plDinheiro(sobraInfo.fixos + sobraInfo.operacional) + ' custos.</p>'
    + '  </div>'
    + '</div>'
    + '<div class="grid-4" style="margin-top:14px">'
    + '  <div class="card mini-card">'
    + '    <p class="metric-title">Dívida restante</p>'
    + '    <p class="metric-value metric-red">' + plDinheiro(totalDiv) + '</p>'
    + '    <p class="item-meta">' + pl_dividas.filter(function (d) { return d.status !== "quitada"; }).length + ' em aberto</p>'
    + '  </div>'
    + '  <div class="card mini-card">'
    + '    <p class="metric-title">Já quitei</p>'
    + '    <p class="metric-value metric-green">' + plDinheiro(totalPago) + '</p>'
    + '    <p class="item-meta">' + pctPago.toFixed(0) + '% do total</p>'
    + '  </div>'
    + '  <div class="card mini-card">'
    + '    <p class="metric-title">iFood do mês</p>'
    + '    <p class="metric-value">' + plDinheiro(ifoodMes) + '</p>'
    + '    <p class="item-meta">' + (horasMes > 0 ? (rhora.toFixed(2).replace(".", ",") + " R$/hora · " + horasMes.toFixed(0) + "h") : "—") + '</p>'
    + '  </div>'
    + '  <div class="card mini-card">'
    + '    <p class="metric-title">Caixa</p>'
    + '    <p class="metric-value metric-green">' + plDinheiro(pl_caixa.saldo) + '</p>'
    + '    <p class="item-meta">Meta: ' + plDinheiro(pl_caixa.meta) + '</p>'
    + '    <div class="progress" style="margin-top:6px"><div class="progress-bar" style="width:' + caixaPct.toFixed(0) + '%;background:var(--green)"></div></div>'
    + '  </div>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <div class="card-header-flex">'
    + '    <h3>Próximas dívidas a vencer</h3>'
    + '    <a href="#" onclick="openTabPorId(\'dividas-motoboy\');return false;" style="color:var(--primary);font-size:13px;font-weight:600;text-decoration:none">Ver todas →</a>'
    + '  </div>'
    + '  <div class="list" style="margin-top:10px">'
    + (proximas.length
        ? proximas.map(function (d) {
            return '<div class="item">'
              + '<div><p class="item-title">' + plEsc(d.nome) + ' <span class="pl-pill" style="background:' + plCorTipo(d.tipo) + '20;color:' + plCorTipo(d.tipo) + '">' + plEsc(plLabelTipo(d.tipo)) + '</span></p>'
              + '<p class="item-meta">Vence ' + plDataBR(d.vence_em) + ' · resta ' + plDinheiro(plRestante(d)) + '</p></div>'
              + '<div class="item-actions"><button class="btn btn-small btn-green" onclick="plRegistrarPagamento(\'' + d.id + '\')">+ Pago</button></div>'
              + '</div>';
          }).join("")
        : '<p class="empty">Nenhuma dívida com vencimento cadastrado. Vá em Dívidas e adicione as datas pra receber alertas.</p>')
    + '  </div>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <h3>Projeção 3 meses — qual cenário?</h3>'
    + '  <p class="item-meta" style="margin-top:6px">Mês a mês, simula quanto vai pra dívida e quanto sobra pro caixa.</p>'
    + '  <div class="pl-cenarios">'
    + '    ' + plRenderCenario("Só salário", 0)
    + '    ' + plRenderCenario("iFood real deste mês", ifoodMes)
    + '    ' + plRenderCenario("iFood na meta (" + plDinheiro(pl_config.meta_ifood_mes) + ")", Number(pl_config.meta_ifood_mes || 0))
    + '  </div>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <h3>Configurações do planejamento</h3>'
    + '  <p class="item-meta" style="margin-top:6px">Ajuste pra refletir sua realidade. Tudo entra nos cálculos de sobra e projeção.</p>'
    + '  <div class="form-grid" style="margin-top:12px">'
    + '    <label class="pl-label">Salário fixo<input id="plCfgSalario" type="number" step="0.01" value="' + (pl_config.salario_fixo || 0) + '"></label>'
    + '    <label class="pl-label">Parcela moto<input id="plCfgMoto" type="number" step="0.01" value="' + (pl_config.parcela_moto || 0) + '"></label>'
    + '    <label class="pl-label">Internet<input id="plCfgInternet" type="number" step="0.01" value="' + (pl_config.internet || 0) + '"></label>'
    + '    <label class="pl-label">DAS MEI<input id="plCfgDas" type="number" step="0.01" value="' + (pl_config.das_mei || 0) + '"></label>'
    + '    <label class="pl-label">Operacional estimado (gasolina+manutenção)<input id="plCfgOperacional" type="number" step="0.01" value="' + (pl_config.custos_operacionais_estimados || 0) + '"></label>'
    + '    <label class="pl-label">Meta iFood/mês<input id="plCfgMetaIfood" type="number" step="0.01" value="' + (pl_config.meta_ifood_mes || 0) + '"></label>'
    + '    <label class="pl-label">Preço do litro<input id="plCfgPrecoLitro" type="number" step="0.01" value="' + (pl_config.preco_litro || 0) + '"></label>'
    + '    <label class="pl-label">Km/litro (moto)<input id="plCfgKmL" type="number" step="0.1" value="' + (pl_config.km_por_litro || 0) + '"></label>'
    + '  </div>'
    + '  <button class="btn btn-green" style="margin-top:10px" onclick="plSalvarConfig()">Salvar configurações</button>'
    + '</div>';

  root.innerHTML = html;
}

function plRenderCenario(titulo, ifoodMes) {
  const proj = plProjecao(ifoodMes);
  const ultimo = proj[proj.length - 1];
  const mesesAteZero = proj.findIndex(function (m) { return m.divida_restante <= 0.01; });
  return ''
    + '<div class="pl-cenario">'
    + '  <p class="metric-title">' + plEsc(titulo) + '</p>'
    + '  <p class="item-meta" style="margin-top:4px">iFood: ' + plDinheiro(ifoodMes) + '/mês</p>'
    + '  <div class="pl-cenario-meses">'
    +     proj.map(function (m) {
            const livre = m.divida_restante <= 0.01;
            return '<div class="pl-cenario-mes ' + (livre ? "livre" : "") + '">'
              + '<div class="mes-num">M' + m.mes + '</div>'
              + '<div class="mes-info"><span>Dívida:</span><strong>' + plDinheiro(m.divida_restante) + '</strong></div>'
              + '<div class="mes-info"><span>Caixa:</span><strong class="metric-green">' + plDinheiro(m.caixa_acumulado) + '</strong></div>'
              + (m.quitadas.length ? '<div class="mes-quitadas">Quitou: ' + m.quitadas.map(plEsc).join(", ") + '</div>' : '')
              + '</div>';
          }).join("")
    + '  </div>'
    + '  <p class="item-meta" style="margin-top:8px">'
    + (mesesAteZero >= 0
        ? '✅ Livre em ' + (mesesAteZero + 1) + ' mês' + (mesesAteZero === 0 ? "" : "es")
        : '⏳ Ainda devendo ' + plDinheiro(ultimo.divida_restante) + ' no fim do M3')
    + '</p>'
    + '</div>';
}

/* ===========================================================
   Render — Dívidas
   =========================================================== */
function renderPlDividas() {
  const root = document.getElementById("dividas-motoboy");
  if (!root || root.classList.contains("hidden")) return;

  const dividasAtivas = pl_dividas.filter(function (d) { return d.status !== "quitada"; });
  const dividasQuitadas = pl_dividas.filter(function (d) { return d.status === "quitada"; });
  const ordenadas = plOrdenarDividas(dividasAtivas);
  const total = plTotalDividas();

  const tiposOpts = PL_TIPOS_DIVIDA.map(function (t) {
    return '<option value="' + t.id + '">' + t.label + '</option>';
  }).join("");

  const html = ''
    + '<h2 class="section-title">Dívidas — método avalanche</h2>'
    + '<p class="section-desc">Lista priorizada por juros (ou tipo, quando não souber). Cartão e fintech sobem pro topo porque costumam ter o juro mais caro. Quita primeiro o que está mais alto.</p>'

    + '<div class="card" style="margin-bottom:14px">'
    + '  <div class="card-header-flex">'
    + '    <h3>Total restante</h3>'
    + '    <span class="grupo-total metric-red" style="font-size:24px">' + plDinheiro(total) + '</span>'
    + '  </div>'
    + (pl_dividas.length === 0
        ? '<button class="btn btn-green" style="margin-top:10px" onclick="plImportarDividasIniciais()">Importar minhas dívidas (Daividson)</button>'
        : '<p class="item-meta" style="margin-top:6px">' + dividasAtivas.length + ' em aberto · ' + dividasQuitadas.length + ' quitadas 🎉</p>')
    + '</div>'

    + '<div class="card" style="margin-bottom:14px">'
    + '  <h3>' + (pl_editandoDividaId ? "Editar dívida" : "Adicionar dívida") + '</h3>'
    + '  <div class="form-grid" style="margin-top:10px">'
    + '    <input id="plDivNome" type="text" placeholder="Nome (ex: Cartão Nubank)">'
    + '    <input id="plDivValor" type="number" step="0.01" placeholder="Valor total (R$)">'
    + '    <select id="plDivTipo">' + tiposOpts + '</select>'
    + '    <input id="plDivJuros" type="number" step="0.01" placeholder="Juros % ao mês (opcional)">'
    + '    <input id="plDivVence" type="date" placeholder="Vencimento (opcional)">'
    + '    <input id="plDivObs" type="text" placeholder="Observação">'
    + '    <button id="btnPlSalvarDivida" class="btn btn-green" onclick="plSalvarDividaForm()">Adicionar dívida</button>'
    + '    <button id="btnPlCancelarDivida" class="btn btn-dark hidden" onclick="plLimparFormDivida();renderPlanejamento()">Cancelar</button>'
    + '  </div>'
    + '</div>'

    + '<div class="card">'
    + '  <h3>Em aberto — quita de cima pra baixo</h3>'
    + '  <div class="list" style="margin-top:10px">'
    + (ordenadas.length
        ? ordenadas.map(function (d, i) {
            const rest = plRestante(d);
            const pct = d.valor_total > 0 ? (Number(d.valor_pago || 0) / d.valor_total * 100) : 0;
            return '<div class="item pl-divida-item">'
              + '<div style="flex:1">'
              + '  <p class="item-title"><span class="pl-rank">#' + (i + 1) + '</span> ' + plEsc(d.nome)
              + '    <span class="pl-pill" style="background:' + plCorTipo(d.tipo) + '20;color:' + plCorTipo(d.tipo) + '">' + plEsc(plLabelTipo(d.tipo)) + '</span>'
              + (d.juros ? '    <span class="pl-pill" style="background:#f8717120;color:#f87171">' + Number(d.juros).toFixed(2).replace(".", ",") + '% am</span>' : "")
              + '  </p>'
              + '  <p class="item-meta">' + plDinheiro(rest) + ' restantes · pago ' + plDinheiro(d.valor_pago || 0) + ' (' + pct.toFixed(0) + '%)'
              + (d.vence_em ? ' · vence ' + plDataBR(d.vence_em) : "")
              + '</p>'
              + (d.observacao ? '<p class="item-meta" style="font-style:italic">"' + plEsc(d.observacao) + '"</p>' : "")
              + '  <div class="progress" style="margin-top:6px"><div class="progress-bar" style="width:' + pct + '%;background:' + plCorTipo(d.tipo) + '"></div></div>'
              + '</div>'
              + '<div class="item-actions" style="flex-wrap:wrap;justify-content:flex-end">'
              + '  <button class="btn btn-small btn-green" onclick="plRegistrarPagamento(\'' + d.id + '\')">+ Pago</button>'
              + '  <button class="btn btn-small" onclick="plMarcarQuitada(\'' + d.id + '\')">Quitar</button>'
              + '  <button class="btn btn-small btn-dark" onclick="plEditarDivida(\'' + d.id + '\')">Editar</button>'
              + '  <button class="btn btn-small btn-red" onclick="plExcluirDivida(\'' + d.id + '\')">Excluir</button>'
              + '</div>'
              + '</div>';
          }).join("")
        : '<p class="empty">Nenhuma dívida em aberto. ' + (pl_dividas.length === 0 ? "Importa as suas em cima ou cadastra manualmente." : "🎉 Tudo quitado!") + '</p>')
    + '  </div>'
    + '</div>'

    + (dividasQuitadas.length
        ? '<div class="card" style="margin-top:14px">'
          + '<h3>Quitadas 🎉</h3>'
          + '<div class="list" style="margin-top:10px">'
          +   dividasQuitadas.map(function (d) {
                return '<div class="item">'
                  + '<div><p class="item-title" style="text-decoration:line-through;color:var(--muted)">' + plEsc(d.nome) + '</p>'
                  + '<p class="item-meta">Quitada em ' + plDataBR((d.quitada_em || "").slice(0, 10)) + '</p></div>'
                  + '<div class="item-actions"><span class="amount metric-green">' + plDinheiro(d.valor_total) + '</span>'
                  + '<button class="btn btn-small btn-red" onclick="plExcluirDivida(\'' + d.id + '\')">Apagar</button></div>'
                  + '</div>';
              }).join("")
          + '</div>'
          + '</div>'
        : '');

  root.innerHTML = html;
}

/* ===========================================================
   Render — iFood
   =========================================================== */
function renderPlIfood() {
  const root = document.getElementById("ifood");
  if (!root || root.classList.contains("hidden")) return;

  const mes = plChaveMes();
  const regs = pl_ifood.filter(function (r) { return (r.data || "").slice(0, 7) === mes; })
    .sort(function (a, b) { return (b.data || "").localeCompare(a.data || ""); });

  const ganhoMes = plIfoodMes(mes);
  const horasMes = plHorasMes(mes);
  const kmMes = plKmMes(mes);
  const combMes = plCombustivelMes(mes);
  const liquido = ganhoMes - combMes;
  const rhora = horasMes > 0 ? (liquido / horasMes) : 0;
  const kmL = combMes > 0 ? (kmMes / (combMes / (pl_config.preco_litro || 1))) : 0;
  const meta = Number(pl_config.meta_ifood_mes || 0);
  const pctMeta = meta > 0 ? Math.min(100, (ganhoMes / meta) * 100) : 0;

  const html = ''
    + '<h2 class="section-title">Ganhos do iFood</h2>'
    + '<p class="section-desc">Registra cada dia que rodou. O app calcula seu R$/hora líquido (já descontando combustível) e o consumo real da moto.</p>'

    + '<div class="grid-4">'
    + '  <div class="card mini-card"><p class="metric-title">Ganho do mês</p><p class="metric-value">' + plDinheiro(ganhoMes) + '</p>'
    + '    <div class="progress" style="margin-top:6px"><div class="progress-bar" style="width:' + pctMeta + '%;background:var(--primary)"></div></div>'
    + '    <p class="item-meta">' + pctMeta.toFixed(0) + '% da meta (' + plDinheiro(meta) + ')</p></div>'
    + '  <div class="card mini-card"><p class="metric-title">Combustível</p><p class="metric-value metric-red">' + plDinheiro(combMes) + '</p>'
    + '    <p class="item-meta">' + (kmMes > 0 ? kmMes.toFixed(0) + " km rodados" : "—") + '</p></div>'
    + '  <div class="card mini-card"><p class="metric-title">Líquido</p><p class="metric-value metric-green">' + plDinheiro(liquido) + '</p>'
    + '    <p class="item-meta">' + (horasMes > 0 ? (rhora.toFixed(2).replace(".", ",") + " R$/hora") : "—") + '</p></div>'
    + '  <div class="card mini-card"><p class="metric-title">Horas rodadas</p><p class="metric-value">' + horasMes.toFixed(0) + 'h</p>'
    + '    <p class="item-meta">' + (kmL > 0 ? (kmL.toFixed(1).replace(".", ",") + " km/L real") : "—") + '</p></div>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <h3>Registrar dia</h3>'
    + '  <div class="form-grid" style="margin-top:10px">'
    + '    <input id="plIfoodData" type="date" value="' + plHoje() + '">'
    + '    <input id="plIfoodGanho" type="number" step="0.01" placeholder="Quanto ganhou (R$)">'
    + '    <input id="plIfoodHoras" type="number" step="0.1" placeholder="Horas rodadas">'
    + '    <input id="plIfoodKm" type="number" step="1" placeholder="KM rodados (opc)">'
    + '    <input id="plIfoodCombustivel" type="number" step="0.01" placeholder="Gasolina gasta (R$, opc)">'
    + '    <input id="plIfoodObs" type="text" placeholder="Observação">'
    + '    <button class="btn btn-green" onclick="plSalvarIfoodForm()">+ Registrar dia</button>'
    + '  </div>'
    + '  <p class="item-meta" style="margin-top:8px">Dica: registre antes de dormir, todo dia. Vira hábito em ~2 semanas.</p>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <h3>Dias do mês</h3>'
    + '  <div class="list" style="margin-top:10px">'
    + (regs.length
        ? regs.map(function (r) {
            const liq = Number(r.ganho || 0) - Number(r.gasto_combustivel || 0);
            const rh = Number(r.horas || 0) > 0 ? (liq / Number(r.horas)) : 0;
            return '<div class="item">'
              + '<div><p class="item-title">' + plDataBR(r.data) + ' — ' + plDinheiro(r.ganho)
              +   (r.horas ? ' <span class="pl-pill" style="background:var(--card2);color:var(--muted)">' + r.horas + 'h</span>' : "")
              +   (r.km ? ' <span class="pl-pill" style="background:var(--card2);color:var(--muted)">' + r.km + ' km</span>' : "")
              + '</p>'
              + '<p class="item-meta">'
              +   (r.gasto_combustivel ? "Combustível: " + plDinheiro(r.gasto_combustivel) + " · " : "")
              +   (rh > 0 ? "Líquido: " + rh.toFixed(2).replace(".", ",") + " R$/h" : "Líquido: " + plDinheiro(liq))
              +   (r.observacao ? ' · ' + plEsc(r.observacao) : "")
              + '</p></div>'
              + '<div class="item-actions">'
              + '  <button class="btn btn-small btn-red" onclick="plExcluirIfood(\'' + r.id + '\')">Excluir</button>'
              + '</div>'
              + '</div>';
          }).join("")
        : '<p class="empty">Nenhum dia registrado neste mês.</p>')
    + '  </div>'
    + '</div>';

  root.innerHTML = html;
}

/* ===========================================================
   Render — Caixa
   =========================================================== */
function renderPlCaixa() {
  const root = document.getElementById("caixa");
  if (!root || root.classList.contains("hidden")) return;

  const meta = Number(pl_caixa.meta || 0);
  const saldo = Number(pl_caixa.saldo || 0);
  const pct = meta > 0 ? Math.min(100, (saldo / meta) * 100) : 0;
  const falta = Math.max(0, meta - saldo);
  const movs = (pl_caixa.movimentos || []).slice().sort(function (a, b) { return (b.data || "").localeCompare(a.data || ""); });

  const html = ''
    + '<h2 class="section-title">Caixa / Reserva de emergência</h2>'
    + '<p class="section-desc">Depois de quitar as dívidas, todo mês a sobra cai aqui. Meta saudável: 1 mês dos seus custos fixos (~' + plDinheiro((pl_config.parcela_moto || 0) + (pl_config.internet || 0) + (pl_config.das_mei || 0) + (pl_config.custos_operacionais_estimados || 0)) + ').</p>'

    + '<div class="card pl-caixa-hero">'
    + '  <div>'
    + '    <p class="metric-title">Saldo atual</p>'
    + '    <p class="metric-value metric-green" style="font-size:36px">' + plDinheiro(saldo) + '</p>'
    + '    <p class="item-meta">de ' + plDinheiro(meta) + ' · falta ' + plDinheiro(falta) + '</p>'
    + '    <div class="progress" style="margin-top:10px"><div class="progress-bar" style="width:' + pct + '%;background:var(--green)"></div></div>'
    + '    <p class="item-meta" style="margin-top:6px">' + pct.toFixed(0) + '% da meta</p>'
    + '  </div>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <h3>Meta de reserva</h3>'
    + '  <div class="form-grid" style="grid-template-columns:1fr auto;margin-top:10px">'
    + '    <input id="plCaixaMeta" type="number" step="0.01" placeholder="Valor da meta (R$)" value="' + (meta || "") + '">'
    + '    <button class="btn btn-green" onclick="plSalvarMetaCaixa()">Salvar meta</button>'
    + '  </div>'
    + '  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'
    + '    <button class="btn btn-green" onclick="plMovimentarCaixa(\'entrada\')">+ Adicionar ao caixa</button>'
    + '    <button class="btn btn-dark" onclick="plMovimentarCaixa(\'saida\')">− Tirar do caixa</button>'
    + '  </div>'
    + '</div>'

    + '<div class="card" style="margin-top:14px">'
    + '  <h3>Movimentos</h3>'
    + '  <div class="list" style="margin-top:10px">'
    + (movs.length
        ? movs.map(function (m) {
            return '<div class="item">'
              + '<div><p class="item-title">' + (m.tipo === "entrada" ? "+ " : "− ") + plDinheiro(m.valor)
              +   ' <span class="pl-pill" style="background:' + (m.tipo === "entrada" ? "#22c55e20;color:#22c55e" : "#f8717120;color:#f87171") + '">' + (m.tipo === "entrada" ? "Entrada" : "Saída") + '</span></p>'
              + '<p class="item-meta">' + plDataBR(m.data) + (m.descricao ? ' · ' + plEsc(m.descricao) : "") + '</p></div>'
              + '<div class="item-actions"><button class="btn btn-small btn-red" onclick="plExcluirMovimentoCaixa(\'' + m.id + '\')">Apagar</button></div>'
              + '</div>';
          }).join("")
        : '<p class="empty">Nenhum movimento ainda. Use os botões acima.</p>')
    + '  </div>'
    + '</div>';

  root.innerHTML = html;
}

/* ===========================================================
   Render principal
   =========================================================== */
function renderPlanejamento() {
  try {
    renderPlPainel();
    renderPlDividas();
    renderPlIfood();
    renderPlCaixa();
  } catch (e) {
    console.error("[pl] render:", e);
  }
}

/* Registra SUB_TABS imediatamente — funciona porque planejamento.js carrega após app.js. */
try {
  if (typeof SUB_TABS !== "undefined") {
    SUB_TABS.trampo = [
      { id: "planejamento",     label: "Painel" },
      { id: "dividas-motoboy",  label: "Dívidas" },
      { id: "ifood",            label: "iFood" },
      { id: "caixa",            label: "Caixa" }
    ];
  }
} catch (e) { /* ignora */ }

/* ===========================================================
   Inicialização — chamada pelo app.js dentro de iniciar()
   =========================================================== */
async function plInit() {
  await plCarregar();
  renderPlanejamento();
}

/* Expõe global */
window.renderPlanejamento = renderPlanejamento;
window.plInit = plInit;
window.plSalvarDividaForm = plSalvarDividaForm;
window.plLimparFormDivida = plLimparFormDivida;
window.plEditarDivida = plEditarDivida;
window.plExcluirDivida = plExcluirDivida;
window.plRegistrarPagamento = plRegistrarPagamento;
window.plMarcarQuitada = plMarcarQuitada;
window.plImportarDividasIniciais = plImportarDividasIniciais;
window.plSalvarIfoodForm = plSalvarIfoodForm;
window.plExcluirIfood = plExcluirIfood;
window.plSalvarMetaCaixa = plSalvarMetaCaixa;
window.plMovimentarCaixa = plMovimentarCaixa;
window.plExcluirMovimentoCaixa = plExcluirMovimentoCaixa;
window.plSalvarConfig = plSalvarConfig;
window.plMarcarCnhResolvida = plMarcarCnhResolvida;
