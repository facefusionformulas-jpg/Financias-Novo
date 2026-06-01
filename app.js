"use strict";

/* ===========================================================
   Estado em memória.
   Carregado uma vez do IndexedDB e re-persistido a cada salvar().
   =========================================================== */
const hoje = new Date().toISOString().slice(0, 10);

let contas = [];
let metas = [];
let comprasCartao = [];
let cartao = { nome: "Cartão principal", fatura: 0, vencimento: hoje, limite: 5000 };
let salarioMes = 0;
let ultimaAtualizacaoCartao = "";
let salariosPorMes = {};
let faturasPorMes = {};
let valesPorMes = {}; // { "AAAA-MM": { gasolina: 0, alimentacao: 0 } }
let habitos = [];
let registroHabitos = {};
let conquistasDesbloqueadas = {};
let snapshots = []; // histórico de versões — até 30, gerado automaticamente

let contaEditandoId = null;
let compraEditandoId = null;
let metaEditandoId = null;
let habitoEditandoId = null;

let deferredInstallPrompt = null;
let pastaBackupHandle = null;
let ultimaGravacaoBackupStr = "";

/* ===========================================================
   Helpers genéricos
   =========================================================== */
function $(id) { return document.getElementById(id); }
function idNovo() { return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2); }
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
  });
}
function dinheiro(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function dataBR(d) { return d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "--/--/----"; }
function adicionarMeses(data, meses) {
  const b = new Date(data + "T00:00:00"), dia = b.getDate(), n = new Date(b);
  n.setMonth(n.getMonth() + meses);
  if (n.getDate() !== dia) n.setDate(0);
  return n.toISOString().slice(0, 10);
}
function adicionarDias(data, dias) {
  const n = new Date(data + "T00:00:00");
  n.setDate(n.getDate() + dias);
  return n.toISOString().slice(0, 10);
}
function diasAte(data) {
  const h = new Date(); h.setHours(0, 0, 0, 0);
  return Math.round((new Date(data + "T00:00:00") - h) / (1000 * 60 * 60 * 24));
}
function chaveMesAtual() { return hoje.slice(0, 7); }
function chaveMesDaData(data) { return data ? data.slice(0, 7) : ""; }
function nomeMes(chave) {
  if (!chave) return "";
  const p = chave.split("-").map(Number);
  return new Date(p[0], p[1] - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}
function mesmoMes(a, b) {
  if (!a || !b) return false;
  const da = new Date(a + "T00:00:00"), db = new Date(b + "T00:00:00");
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth();
}

/* ===========================================================
   Exemplos iniciais (só usados se IDB estiver vazio)
   =========================================================== */
function exemplosContas() {
  return [
    { id: idNovo(), nome: "Internet", valor: 129.9, data: hoje, tipo: "mensal", categoria: "Casa", status: "pendente", origem: "manual" },
    { id: idNovo(), nome: "Prestação da moto", valor: 1213, data: hoje, tipo: "mensal", categoria: "Veículo", status: "pendente", origem: "manual" }
  ];
}
function exemplosMetas() {
  return [{ id: idNovo(), nome: "Viagem Fórmula 1 São Paulo", alvo: 8000, guardado: 1200, prazo: "2026-11-01", prioridade: "alta" }];
}
function exemplosHabitos() {
  return [
    { id: idNovo(), nome: "Beber água", meta: 8, unidade: "copos", cor: "#3b82f6", criadoEm: hoje },
    { id: idNovo(), nome: "Atividade física", meta: 1, unidade: "vez", cor: "#10b981", criadoEm: hoje },
    { id: idNovo(), nome: "Leitura", meta: 30, unidade: "min", cor: "#a855f7", criadoEm: hoje },
    { id: idNovo(), nome: "Sono", meta: 8, unidade: "h", cor: "#0ea5e9", criadoEm: hoje }
  ];
}

/* ===========================================================
   Persistência (via IDB)
   =========================================================== */
async function carregarTudo() {
  const data = await dbGetAll();
  contas = Array.isArray(data.contas) && data.contas.length ? data.contas : (Array.isArray(data.contas) ? [] : exemplosContas());
  metas = Array.isArray(data.metas) && data.metas.length ? data.metas : (Array.isArray(data.metas) ? [] : exemplosMetas());
  comprasCartao = Array.isArray(data.comprasCartao) ? data.comprasCartao : [];
  cartao = (data.cartao && typeof data.cartao === "object") ? data.cartao : { nome: "Cartão principal", fatura: 0, vencimento: hoje, limite: 5000 };
  salarioMes = Number(data.salarioMes || 0);
  ultimaAtualizacaoCartao = data.ultimaAtualizacaoCartao || "";
  salariosPorMes = (data.salariosPorMes && typeof data.salariosPorMes === "object") ? data.salariosPorMes : {};
  faturasPorMes = (data.faturasPorMes && typeof data.faturasPorMes === "object") ? data.faturasPorMes : {};
  valesPorMes = (data.valesPorMes && typeof data.valesPorMes === "object") ? data.valesPorMes : {};
  habitos = Array.isArray(data.habitos) && data.habitos.length ? data.habitos : (Array.isArray(data.habitos) ? [] : exemplosHabitos());
  registroHabitos = (data.registroHabitos && typeof data.registroHabitos === "object") ? data.registroHabitos : {};
  conquistasDesbloqueadas = (data.conquistasDesbloqueadas && typeof data.conquistasDesbloqueadas === "object") ? data.conquistasDesbloqueadas : {};
  snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  ultimaGravacaoBackupStr = data.ultimaGravacaoBackup || "";
  // Preferência de tema
  if (data.tema && (data.tema === "claro" || data.tema === "escuro")) {
    try { localStorage.setItem("financas_tema_v1", data.tema); } catch (e) {}
  }
}

let _salvarTimeout = null;
function salvar() {
  // Debounce 150ms — várias mudanças no mesmo tick viram uma transação
  if (_salvarTimeout) clearTimeout(_salvarTimeout);
  _salvarTimeout = setTimeout(function () {
    _salvarTimeout = null;
    dbSetMany({
      contas, metas, comprasCartao, cartao, salarioMes,
      ultimaAtualizacaoCartao, salariosPorMes, faturasPorMes, valesPorMes,
      habitos, registroHabitos, conquistasDesbloqueadas
    }).then(function () {
      talvezCriarSnapshot();
      agendarBackupAutoSeConfigurado();
    }).catch(function (e) {
      console.warn("Erro ao salvar no IDB:", e);
      toast("Erro ao salvar dados.", "error");
    });
  }, 150);
}

/* ===========================================================
   Toast — substitui alerts
   =========================================================== */
function toast(msg, tipo, ms) {
  const wrap = $("toastWrap"); if (!wrap) { console.log("[toast]", msg); return; }
  const el = document.createElement("div");
  el.className = "toast " + (tipo || "");
  el.innerText = msg;
  wrap.appendChild(el);
  // força reflow pra animar
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.classList.add("show");
  setTimeout(function () {
    el.classList.remove("show");
    setTimeout(function () { el.remove(); }, 300);
  }, ms || 3000);
}

/* ===========================================================
   Navegação
   =========================================================== */
function openTab(id, btn) {
  document.querySelectorAll(".tab").forEach(function (t) { t.classList.add("hidden"); });
  $(id).classList.remove("hidden");
  document.querySelectorAll("nav button").forEach(function (b) { b.classList.remove("active"); });
  if (btn) btn.classList.add("active");
  renderizar();
}
function openTabPorId(tab) {
  const b = Array.from(document.querySelectorAll("nav button")).find(function (x) {
    const oc = x.getAttribute("onclick") || ""; return oc.indexOf("'" + tab + "'") !== -1;
  });
  openTab(tab, b);
}

/* ===========================================================
   Tema (claro / escuro)
   =========================================================== */
function aplicarTemaSalvo() {
  // Dark é o padrão; só aplica claro se o usuário escolheu explicitamente
  let tema = "escuro";
  try {
    const v = localStorage.getItem("financas_tema_v1");
    if (v === "claro" || v === "escuro") tema = v;
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", tema === "claro" ? "light" : "dark");
  const btn = $("btnAlternarTema");
  if (btn) btn.innerText = tema === "claro" ? "Escuro" : "Claro";
}
function alternarTema() {
  let atual = "escuro";
  try {
    const v = localStorage.getItem("financas_tema_v1");
    if (v === "claro" || v === "escuro") atual = v;
  } catch (e) {}
  const novo = atual === "escuro" ? "claro" : "escuro";
  try { localStorage.setItem("financas_tema_v1", novo); } catch (e) {}
  dbSet("tema", novo).catch(function () {});
  aplicarTemaSalvo();
}

/* ===========================================================
   Domínio: contas, parcelas, cartão, metas (igual ao app antigo)
   =========================================================== */
function totalCartao() {
  return Number(cartao.fatura || 0) + comprasCartao.reduce(function (s, i) { return s + Number(i.valor || 0); }, 0);
}
function todasContas() {
  const total = totalCartao();
  const dataFatura = cartao.vencimento || hoje;
  const chaveFatura = dataFatura.slice(0, 7);
  const temFaturaMensal = Number((faturasPorMes && faturasPorMes[chaveFatura]) || 0) > 0;
  const fat = (total > 0 && !temFaturaMensal) ? [{
    id: "fatura-cartao", nome: "Fatura " + (cartao.nome || "Cartão"),
    valor: total, data: dataFatura, tipo: "valor cheio",
    categoria: "Cartão", status: "pendente", origem: "cartao"
  }] : [];
  return [].concat(contas, fat).sort(function (a, b) { return new Date(a.data) - new Date(b.data); });
}
function mesmoMesAtual(data) {
  if (!data) return false;
  const ref = new Date(hoje + "T00:00:00"), d = new Date(data + "T00:00:00");
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}
function contasDoMesAtual() { return todasContas().filter(function (c) { return mesmoMesAtual(c.data); }); }
function proximasContas() {
  const hd = new Date(hoje + "T00:00:00");
  return todasContas().filter(function (c) { return c.status !== "pago" && new Date(c.data + "T00:00:00") >= hd; })
    .sort(function (a, b) { return new Date(a.data) - new Date(b.data); });
}
function urgencia(c) {
  if (c.status === "pago") return "Pago";
  const d = diasAte(c.data);
  if (d < 0) return "Vencida há " + Math.abs(d) + " dia" + (Math.abs(d) === 1 ? "" : "s");
  if (d === 0) return "Vence hoje";
  if (d === 1) return "Vence amanhã";
  return "Vence em " + d + " dias";
}

function salvarSalario() {
  salarioMes = Number($("salarioMes").value || 0);
  salariosPorMes[chaveMesAtual()] = salarioMes;
  salvar(); renderizar();
}

function salvarContaFormulario() { contaEditandoId ? atualizarConta() : adicionarConta(); }
function adicionarConta() {
  const nome = $("contaNome").value.trim();
  const valor = Number($("contaValor").value);
  const data = $("contaData").value;
  const tipo = $("contaTipo").value;
  const categoria = $("contaCategoria").value.trim() || "Geral";
  const rec = $("contaRecorrencia").value;
  const dur = Number($("contaDuracao").value || 1);
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data.", "warn");
  if (rec === "mensal") {
    if (dur < 1) return toast("Informe a duração da recorrência em meses.", "warn");
    const grupo = idNovo();
    for (let i = 0; i < dur; i++) {
      contas.push({
        id: idNovo(), nome: nome + " (" + (i + 1) + "/" + dur + ")",
        valor: valor, data: adicionarMeses(data, i),
        tipo: "mensal recorrente", categoria: categoria, status: "pendente",
        origem: "recorrencia",
        recorrencia: { grupo: grupo, parcelaAtual: i + 1, totalParcelas: dur, frequencia: "mensal" }
      });
    }
  } else if (rec === "quinzenal") {
    const total = Number(($("contaQuinzenas") && $("contaQuinzenas").value) || 0);
    if (!total || total < 1) return toast("Informe quantas quinzenas deseja gerar.", "warn");
    const grupo = idNovo();
    for (let i = 0; i < total; i++) {
      contas.push({
        id: idNovo(), nome: nome + " (" + (i + 1) + "/" + total + ")",
        valor: valor, data: adicionarDias(data, i * 15),
        tipo: "quinzenal", categoria: categoria, status: "pendente",
        origem: "recorrencia",
        recorrencia: { grupo: grupo, parcelaAtual: i + 1, totalParcelas: total, frequencia: "quinzenal" }
      });
    }
  } else {
    contas.push({ id: idNovo(), nome: nome, valor: valor, data: data, tipo: tipo, categoria: categoria, status: "pendente", origem: "manual" });
  }
  limparFormularioConta(); salvar(); renderizar();
  toast("Conta adicionada.", "success");
}
function atualizarConta() {
  const nome = $("contaNome").value.trim(), valor = Number($("contaValor").value),
    data = $("contaData").value, tipo = $("contaTipo").value,
    categoria = $("contaCategoria").value.trim() || "Geral";
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data.", "warn");
  contas = contas.map(function (i) {
    return String(i.id) === String(contaEditandoId)
      ? Object.assign({}, i, { nome: nome, valor: valor, data: data, tipo: tipo, categoria: categoria })
      : i;
  });
  limparFormularioConta(); salvar(); renderizar();
}
function limparFormularioConta() {
  contaEditandoId = null;
  $("contaNome").value = ""; $("contaValor").value = ""; $("contaData").value = hoje;
  $("contaTipo").value = "mensal"; $("contaCategoria").value = "Casa";
  $("contaRecorrencia").value = "unica"; $("contaDuracao").value = "";
  if ($("contaQuinzenas")) $("contaQuinzenas").value = "";
  alternarCampoQuinzenasConta();
  $("btnConta").innerText = "Adicionar";
  $("btnCancelarConta").classList.add("hidden");
}

function adicionarParcela() {
  const nome = $("parcelaNome").value.trim(),
    valor = Number($("parcelaValor").value),
    total = $("parcelaTotal").value,
    atual = $("parcelaAtual").value,
    data = $("parcelaData").value,
    frequencia = $("parcelaFrequencia").value,
    categoria = $("parcelaCategoria").value.trim() || "Parcelas",
    qtdQuinzenas = Number(($("parcelaQuinzenas") && $("parcelaQuinzenas").value) || 0);
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data da parcela.", "warn");
  if (frequencia === "quinzenal") {
    if (!qtdQuinzenas || qtdQuinzenas < 1) return toast("Informe quantas quinzenas deseja gerar.", "warn");
    for (let i = 0; i < qtdQuinzenas; i++) {
      contas.push({
        id: idNovo(), nome: nome + " (" + (i + 1) + "/" + qtdQuinzenas + ")",
        valor: valor, data: adicionarDias(data, i * 15),
        tipo: "quinzenal", categoria: categoria, status: "pendente", origem: "parcela"
      });
    }
  } else {
    if (!total || !atual) return toast("Preencha total de parcelas e parcela atual.", "warn");
    contas.push({
      id: idNovo(), nome: nome + " (" + atual + "/" + total + ")",
      valor: valor, data: data, tipo: "parcela",
      categoria: categoria, status: "pendente", origem: "parcela"
    });
  }
  $("parcelaNome").value = ""; $("parcelaValor").value = "";
  $("parcelaTotal").value = ""; $("parcelaAtual").value = "1";
  $("parcelaData").value = hoje;
  if ($("parcelaQuinzenas")) $("parcelaQuinzenas").value = "";
  salvar(); renderizar();
  toast("Parcela adicionada.", "success");
}

function salvarCartao() {
  cartao = {
    nome: $("cartaoNome").value.trim() || "Cartão principal",
    fatura: Number($("cartaoFatura").value || 0),
    vencimento: $("cartaoVencimento").value || hoje,
    limite: Number($("cartaoLimite").value || 0)
  };
  ultimaAtualizacaoCartao = hoje;
  salvar(); renderizar();
  toast("Cartão atualizado.", "success");
}
function salvarCompraFormulario() { compraEditandoId ? atualizarCompra() : adicionarCompra(); }
function adicionarCompra() {
  const nome = $("compraNome").value.trim(), valor = Number($("compraValor").value),
    data = $("compraData").value, categoria = $("compraCategoria").value.trim() || "Cartão";
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data da compra.", "warn");
  comprasCartao.push({ id: idNovo(), nome: nome, valor: valor, data: data, categoria: categoria });
  limparFormularioCompra(); salvar(); renderizar();
}
function atualizarCompra() {
  const nome = $("compraNome").value.trim(), valor = Number($("compraValor").value),
    data = $("compraData").value, categoria = $("compraCategoria").value.trim() || "Cartão";
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data da compra.", "warn");
  comprasCartao = comprasCartao.map(function (i) {
    return String(i.id) === String(compraEditandoId)
      ? Object.assign({}, i, { nome: nome, valor: valor, data: data, categoria: categoria }) : i;
  });
  limparFormularioCompra(); salvar(); renderizar();
}
function limparFormularioCompra() {
  compraEditandoId = null;
  $("compraNome").value = ""; $("compraValor").value = "";
  $("compraData").value = hoje; $("compraCategoria").value = "Cartão";
  $("btnCompra").innerText = "Adicionar compra";
  $("btnCancelarCompra").classList.add("hidden");
}

function salvarMetaFormulario() { metaEditandoId ? atualizarMeta() : adicionarMeta(); }
function adicionarMeta() {
  const nome = $("metaNome").value.trim(), alvo = Number($("metaAlvo").value),
    guardado = Number($("metaGuardado").value || 0), prazo = $("metaPrazo").value,
    prioridade = $("metaPrioridade").value;
  if (!nome || !alvo || !prazo) return toast("Preencha nome, valor alvo e prazo.", "warn");
  metas.push({ id: idNovo(), nome: nome, alvo: alvo, guardado: guardado, prazo: prazo, prioridade: prioridade });
  limparFormularioMeta(); salvar(); renderizar();
}
function atualizarMeta() {
  const nome = $("metaNome").value.trim(), alvo = Number($("metaAlvo").value),
    guardado = Number($("metaGuardado").value || 0), prazo = $("metaPrazo").value,
    prioridade = $("metaPrioridade").value;
  if (!nome || !alvo || !prazo) return toast("Preencha nome, valor alvo e prazo.", "warn");
  metas = metas.map(function (i) {
    return String(i.id) === String(metaEditandoId)
      ? Object.assign({}, i, { nome: nome, alvo: alvo, guardado: guardado, prazo: prazo, prioridade: prioridade }) : i;
  });
  limparFormularioMeta(); salvar(); renderizar();
}
function limparFormularioMeta() {
  metaEditandoId = null;
  $("metaNome").value = ""; $("metaAlvo").value = "";
  $("metaGuardado").value = ""; $("metaPrazo").value = hoje;
  $("metaPrioridade").value = "alta";
  $("btnMeta").innerText = "Adicionar meta";
  $("btnCancelarMeta").classList.add("hidden");
}

function marcarPago(idv) {
  if (idv === "fatura-cartao") return toast("Edite a fatura na aba Cartão.", "warn");
  contas = contas.map(function (c) {
    return String(c.id) === String(idv) ? Object.assign({}, c, { status: c.status === "pago" ? "pendente" : "pago" }) : c;
  });
  salvar(); renderizar();
}
function excluirConta(idv) {
  if (idv === "fatura-cartao") return toast("A fatura do cartão é gerada automaticamente.", "warn");
  contas = contas.filter(function (c) { return String(c.id) !== String(idv); });
  salvar(); renderizar();
}
function excluirCompra(idv) { comprasCartao = comprasCartao.filter(function (c) { return String(c.id) !== String(idv); }); salvar(); renderizar(); }
function excluirMeta(idv) { metas = metas.filter(function (m) { return String(m.id) !== String(idv); }); salvar(); renderizar(); }

function editarConta(idv) {
  if (idv === "fatura-cartao") return toast("Edite a fatura na aba Cartão.", "warn");
  const c = contas.find(function (i) { return String(i.id) === String(idv); });
  if (!c) return;
  contaEditandoId = idv;
  $("contaNome").value = c.nome; $("contaValor").value = c.valor;
  $("contaData").value = c.data;
  $("contaTipo").value = Array.from($("contaTipo").options).some(function (o) { return o.value === c.tipo; }) ? c.tipo : "mensal";
  $("contaCategoria").value = c.categoria || "Geral";
  $("contaRecorrencia").value = "unica"; $("contaDuracao").value = "";
  $("btnConta").innerText = "Salvar edição";
  $("btnCancelarConta").classList.remove("hidden");
  openTabPorId("contas"); window.scrollTo({ top: 0, behavior: "smooth" });
}
function editarCompra(idv) {
  const c = comprasCartao.find(function (i) { return String(i.id) === String(idv); });
  if (!c) return;
  compraEditandoId = idv;
  $("compraNome").value = c.nome; $("compraValor").value = c.valor;
  $("compraData").value = c.data; $("compraCategoria").value = c.categoria || "Cartão";
  $("btnCompra").innerText = "Salvar compra";
  $("btnCancelarCompra").classList.remove("hidden");
  openTabPorId("cartao"); window.scrollTo({ top: 0, behavior: "smooth" });
}
function editarMeta(idv) {
  const m = metas.find(function (i) { return String(i.id) === String(idv); });
  if (!m) return;
  metaEditandoId = idv;
  $("metaNome").value = m.nome; $("metaAlvo").value = m.alvo;
  $("metaGuardado").value = m.guardado; $("metaPrazo").value = m.prazo;
  $("metaPrioridade").value = m.prioridade || "média";
  $("btnMeta").innerText = "Salvar meta";
  $("btnCancelarMeta").classList.remove("hidden");
  openTabPorId("metas"); window.scrollTo({ top: 0, behavior: "smooth" });
}

function itemConta(c) {
  const classe = c.status === "pago" ? "paid" : "";
  const label = urgencia(c);
  let bc = "";
  if (label.indexOf("Vencida") === 0) bc = "badge-red";
  if (label === "Vence hoje" || label === "Vence amanhã" || (label.indexOf("Vence em") === 0 && diasAte(c.data) <= 7)) bc = "badge-yellow";
  if (label === "Pago") bc = "badge-green";
  return '<div class="item"><div><p class="item-title ' + classe + '">' + escHtml(c.nome) + '</p>'
       + '<p class="item-meta"><span class="badge">' + escHtml(c.tipo) + '</span><span class="badge">' + escHtml(c.categoria) + '</span><span class="badge ' + bc + '">' + escHtml(label) + '</span></p>'
       + '<p class="item-meta">Vencimento: ' + dataBR(c.data) + '</p></div>'
       + '<div class="item-actions"><span class="amount">' + dinheiro(c.valor) + '</span>'
       + '<button class="btn btn-small btn-dark" onclick="marcarPago(\'' + c.id + '\')">' + (c.status === "pago" ? "Reabrir" : "Pagar") + '</button>'
       + '<button class="btn btn-small btn-dark" onclick="editarConta(\'' + c.id + '\')">Editar</button>'
       + '<button class="btn btn-small btn-red" onclick="excluirConta(\'' + c.id + '\')">Excluir</button>'
       + '</div></div>';
}

/* ===========================================================
   Mês a mês
   =========================================================== */
function contasDoMes(chave) { return todasContas().filter(function (c) { return chaveMesDaData(c.data) === chave; }); }
function salarioDoMes(chave) {
  if (salariosPorMes && salariosPorMes[chave] !== undefined) return Number(salariosPorMes[chave] || 0);
  if (chave === chaveMesAtual()) return Number(salarioMes || 0);
  return 0;
}
function salvarSalarioMesReferencia() {
  const chave = $("mesReferencia").value || chaveMesAtual();
  salariosPorMes[chave] = Number($("salarioMesReferencia").value || 0);
  if (chave === chaveMesAtual()) salarioMes = Number($("salarioMesReferencia").value || 0);
  salvar(); renderizar(); renderizarMesAMes();
}
function alterarMesReferencia(delta) {
  const atual = $("mesReferencia").value || chaveMesAtual();
  const p = atual.split("-").map(Number);
  const d = new Date(p[0], p[1] - 1 + delta, 1);
  $("mesReferencia").value = d.toISOString().slice(0, 7);
  renderizarMesAMes();
}
function irParaMesAnterior() { alterarMesReferencia(-1); }
function irParaProximoMes() { alterarMesReferencia(1); }
function irParaMesAtual() { $("mesReferencia").value = chaveMesAtual(); renderizarMesAMes(); }

function faturaDoMes(chave) { return Number((faturasPorMes && faturasPorMes[chave]) || 0); }
function salvarFaturaMes() {
  const chave = $("faturaMesReferencia").value || chaveMesAtual();
  const valor = Number($("faturaMesValor").value || 0);
  if (!chave) return toast("Escolha o mês da fatura.", "warn");
  faturasPorMes[chave] = valor; salvar(); renderizar();
}
function limparFaturaMesSelecionado() {
  const chave = $("faturaMesReferencia").value || chaveMesAtual();
  delete faturasPorMes[chave]; salvar(); renderizar();
}
function preencherMesesAteDezembro() {
  const base = $("faturaMesReferencia").value || chaveMesAtual();
  const p = base.split("-").map(Number);
  const ano = p[0]; const mesInicial = p[1];
  for (let mes = mesInicial; mes <= 12; mes++) {
    const chave = ano + "-" + String(mes).padStart(2, "0");
    if (faturasPorMes[chave] === undefined) faturasPorMes[chave] = 0;
  }
  salvar(); renderizar();
}
function renderizarFaturasMensais() {
  if (!$("listaFaturasMensais")) return;
  const chaves = Object.keys(faturasPorMes || {}).sort();
  if ($("faturaMesReferencia") && !$("faturaMesReferencia").value) $("faturaMesReferencia").value = chaveMesAtual();
  if (!chaves.length) { $("listaFaturasMensais").innerHTML = '<p class="empty">Nenhuma fatura mensal cadastrada.</p>'; return; }
  $("listaFaturasMensais").innerHTML = chaves.map(function (chave) {
    return '<div class="item"><div><p class="item-title">Fatura ' + nomeMes(chave) + '</p><p class="item-meta">Entra no cálculo de ' + nomeMes(chave) + '</p></div>'
         + '<div class="item-actions"><span class="amount">' + dinheiro(faturasPorMes[chave]) + '</span>'
         + '<button class="btn btn-small btn-dark" onclick="editarFaturaMes(\'' + chave + '\')">Editar</button>'
         + '<button class="btn btn-small btn-red" onclick="excluirFaturaMes(\'' + chave + '\')">Excluir</button>'
         + '</div></div>';
  }).join("");
}
function editarFaturaMes(chave) {
  $("faturaMesReferencia").value = chave;
  $("faturaMesValor").value = Number(faturasPorMes[chave] || 0);
  openTabPorId("cartao");
}
function excluirFaturaMes(chave) { delete faturasPorMes[chave]; salvar(); renderizar(); }
function imprimirRelatorioMes() { renderizarMesAMes(); window.print(); }
function renderizarMesAMes() {
  if (!$("mesReferencia")) return;
  const chave = $("mesReferencia").value || chaveMesAtual();
  $("mesReferencia").value = chave;
  const lista = contasDoMes(chave);
  const abertas = lista.filter(function (c) { return c.status !== "pago"; });
  const pagas = lista.filter(function (c) { return c.status === "pago"; });
  const salario = salarioDoMes(chave);
  const totalContas = abertas.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
  const faturaManual = faturaDoMes(chave);
  const total = totalContas + faturaManual;
  const saldo = salario - total;
  $("salarioMesReferencia").value = salario || "";
  $("salarioMesReferenciaCard").innerText = dinheiro(salario);
  $("totalMesReferenciaCard").innerText = dinheiro(total);
  $("descontoMesReferenciaCard").innerText = "-" + dinheiro(total);
  $("saldoMesReferenciaCard").innerText = dinheiro(saldo);
  $("saldoMesReferenciaCard").className = "metric-value " + (saldo >= 0 ? "metric-green" : "metric-red");
  const faturaHtml = faturaManual > 0
    ? '<div class="item"><div><p class="item-title">Fatura do cartão</p><p class="item-meta">Valor lançado manualmente para ' + nomeMes(chave) + '</p></div><div class="item-actions"><span class="amount">' + dinheiro(faturaManual) + '</span></div></div>'
    : "";
  $("listaContasMesReferencia").innerHTML = (abertas.length || faturaManual > 0)
    ? (faturaHtml + abertas.map(itemConta).join(""))
    : '<p class="empty">Nenhuma conta aberta em ' + nomeMes(chave) + '.</p>';
  $("listaContasPagasMesReferencia").innerHTML = pagas.length ? pagas.map(itemConta).join("") : '<p class="empty">Nenhuma conta paga em ' + nomeMes(chave) + '.</p>';
}

function marcarCartaoAtualizado() { ultimaAtualizacaoCartao = hoje; salvar(); renderizar(); }
function renderizarLembreteCartao() {
  if (!$("statusAtualizacaoCartao")) return;
  const atualizado = mesmoMes(ultimaAtualizacaoCartao, hoje);
  $("statusAtualizacaoCartao").innerText = atualizado ? "Fatura atualizada este mês" : "Atualize a fatura deste mês";
  $("statusAtualizacaoCartao").style.color = atualizado ? "var(--green)" : "var(--yellow)";
  $("ultimaAtualizacaoCartao").innerText = ultimaAtualizacaoCartao ? dataBR(ultimaAtualizacaoCartao) : "--/--/----";
}
function alternarCampoQuinzenasConta() {
  if (!$("contaQuinzenas")) return;
  const q = $("contaRecorrencia").value === "quinzenal";
  $("contaQuinzenas").classList.toggle("hidden", !q);
  $("contaDuracao").disabled = q;
  if (q) { $("contaDuracao").value = ""; }
}
function alternarCampoQuinzenas() {
  if (!$("parcelaQuinzenas")) return;
  const q = $("parcelaFrequencia").value === "quinzenal";
  $("parcelaQuinzenas").classList.toggle("hidden", !q);
  $("parcelaTotal").disabled = q; $("parcelaAtual").disabled = q;
  if (q) { $("parcelaTotal").value = ""; $("parcelaAtual").value = ""; }
  else { $("parcelaAtual").value = $("parcelaAtual").value || "1"; }
}

/* ===========================================================
   Render principal (painel + contas + parcelas + cartão + metas + prioridades + IA)
   =========================================================== */
function renderizar() {
  const lista = todasContas(), listaMes = contasDoMesAtual(), proximas = proximasContas(),
    abertas = listaMes.filter(function (c) { return c.status !== "pago"; }),
    pagas = listaMes.filter(function (c) { return c.status === "pago"; });
  const totalMes = abertas.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0) + faturaDoMes(chaveMesAtual());
  const saldo = salarioMes - totalMes;
  const fatura = totalCartao();
  const urgentes = proximas.filter(function (c) { return c.status !== "pago" && diasAte(c.data) <= 7; });

  if ($("salarioMes")) {
    $("salarioMes").value = salarioMes || "";
    $("salarioCard").innerText = dinheiro(salarioMes);
    $("totalMesCard").innerText = dinheiro(totalMes);
    $("descontoCard").innerText = "-" + dinheiro(totalMes);
    $("saldoCard").innerText = dinheiro(saldo);
    $("saldoCard").className = "metric-value " + (saldo >= 0 ? "metric-green" : "metric-red");
    $("listaProximos").innerHTML = proximas.slice(0, 6).length ? proximas.slice(0, 6).map(itemConta).join("") : '<p class="empty">Nenhum próximo vencimento cadastrado.</p>';
    $("listaUrgentes").innerHTML = urgentes.length ? urgentes.map(itemConta).join("") : '<p class="empty">Nenhuma conta urgente agora.</p>';
  }

  if ($("listaContas")) {
    const busca = ($("buscaConta").value || "").toLowerCase();
    const fs = $("filtroStatus").value || "todos", ft = $("filtroTipo").value || "todos";
    const filtradas = lista.filter(function (c) {
      const matchBusca = c.nome.toLowerCase().includes(busca) || (c.categoria || "").toLowerCase().includes(busca);
      return matchBusca && (fs === "todos" || c.status === fs) && (ft === "todos" || c.tipo === ft);
    });
    $("listaContas").innerHTML = filtradas.length ? filtradas.map(itemConta).join("") : '<p class="empty">Nenhuma conta encontrada.</p>';
  }

  if ($("listaParcelas")) {
    const parcelas = lista.filter(function (c) { return c.origem === "parcela"; });
    $("listaParcelas").innerHTML = parcelas.length ? parcelas.map(itemConta).join("") : '<p class="empty">Nenhuma parcela cadastrada.</p>';
  }

  if ($("valorFatura")) {
    $("valorFatura").innerText = dinheiro(fatura);
    $("limiteDisponivel").innerText = dinheiro(Number(cartao.limite || 0) - fatura);
    $("vencimentoCartao").innerText = dataBR(cartao.vencimento);
    renderizarLembreteCartao(); renderizarFaturasMensais();
    $("listaCompras").innerHTML = comprasCartao.length
      ? comprasCartao.map(function (c) {
          return '<div class="item"><div><p class="item-title">' + escHtml(c.nome) + '</p><p class="item-meta">' + escHtml(c.categoria) + ' • ' + dataBR(c.data) + '</p></div>'
               + '<div class="item-actions"><span class="amount">' + dinheiro(c.valor) + '</span>'
               + '<button class="btn btn-small btn-dark" onclick="editarCompra(\'' + c.id + '\')">Editar</button>'
               + '<button class="btn btn-small btn-red" onclick="excluirCompra(\'' + c.id + '\')">Excluir</button>'
               + '</div></div>';
        }).join("")
      : '<p class="empty">Nenhuma compra no cartão.</p>';
  }

  if ($("listaMetas")) {
    $("listaMetas").innerHTML = metas.length ? metas.map(function (m) {
      const p = Math.min(100, Math.round(Number(m.guardado || 0) / Number(m.alvo || 1) * 100));
      const falta = Number(m.alvo || 0) - Number(m.guardado || 0);
      return '<div class="card"><h3>' + escHtml(m.nome) + '</h3>'
           + '<p class="item-meta">Prazo: ' + dataBR(m.prazo) + ' • Prioridade: ' + escHtml(m.prioridade) + '</p>'
           + '<div class="progress"><div class="progress-bar" style="width:' + p + '%"></div></div>'
           + '<p class="item-meta">Progresso: ' + p + '%</p><br>'
           + '<p>Alvo: <strong>' + dinheiro(m.alvo) + '</strong></p>'
           + '<p>Guardado: <strong>' + dinheiro(m.guardado) + '</strong></p>'
           + '<p>Falta: <strong>' + dinheiro(falta) + '</strong></p><br>'
           + '<button class="btn btn-small btn-dark" onclick="editarMeta(\'' + m.id + '\')">Editar meta</button> '
           + '<button class="btn btn-small btn-red" onclick="excluirMeta(\'' + m.id + '\')">Excluir meta</button></div>';
    }).join("") : '<p class="empty">Nenhuma meta cadastrada.</p>';
  }

  if ($("listaPrioridades")) {
    const grupos = ["Vencidas", "Hoje", "Amanhã", "Esta semana", "Depois", "Pago"];
    $("listaPrioridades").innerHTML = grupos.map(function (g) {
      const itens = lista.filter(function (c) {
        const d = diasAte(c.data);
        if (g === "Vencidas") return c.status !== "pago" && d < 0;
        if (g === "Hoje") return c.status !== "pago" && d === 0;
        if (g === "Amanhã") return c.status !== "pago" && d === 1;
        if (g === "Esta semana") return c.status !== "pago" && d >= 2 && d <= 7;
        if (g === "Depois") return c.status !== "pago" && d > 7;
        if (g === "Pago") return c.status === "pago";
        return false;
      });
      return itens.length ? '<div style="margin-bottom:28px"><h3>' + g + '</h3><br><div class="list">' + itens.map(itemConta).join("") + '</div></div>' : "";
    }).join("") || '<p class="empty">Nenhuma prioridade encontrada.</p>';
  }

  if ($("analiseIA")) {
    $("analiseIA").innerHTML =
      '<p>Seu salário informado é <strong>' + dinheiro(salarioMes) + '</strong>.</p>'
      + '<p>O total das contas com vencimento no mês atual: <strong>' + dinheiro(totalMes) + '</strong>.</p>'
      + '<p>Contas dos próximos meses ficam cadastradas, mas não entram no desconto deste mês.</p>'
      + '<p>Após os descontos, o saldo estimado será <strong>' + dinheiro(saldo) + '</strong>.</p>'
      + analiseExtraVales()
      + analiseExtraHabitos();
    $("planoIA").innerHTML =
      '<p>1. Primeiro cubra contas vencidas e as que têm menos dias até o vencimento.</p>'
      + '<p>2. Seu salário precisa cobrir <strong>' + dinheiro(totalMes) + '</strong> em contas abertas.</p>'
      + '<p>3. Se o saldo ficar negativo, reduza compras no cartão ou renegocie vencimentos.</p>'
      + '<p>4. Se o saldo ficar positivo, direcione parte para metas ou reserva.</p>'
      + planoExtraHabitos();
  }

  renderizarRotina();
  renderizarConquistas();
  renderizarHoje();
  renderizarVales();
  renderizarMesAMes();
  renderizarStatusBackup();
  renderizarSnapshots();
  renderizarCalendario();
}

/* ===========================================================
   Hábitos
   =========================================================== */
function progressoHabitoNaData(idH, data) {
  const dia = registroHabitos && registroHabitos[data];
  const atual = dia && dia[idH] !== undefined ? Number(dia[idH]) : 0;
  const h = habitos.find(function (x) { return x.id === idH; });
  const meta = h ? Number(h.meta || 1) : 1;
  return { atual: atual, meta: meta, pct: Math.min(100, Math.round(atual / meta * 100)) };
}
function bateuMetaNoDia(idH, data) { const p = progressoHabitoNaData(idH, data); return p.atual >= p.meta; }
function streakAtualHabito(idH) {
  let streak = 0;
  const d = new Date(hoje + "T00:00:00");
  if (!bateuMetaNoDia(idH, hoje)) d.setDate(d.getDate() - 1);
  while (true) {
    const s = d.toISOString().slice(0, 10);
    if (bateuMetaNoDia(idH, s)) { streak++; d.setDate(d.getDate() - 1); } else break;
    if (streak > 3650) break;
  }
  return streak;
}
function maiorStreakHabito(idH) {
  const datas = Object.keys(registroHabitos || {}).sort();
  if (!datas.length) return 0;
  const d = new Date(datas[0] + "T00:00:00");
  const fim = new Date(hoje + "T00:00:00");
  let melhor = 0, atual = 0;
  while (d <= fim) {
    const s = d.toISOString().slice(0, 10);
    if (bateuMetaNoDia(idH, s)) { atual++; if (atual > melhor) melhor = atual; } else atual = 0;
    d.setDate(d.getDate() + 1);
  }
  return melhor;
}
function registrarHabito(idH, delta) {
  if (!registroHabitos[hoje]) registroHabitos[hoje] = {};
  const atual = Number(registroHabitos[hoje][idH] || 0);
  registroHabitos[hoje][idH] = Math.max(0, atual + Number(delta || 0));
  salvar(); renderizar();
}
function definirHabitoHoje(idH, valor) {
  if (!registroHabitos[hoje]) registroHabitos[hoje] = {};
  registroHabitos[hoje][idH] = Math.max(0, Number(valor || 0));
  salvar(); renderizar();
}
function salvarHabitoFormulario() { habitoEditandoId ? atualizarHabito() : adicionarHabito(); }
function adicionarHabito() {
  const nome = $("habitoNome").value.trim();
  const meta = Number($("habitoMeta").value);
  const unidade = $("habitoUnidade").value.trim() || "vez";
  const cor = $("habitoCor").value || "#2563eb";
  if (!nome || !meta || meta < 1) return toast("Preencha nome e meta válida.", "warn");
  habitos.push({ id: idNovo(), nome: nome, meta: meta, unidade: unidade, cor: cor, criadoEm: hoje });
  limparFormularioHabito(); salvar(); renderizar();
  toast("Hábito adicionado.", "success");
}
function atualizarHabito() {
  const nome = $("habitoNome").value.trim();
  const meta = Number($("habitoMeta").value);
  const unidade = $("habitoUnidade").value.trim() || "vez";
  const cor = $("habitoCor").value || "#2563eb";
  if (!nome || !meta || meta < 1) return toast("Preencha nome e meta válida.", "warn");
  habitos = habitos.map(function (h) {
    return String(h.id) === String(habitoEditandoId) ? Object.assign({}, h, { nome: nome, meta: meta, unidade: unidade, cor: cor }) : h;
  });
  limparFormularioHabito(); salvar(); renderizar();
}
function editarHabito(idH) {
  const h = habitos.find(function (x) { return String(x.id) === String(idH); });
  if (!h) return;
  habitoEditandoId = idH;
  $("habitoNome").value = h.nome; $("habitoMeta").value = h.meta;
  $("habitoUnidade").value = h.unidade || ""; $("habitoCor").value = h.cor || "#2563eb";
  $("btnHabito").innerText = "Salvar edição";
  $("btnCancelarHabito").classList.remove("hidden");
  openTabPorId("rotina"); window.scrollTo({ top: 0, behavior: "smooth" });
}
function excluirHabito(idH) {
  if (!confirm("Excluir este hábito? O histórico de registros será mantido.")) return;
  habitos = habitos.filter(function (h) { return String(h.id) !== String(idH); });
  salvar(); renderizar();
}
function limparFormularioHabito() {
  habitoEditandoId = null;
  $("habitoNome").value = ""; $("habitoMeta").value = "";
  $("habitoUnidade").value = ""; $("habitoCor").value = "#2563eb";
  $("btnHabito").innerText = "Adicionar hábito";
  $("btnCancelarHabito").classList.add("hidden");
}
function ringSVG(pct, cor, mini) {
  const size = mini ? 56 : 96;
  const r = mini ? 24 : 42;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  const corFinal = cor || '#818cf8';
  const gid = 'g_' + Math.random().toString(36).slice(2, 9);
  return '<div class="habit-ring' + (mini ? ' ring-mini' : '') + '" style="--habit-color:' + corFinal + '">'
    + '<svg viewBox="0 0 ' + size + ' ' + size + '">'
    + '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0%" stop-color="' + corFinal + '" stop-opacity="0.6"/>'
    + '<stop offset="100%" stop-color="' + corFinal + '" stop-opacity="1"/>'
    + '</linearGradient></defs>'
    + '<circle class="ring-bg" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '"></circle>'
    + '<circle class="ring-fg" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" stroke="url(#' + gid + ')" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"></circle>'
    + '</svg><div class="ring-label"><span class="pct">' + pct + '%</span></div></div>';
}
function heatmapHabitoMes(idH, chaveMes, cor) {
  const partes = chaveMes.split("-").map(Number);
  const ano = partes[0], mes = partes[1];
  const primeiroDia = new Date(ano, mes - 1, 1);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  let html = '<div class="heatmap" style="--habit-color:' + (cor || 'var(--primary)') + '">';
  const ws = primeiroDia.getDay();
  for (let i = 0; i < ws; i++) html += '<div class="cell" style="visibility:hidden"></div>';
  for (let d = 1; d <= ultimoDia; d++) {
    const iso = ano + "-" + String(mes).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    const p = progressoHabitoNaData(idH, iso);
    const lvl = p.atual === 0 ? 0 : p.pct < 25 ? 1 : p.pct < 60 ? 2 : p.pct < 100 ? 3 : 4;
    let cls = "cell" + (lvl ? " l" + lvl : "");
    if (iso === hoje) cls += " today";
    if (iso > hoje) cls += " future";
    html += '<div class="' + cls + '" title="' + iso + ' — ' + p.atual + '/' + p.meta + '"></div>';
  }
  html += '</div>';
  return html;
}
function cardHabito(h) {
  const p = progressoHabitoNaData(h.id, hoje);
  const streak = streakAtualHabito(h.id);
  const maior = maiorStreakHabito(h.id);
  const classeStreak = streak >= 7 ? " hot" : "";
  const chaveMes = hoje.slice(0, 7);
  return '<div class="habit-card" style="--habit-color:' + (h.cor || 'var(--primary)') + ';border-left-color:' + (h.cor || 'var(--primary)') + '">'
    + ringSVG(p.pct, h.cor)
    + '<div class="habit-info"><div class="habit-name">' + escHtml(h.nome) + '</div>'
    + '<div class="habit-meta"><span>' + p.atual + ' / ' + p.meta + ' ' + escHtml(h.unidade || "") + ' hoje</span>'
    + '<span class="habit-streak' + classeStreak + '">' + streak + ' dia' + (streak === 1 ? "" : "s") + ' seguidos</span>'
    + '<span class="habit-streak">Recorde: ' + maior + '</span></div>'
    + '<div class="habit-actions">'
    + '<button class="btn btn-small btn-green" onclick="registrarHabito(\'' + h.id + '\',1)">+1</button>'
    + '<button class="btn btn-small btn-dark" onclick="registrarHabito(\'' + h.id + '\',-1)">-1</button>'
    + '<button class="btn btn-small btn-dark" onclick="definirHabitoHoje(\'' + h.id + '\',' + p.meta + ')">Bater meta</button>'
    + '<button class="btn btn-small btn-dark" onclick="definirHabitoHoje(\'' + h.id + '\',0)">Zerar dia</button>'
    + '<button class="btn btn-small btn-dark" onclick="editarHabito(\'' + h.id + '\')">Editar</button>'
    + '<button class="btn btn-small btn-red" onclick="excluirHabito(\'' + h.id + '\')">Excluir</button>'
    + '</div>' + heatmapHabitoMes(h.id, chaveMes, h.cor) + '</div></div>';
}
function renderizarRotina() {
  if (!$("listaHabitos")) return;
  $("listaHabitos").innerHTML = habitos.length
    ? habitos.map(cardHabito).join("")
    : '<p class="empty">Nenhum hábito cadastrado ainda. Comece com água, treino ou leitura.</p>';
  $("totalHabitosCard").innerText = habitos.length;
  const cumpridos = habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length;
  $("habitosCumpridosCard").innerText = cumpridos + " / " + habitos.length;
  const pct = habitos.length ? Math.round(cumpridos / habitos.length * 100) : 0;
  $("scoreDiaCard").innerText = pct + "%";
  $("scoreDiaCard").className = "metric-value " + (pct >= 80 ? "metric-green" : pct >= 40 ? "" : "metric-red");
  const maior = habitos.reduce(function (m, h) { const s = streakAtualHabito(h.id); return s > m ? s : m; }, 0);
  $("maiorStreakCard").innerText = maior + (maior === 1 ? " dia" : " dias");
}
function analiseExtraHabitos() {
  if (!habitos.length) return "";
  const maior = habitos.reduce(function (m, h) { const s = streakAtualHabito(h.id); return s > m ? s : m; }, 0);
  const cumpridos = habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length;
  return '<p>Hoje você bateu <strong>' + cumpridos + ' de ' + habitos.length + '</strong> hábitos. Maior streak ativo: <strong>' + maior + ' dia' + (maior === 1 ? "" : "s") + '</strong>.</p>';
}
function analiseExtraVales() {
  const chave = chaveMesAtual();
  const vgRec = valeDoMes(chave, "gasolina");
  const vaRec = valeDoMes(chave, "alimentacao");
  if (!vgRec && !vaRec) return "";
  let html = "";
  if (vgRec) {
    const g = gastoCategoriaDoMes(chave, "Combustível");
    const s = vgRec - g;
    const pct = Math.round(g / vgRec * 100);
    html += '<p>Vale gasolina: <strong>' + dinheiro(g) + '</strong> gastos de <strong>' + dinheiro(vgRec) + '</strong> (' + pct + '%). Saldo: <strong>' + dinheiro(s) + '</strong>.</p>';
  }
  if (vaRec) {
    const g = gastoCategoriaDoMes(chave, "Alimentação");
    const s = vaRec - g;
    const pct = Math.round(g / vaRec * 100);
    html += '<p>Vale alimentação: <strong>' + dinheiro(g) + '</strong> gastos de <strong>' + dinheiro(vaRec) + '</strong> (' + pct + '%). Saldo: <strong>' + dinheiro(s) + '</strong>.</p>';
  }
  return html;
}
function planoExtraHabitos() {
  if (!habitos.length) return '<p>5. Cadastre 1-2 hábitos de rotina (água, atividade física) — pequenas vitórias diárias seguram o resto.</p>';
  const cumpridos = habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length;
  if (cumpridos === habitos.length) return '<p>5. Rotina inteira batida hoje. Não quebra a corrente.</p>';
  if (cumpridos > 0) return '<p>5. Faltam <strong>' + (habitos.length - cumpridos) + '</strong> hábito(s) pra fechar o dia perfeito.</p>';
  return '<p>5. Comece pelo hábito mais fácil agora (1 copo de água, 5 min de leitura).</p>';
}

/* ===========================================================
   Conquistas
   =========================================================== */
function helperSaldoMes(chave) {
  const sal = salarioDoMes(chave);
  const lista = contasDoMes(chave);
  const abertas = lista.filter(function (c) { return c.status !== "pago"; });
  const totalContas = abertas.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
  const fat = faturaDoMes(chave);
  return { salario: sal, total: totalContas + fat, saldo: sal - (totalContas + fat) };
}
function listaUltimosMeses(n) {
  const arr = []; const d = new Date(hoje + "T00:00:00");
  for (let i = 0; i < n; i++) { arr.push(d.toISOString().slice(0, 7)); d.setMonth(d.getMonth() - 1); }
  return arr;
}
function gerarConquistas() {
  const lista = [];
  const saldoAtual = helperSaldoMes(chaveMesAtual());
  lista.push({ id: "salario_cadastrado", titulo: "Salário registrado", desc: "Lançar um salário no app.", icone: "$", grupo: "Finanças", atual: salarioMes > 0 ? 1 : 0, alvo: 1 });
  lista.push({ id: "mes_no_azul", titulo: "Mês no azul", desc: "Terminar o mês com saldo positivo.", icone: "↑", grupo: "Finanças", atual: (saldoAtual.saldo >= 0 && saldoAtual.salario > 0) ? 1 : 0, alvo: 1 });
  const ultimos3 = listaUltimosMeses(3);
  const azuis = ultimos3.filter(function (c) { const s = helperSaldoMes(c); return s.saldo >= 0 && s.salario > 0; }).length;
  lista.push({ id: "tres_meses_azul", titulo: "Trimestre saudável", desc: "3 meses seguidos no azul.", icone: "★", grupo: "Finanças", atual: azuis, alvo: 3 });
  const algumaMeta = metas.find(function (m) { return Number(m.guardado || 0) >= Number(m.alvo || 0) && Number(m.alvo || 0) > 0; });
  lista.push({ id: "primeira_meta", titulo: "Meta cumprida", desc: "Atingir qualquer meta cadastrada.", icone: "◎", grupo: "Finanças", atual: algumaMeta ? 1 : 0, alvo: 1 });
  const fat = totalCartao(); const limite = Number(cartao.limite || 0);
  lista.push({ id: "cartao_sob_controle", titulo: "Cartão sob controle", desc: "Usar menos de 70% do limite.", icone: "✓", grupo: "Finanças", atual: (limite > 0 && fat / limite < 0.7) ? 1 : 0, alvo: 1 });
  lista.push({ id: "cartao_zerado", titulo: "Cartão zerado", desc: "Fatura atual igual a zero.", icone: "○", grupo: "Finanças", atual: (fat === 0 && Number(cartao.fatura || 0) === 0) ? 1 : 0, alvo: 1 });
  const vencidas = todasContas().filter(function (c) { return c.status !== "pago" && diasAte(c.data) < 0; }).length;
  lista.push({ id: "sem_vencidas", titulo: "Tudo em dia", desc: "Nenhuma conta vencida pendente.", icone: "≡", grupo: "Finanças", atual: (vencidas === 0 && todasContas().length > 0) ? 1 : 0, alvo: 1 });
  lista.push({ id: "primeiro_habito", titulo: "Primeiro hábito", desc: "Cadastrar seu primeiro hábito.", icone: "▢", grupo: "Rotina", atual: habitos.length >= 1 ? 1 : 0, alvo: 1 });
  lista.push({ id: "cinco_habitos", titulo: "Rotina formada", desc: "5 hábitos cadastrados.", icone: "▤", grupo: "Rotina", atual: habitos.length, alvo: 5 });
  lista.push({ id: "todos_hoje", titulo: "Dia perfeito", desc: "Bater a meta de todos os hábitos no mesmo dia.", icone: "●", grupo: "Rotina", atual: (habitos.length > 0 && habitos.every(function (h) { return bateuMetaNoDia(h.id, hoje); })) ? 1 : 0, alvo: 1 });
  habitos.forEach(function (h) {
    const sa = streakAtualHabito(h.id), mx = maiorStreakHabito(h.id);
    const melhor = Math.max(sa, mx);
    lista.push({ id: "h_" + h.id + "_7", titulo: h.nome + " — 7 dias", desc: "7 dias seguidos batendo a meta.", icone: "▶", grupo: "Rotina", atual: Math.min(melhor, 7), alvo: 7 });
    lista.push({ id: "h_" + h.id + "_30", titulo: h.nome + " — 30 dias", desc: "30 dias seguidos batendo a meta.", icone: "▶▶", grupo: "Rotina", atual: Math.min(melhor, 30), alvo: 30 });
    lista.push({ id: "h_" + h.id + "_100", titulo: h.nome + " — 100 dias", desc: "100 dias seguidos batendo a meta.", icone: "★", grupo: "Rotina", atual: Math.min(melhor, 100), alvo: 100 });
  });
  let precisaSalvar = false;
  lista.forEach(function (c) {
    c.pct = Math.min(100, Math.round(c.atual / Math.max(1, c.alvo) * 100));
    c.desbloqueada = c.atual >= c.alvo;
    if (c.desbloqueada && !conquistasDesbloqueadas[c.id]) {
      conquistasDesbloqueadas[c.id] = hoje; precisaSalvar = true;
      // Toast só na primeira detecção
      setTimeout(function () { toast("Conquista: " + c.titulo, "success"); }, 50);
    }
    if (conquistasDesbloqueadas[c.id]) c.dataDesbloqueio = conquistasDesbloqueadas[c.id];
  });
  if (precisaSalvar) dbSet("conquistasDesbloqueadas", conquistasDesbloqueadas).catch(function () {});
  return lista;
}
function renderizarConquistas() {
  if (!$("listaConquistasDesbloqueadas") || !$("listaConquistasPendentes")) return;
  const lista = gerarConquistas();
  const desbloqueadas = lista.filter(function (c) { return c.desbloqueada; });
  const pendentes = lista.filter(function (c) { return !c.desbloqueada; });
  $("resumoConquistasTexto").innerText = desbloqueadas.length + " / " + lista.length + " desbloqueadas";
  const pct = lista.length ? Math.round(desbloqueadas.length / lista.length * 100) : 0;
  $("resumoConquistasBarra").style.width = pct + "%";
  function renderCard(c) {
    const classe = c.desbloqueada ? "ach-card unlocked" : "ach-card locked";
    const status = c.desbloqueada
      ? '<div class="ach-status">Desbloqueada em ' + dataBR(c.dataDesbloqueio || hoje) + '</div>'
      : '<div class="ach-status">' + c.atual + ' / ' + c.alvo + ' (' + c.pct + '%)</div><div class="ach-progress"><div class="bar" style="width:' + c.pct + '%"></div></div>';
    return '<div class="' + classe + '"><div class="ach-icon">' + escHtml(c.icone) + '</div>'
      + '<div class="ach-body"><div class="ach-title">' + escHtml(c.titulo) + '</div>'
      + '<div class="ach-desc"><span class="badge">' + escHtml(c.grupo) + '</span> ' + escHtml(c.desc) + '</div>'
      + status + '</div></div>';
  }
  $("listaConquistasDesbloqueadas").innerHTML = desbloqueadas.length ? desbloqueadas.map(renderCard).join("") : '<p class="empty">Nenhuma conquista desbloqueada ainda.</p>';
  $("listaConquistasPendentes").innerHTML = pendentes.length ? pendentes.map(renderCard).join("") : '<p class="empty">Tudo desbloqueado. Parabéns!</p>';
}

/* ===========================================================
   Calendário mensal
   =========================================================== */
let calendarioMes = chaveMesAtual();      // "AAAA-MM"
let calendarioDiaSelecionado = hoje;       // "AAAA-MM-DD" ou null

function alterarMesCalendario(delta) {
  const p = calendarioMes.split("-").map(Number);
  const d = new Date(p[0], p[1] - 1 + delta, 1);
  calendarioMes = d.toISOString().slice(0, 7);
  // se a seleção atual cai fora do novo mês, limpa
  if (calendarioDiaSelecionado && !calendarioDiaSelecionado.startsWith(calendarioMes)) {
    calendarioDiaSelecionado = null;
  }
  renderizarCalendario();
}
function irParaMesAtualCalendario() {
  calendarioMes = chaveMesAtual();
  calendarioDiaSelecionado = hoje;
  renderizarCalendario();
}
function selecionarDiaCalendario(iso) {
  // se está fora do mês visível, navega
  if (!iso.startsWith(calendarioMes)) {
    calendarioMes = iso.slice(0, 7);
  }
  calendarioDiaSelecionado = iso;
  renderizarCalendario();
}
function contasNoDia(iso) {
  return todasContas().filter(function (c) { return c.data === iso; });
}
function celulaDiaCalendario(iso, numDia, outside) {
  const cs = contasNoDia(iso);
  const dots = cs.slice(0, 6).map(function (c) {
    let classe = "gray";
    if (c.status === "pago") classe = "green";
    else {
      const d = diasAte(c.data);
      if (d < 0) classe = "red";
      else if (d <= 7) classe = "yellow";
    }
    return '<span class="cal-dot ' + classe + '" title="' + escHtml(c.nome) + ' — ' + dinheiro(c.valor) + '"></span>';
  }).join("");
  const sobra = cs.length > 6 ? '<span class="cal-more">+' + (cs.length - 6) + '</span>' : '';

  const todosHabitos = habitos.length > 0 && habitos.every(function (h) { return bateuMetaNoDia(h.id, iso); });

  let classes = "cal-day";
  if (outside) classes += " outside";
  if (iso === hoje) classes += " today";
  if (iso === calendarioDiaSelecionado) classes += " selected";

  return '<div class="' + classes + '" onclick="selecionarDiaCalendario(\'' + iso + '\')">'
    + (todosHabitos ? '<div class="cal-habit-flag" title="Todos os hábitos batidos"></div>' : '')
    + '<div class="cal-num">' + numDia + '</div>'
    + '<div class="cal-dots">' + dots + sobra + '</div>'
    + '</div>';
}
function renderizarCalendario() {
  if (!$("calGrid")) return;
  const partes = calendarioMes.split("-").map(Number);
  const ano = partes[0], mes = partes[1];
  $("calMesNome").innerText = nomeMes(calendarioMes);

  const primeiroDia = new Date(ano, mes - 1, 1);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const inicioWeekday = primeiroDia.getDay();
  const ultimoDiaAnterior = new Date(ano, mes - 1, 0).getDate();

  let html = "";
  // dias do mês anterior (pra preencher primeira semana)
  for (let i = inicioWeekday - 1; i >= 0; i--) {
    const dia = ultimoDiaAnterior - i;
    const m = mes === 1 ? 12 : mes - 1;
    const a = mes === 1 ? ano - 1 : ano;
    const iso = a + "-" + String(m).padStart(2, "0") + "-" + String(dia).padStart(2, "0");
    html += celulaDiaCalendario(iso, dia, true);
  }
  // dias do mês
  for (let d = 1; d <= ultimoDia; d++) {
    const iso = ano + "-" + String(mes).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    html += celulaDiaCalendario(iso, d, false);
  }
  // dias do mês seguinte (pra completar a grade)
  const totalCelulas = inicioWeekday + ultimoDia;
  const sobra = (7 - (totalCelulas % 7)) % 7;
  for (let d = 1; d <= sobra; d++) {
    const m = mes === 12 ? 1 : mes + 1;
    const a = mes === 12 ? ano + 1 : ano;
    const iso = a + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    html += celulaDiaCalendario(iso, d, true);
  }
  $("calGrid").innerHTML = html;
  renderizarDetalheCalendario();
}
function renderizarDetalheCalendario() {
  if (!$("calDetail")) return;
  if (!calendarioDiaSelecionado) {
    $("calDetail").classList.add("hidden");
    return;
  }
  $("calDetail").classList.remove("hidden");
  const d = new Date(calendarioDiaSelecionado + "T12:00:00");
  $("calDetailTitle").innerText = d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  const cs = contasNoDia(calendarioDiaSelecionado);
  const totalDia = cs.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
  const abertasDia = cs.filter(function (c) { return c.status !== "pago"; });
  const pagasDia = cs.filter(function (c) { return c.status === "pago"; });

  let html = "";
  if (cs.length) {
    html += '<div class="cal-subtitle">Contas no dia · total ' + dinheiro(totalDia) + '</div>';
    if (abertasDia.length) html += '<div class="list" style="margin-bottom:10px">' + abertasDia.map(itemConta).join("") + '</div>';
    if (pagasDia.length) html += '<div class="list">' + pagasDia.map(itemConta).join("") + '</div>';
  } else {
    html += '<p class="empty" style="margin-bottom:10px">Nenhuma conta neste dia.</p>';
  }

  if (habitos.length) {
    html += '<div class="cal-subtitle">Hábitos no dia</div>';
    html += '<div class="list">' + habitos.map(function (h) {
      const p = progressoHabitoNaData(h.id, calendarioDiaSelecionado);
      const ok = p.atual >= p.meta;
      const classeBadge = ok ? "badge-green" : (p.atual > 0 ? "badge-yellow" : "");
      return '<div class="item" style="--habit-color:' + (h.cor || 'var(--primary)') + '">'
        + '<div><p class="item-title">' + escHtml(h.nome) + '</p>'
        + '<p class="item-meta">' + p.atual + ' / ' + p.meta + ' ' + escHtml(h.unidade || "") + ' (' + p.pct + '%)</p></div>'
        + '<div class="item-actions"><span class="badge ' + classeBadge + '">' + (ok ? "Batido" : (p.atual > 0 ? "Parcial" : "Não batido")) + '</span></div>'
        + '</div>';
    }).join("") + '</div>';
  }

  $("calDetailBody").innerHTML = html;
}

/* ===========================================================
   Vales (Gasolina, Alimentação) + categorias
   =========================================================== */
function chaveMesVales() {
  return ($("valesMesReferencia") && $("valesMesReferencia").value) ? $("valesMesReferencia").value : chaveMesAtual();
}
function valeDoMes(chave, tipo) {
  const m = valesPorMes && valesPorMes[chave];
  return Number((m && m[tipo]) || 0);
}
function definirValeMes(chave, tipo, valor) {
  if (!valesPorMes[chave]) valesPorMes[chave] = {};
  valesPorMes[chave][tipo] = Math.max(0, Number(valor || 0));
  salvar(); renderizar();
}
function salvarValeGasolina() {
  const chave = chaveMesVales();
  definirValeMes(chave, "gasolina", $("vgValor").value);
  toast("Vale gasolina salvo para " + nomeMes(chave), "success");
}
function salvarValeAlimentacao() {
  const chave = chaveMesVales();
  definirValeMes(chave, "alimentacao", $("vaValor").value);
  toast("Vale alimentação salvo para " + nomeMes(chave), "success");
}
function gastoCategoriaDoMes(chave, categoria) {
  const alvo = String(categoria || "").toLowerCase();
  return contas.filter(function (c) {
    return chaveMesDaData(c.data) === chave && String(c.categoria || "").toLowerCase() === alvo;
  }).reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
}
function adicionarAbastecimento() {
  const nome = ($("abastNome").value || "").trim() || "Posto";
  const valor = Number($("abastValor").value);
  const data = $("abastData").value || hoje;
  const litros = Number($("abastLitros").value || 0);
  const km = Number($("abastKm").value || 0);
  if (!valor) return toast("Informe o valor do abastecimento.", "warn");
  const extras = [];
  if (litros) extras.push(litros + " L");
  if (km) extras.push(km + " km");
  const nomeCompleto = nome + (extras.length ? " · " + extras.join(" / ") : "");
  contas.push({
    id: idNovo(), nome: nomeCompleto, valor: valor, data: data,
    tipo: "avulso", categoria: "Combustível", status: "pago",
    origem: "abastecimento", litros: litros, km: km
  });
  $("abastNome").value = "Posto";
  $("abastValor").value = "";
  $("abastLitros").value = "";
  $("abastKm").value = "";
  $("abastData").value = hoje;
  salvar(); renderizar();
  toast("Abastecimento registrado.", "success");
}
function adicionarAlimentacao() {
  const nome = ($("alimNome").value || "").trim() || "Alimentação";
  const valor = Number($("alimValor").value);
  const data = $("alimData").value || hoje;
  const tipo = $("alimTipo").value || "Outros";
  if (!valor) return toast("Informe o valor.", "warn");
  contas.push({
    id: idNovo(), nome: nome + " · " + tipo, valor: valor, data: data,
    tipo: "avulso", categoria: "Alimentação", status: "pago",
    origem: "alimentacao", subtipo: tipo
  });
  $("alimNome").value = "Mercado";
  $("alimValor").value = "";
  $("alimData").value = hoje;
  salvar(); renderizar();
  toast("Alimentação registrada.", "success");
}
function alterarMesVales(delta) {
  const atual = chaveMesVales();
  const p = atual.split("-").map(Number);
  const d = new Date(p[0], p[1] - 1 + delta, 1);
  $("valesMesReferencia").value = d.toISOString().slice(0, 7);
  renderizarVales();
}
function irParaMesAtualVales() {
  if ($("valesMesReferencia")) $("valesMesReferencia").value = chaveMesAtual();
  renderizarVales();
}
function itemVale(c) {
  return '<div class="item"><div><p class="item-title">' + escHtml(c.nome) + '</p>'
    + '<p class="item-meta">' + dataBR(c.data) + '</p></div>'
    + '<div class="item-actions"><span class="amount">' + dinheiro(c.valor) + '</span>'
    + '<button class="btn btn-small btn-red" onclick="excluirConta(\'' + c.id + '\')">Excluir</button>'
    + '</div></div>';
}
function renderizarVales() {
  if (!$("vales")) return;
  if ($("valesMesReferencia") && !$("valesMesReferencia").value) $("valesMesReferencia").value = chaveMesAtual();
  const chave = chaveMesVales();

  const vgRec = valeDoMes(chave, "gasolina");
  const vgGasto = gastoCategoriaDoMes(chave, "Combustível");
  const vgSaldo = vgRec - vgGasto;
  $("vgValor").value = vgRec || "";
  $("vgRecebido").innerText = dinheiro(vgRec);
  $("vgGasto").innerText = dinheiro(vgGasto);
  $("vgSaldo").innerText = dinheiro(vgSaldo);
  $("vgSaldo").className = "metric-value " + (vgSaldo >= 0 ? "metric-green" : "metric-red");

  const vaRec = valeDoMes(chave, "alimentacao");
  const vaGasto = gastoCategoriaDoMes(chave, "Alimentação");
  const vaSaldo = vaRec - vaGasto;
  $("vaValor").value = vaRec || "";
  $("vaRecebido").innerText = dinheiro(vaRec);
  $("vaGasto").innerText = dinheiro(vaGasto);
  $("vaSaldo").innerText = dinheiro(vaSaldo);
  $("vaSaldo").className = "metric-value " + (vaSaldo >= 0 ? "metric-green" : "metric-red");

  const abastecimentos = contas.filter(function (c) {
    return String(c.categoria || "").toLowerCase() === "combustível" && chaveMesDaData(c.data) === chave;
  }).sort(function (a, b) { return new Date(b.data) - new Date(a.data); });
  $("listaAbastecimentos").innerHTML = abastecimentos.length
    ? abastecimentos.map(itemVale).join("")
    : '<p class="empty">Nenhum abastecimento neste mês.</p>';

  const alimentacao = contas.filter(function (c) {
    return String(c.categoria || "").toLowerCase() === "alimentação" && chaveMesDaData(c.data) === chave;
  }).sort(function (a, b) { return new Date(b.data) - new Date(a.data); });
  $("listaAlimentacao").innerHTML = alimentacao.length
    ? alimentacao.map(itemVale).join("")
    : '<p class="empty">Nenhum gasto de alimentação neste mês.</p>';
}

/* ===========================================================
   Aba Hoje
   =========================================================== */
function saudacaoHora() {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}
function dataHojeExtenso() {
  try { return new Date(hoje + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }); }
  catch (e) { return dataBR(hoje); }
}
function linhaHabitoCompacta(h) {
  const p = progressoHabitoNaData(h.id, hoje);
  const streak = streakAtualHabito(h.id);
  return '<div class="habit-row" style="--habit-color:' + (h.cor || 'var(--primary)') + '">'
    + ringSVG(p.pct, h.cor, true)
    + '<div class="habit-row-info"><div class="habit-row-name">' + escHtml(h.nome) + '</div>'
    + '<div class="habit-row-meta">' + p.atual + ' / ' + p.meta + ' ' + escHtml(h.unidade || "") + ' • ' + streak + ' dia' + (streak === 1 ? "" : "s") + ' seguidos</div></div>'
    + '<div class="habit-row-actions">'
    + '<button class="btn btn-small btn-green" onclick="registrarHabito(\'' + h.id + '\',1)">+1</button>'
    + '<button class="btn btn-small btn-dark" onclick="definirHabitoHoje(\'' + h.id + '\',' + p.meta + ')">OK</button>'
    + '</div></div>';
}
function renderizarHoje() {
  if (!$("hoje")) return;
  $("hojeSaudacao").innerText = saudacaoHora() + "!";
  $("hojeData").innerText = "Hoje é " + dataHojeExtenso() + ".";
  const totalHab = habitos.length;
  const cumpridos = habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length;
  const pctHab = totalHab ? Math.round(cumpridos / totalHab * 100) : 0;
  $("hojeScoreHabitos").innerText = pctHab + "%";
  $("hojeScoreHabitos").className = "metric-value " + (pctHab >= 80 ? "metric-green" : pctHab >= 40 ? "" : "metric-red");
  const listaMes = contasDoMesAtual();
  const totalMes = listaMes.length;
  const pagasMes = listaMes.filter(function (c) { return c.status === "pago"; }).length;
  const pctContas = totalMes ? Math.round(pagasMes / totalMes * 100) : 0;
  $("hojeScoreContas").innerText = pctContas + "%";
  $("hojeScoreContas").className = "metric-value " + (pctContas >= 80 ? "metric-green" : pctContas >= 40 ? "" : "metric-red");
  if (totalHab) {
    const menor = Math.min.apply(null, habitos.map(function (h) { return streakAtualHabito(h.id); }));
    $("hojeStreakCombo").innerText = menor + (menor === 1 ? " dia" : " dias");
    $("hojeStreakCombo").title = "Menor streak entre seus hábitos (sua corrente é tão forte quanto o elo mais fraco)";
  } else {
    $("hojeStreakCombo").innerText = "—";
  }
  const s = helperSaldoMes(chaveMesAtual());
  $("hojeSaldo").innerText = dinheiro(s.saldo);
  $("hojeSaldo").className = "metric-value " + (s.saldo >= 0 ? "metric-green" : "metric-red");
  $("hojeHabitos").innerHTML = totalHab ? habitos.map(linhaHabitoCompacta).join("") : '<p class="empty">Cadastre seus hábitos na aba Rotina.</p>';
  const urgentes = proximasContas().filter(function (c) { return c.status !== "pago" && diasAte(c.data) <= 7; });
  $("hojeUrgentes").innerHTML = urgentes.length ? urgentes.slice(0, 8).map(itemConta).join("") : '<p class="empty">Nenhuma conta urgente. Boa.</p>';
  const todasC = gerarConquistas();
  const pendentes = todasC.filter(function (c) { return !c.desbloqueada && c.alvo > 0; }).sort(function (a, b) { return b.pct - a.pct; }).slice(0, 3);
  $("hojeProximosMarcos").innerHTML = pendentes.length
    ? pendentes.map(function (c) {
        return '<div class="item"><div><p class="item-title">' + escHtml(c.titulo) + '</p><p class="item-meta">' + escHtml(c.desc) + '</p><div class="progress" style="margin:8px 0 0"><div class="progress-bar" style="width:' + c.pct + '%"></div></div><p class="item-meta">' + c.atual + ' / ' + c.alvo + ' (' + c.pct + '%)</p></div></div>';
      }).join("")
    : '<p class="empty">Você já desbloqueou tudo o que dava por aqui.</p>';
}

/* ===========================================================
   Backup manual (export/import JSON)
   =========================================================== */
function montarBackupAtual() {
  return {
    contas: contas, metas: metas, comprasCartao: comprasCartao, cartao: cartao,
    salarioMes: salarioMes, ultimaAtualizacaoCartao: ultimaAtualizacaoCartao,
    salariosPorMes: salariosPorMes, faturasPorMes: faturasPorMes, valesPorMes: valesPorMes,
    habitos: habitos, registroHabitos: registroHabitos, conquistasDesbloqueadas: conquistasDesbloqueadas,
    dataBackup: new Date().toISOString()
  };
}
function aplicarBackup(dados) {
  if (!dados) return false;
  if (Array.isArray(dados.contas)) contas = dados.contas;
  if (Array.isArray(dados.metas)) metas = dados.metas;
  if (Array.isArray(dados.comprasCartao)) comprasCartao = dados.comprasCartao;
  if (dados.cartao && typeof dados.cartao === "object") cartao = dados.cartao;
  if (dados.salarioMes !== undefined) salarioMes = Number(dados.salarioMes || 0);
  if (dados.ultimaAtualizacaoCartao !== undefined) ultimaAtualizacaoCartao = dados.ultimaAtualizacaoCartao || "";
  if (dados.salariosPorMes && typeof dados.salariosPorMes === "object") salariosPorMes = dados.salariosPorMes;
  if (dados.faturasPorMes && typeof dados.faturasPorMes === "object") faturasPorMes = dados.faturasPorMes;
  if (dados.valesPorMes && typeof dados.valesPorMes === "object") valesPorMes = dados.valesPorMes;
  if (Array.isArray(dados.habitos)) habitos = dados.habitos;
  if (dados.registroHabitos && typeof dados.registroHabitos === "object") registroHabitos = dados.registroHabitos;
  if (dados.conquistasDesbloqueadas && typeof dados.conquistasDesbloqueadas === "object") conquistasDesbloqueadas = dados.conquistasDesbloqueadas;
  salvar(); iniciarCampos(); renderizar();
  return true;
}
function exportarBackupArquivo() {
  try {
    const dados = montarBackupAtual();
    const blob = new Blob([JSON.stringify(dados, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "backup-financas-" + hoje + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Backup exportado.", "success");
  } catch (e) {
    toast("Erro ao exportar backup.", "error"); console.warn(e);
  }
}
function mesclarBackup(dados) {
  if (!dados) return false;
  let novos = { contas: 0, metas: 0, compras: 0, habitos: 0, salarios: 0, faturas: 0, vales: 0, registros: 0, conquistas: 0 };

  function mergeArrayPorId(atual, vindos) {
    if (!Array.isArray(vindos)) return { lista: atual, novos: 0 };
    const ids = new Set(atual.map(function (i) { return String(i.id); }));
    let n = 0;
    vindos.forEach(function (item) {
      if (!item || !item.id) return;
      if (!ids.has(String(item.id))) { atual.push(item); n++; }
    });
    return { lista: atual, novos: n };
  }
  function mergeObjPreferAtual(atual, vindos) {
    if (!vindos || typeof vindos !== "object") return { obj: atual, novos: 0 };
    let n = 0;
    Object.keys(vindos).forEach(function (k) {
      if (atual[k] === undefined || atual[k] === null) { atual[k] = vindos[k]; n++; }
    });
    return { obj: atual, novos: n };
  }
  // Merge profundo do registroHabitos: nível 1 = data, nível 2 = id do hábito
  function mergeRegistroHabitos(atual, vindos) {
    if (!vindos || typeof vindos !== "object") return 0;
    let n = 0;
    Object.keys(vindos).forEach(function (data) {
      if (!atual[data]) { atual[data] = vindos[data]; n++; return; }
      Object.keys(vindos[data]).forEach(function (idH) {
        if (atual[data][idH] === undefined) { atual[data][idH] = vindos[data][idH]; n++; }
      });
    });
    return n;
  }
  function mergeValesPorMes(atual, vindos) {
    if (!vindos || typeof vindos !== "object") return 0;
    let n = 0;
    Object.keys(vindos).forEach(function (chaveMes) {
      if (!atual[chaveMes]) { atual[chaveMes] = vindos[chaveMes]; n++; return; }
      Object.keys(vindos[chaveMes]).forEach(function (tipo) {
        if (atual[chaveMes][tipo] === undefined) { atual[chaveMes][tipo] = vindos[chaveMes][tipo]; n++; }
      });
    });
    return n;
  }

  const r1 = mergeArrayPorId(contas, dados.contas); contas = r1.lista; novos.contas = r1.novos;
  const r2 = mergeArrayPorId(metas, dados.metas); metas = r2.lista; novos.metas = r2.novos;
  const r3 = mergeArrayPorId(comprasCartao, dados.comprasCartao); comprasCartao = r3.lista; novos.compras = r3.novos;
  const r4 = mergeArrayPorId(habitos, dados.habitos); habitos = r4.lista; novos.habitos = r4.novos;

  const r5 = mergeObjPreferAtual(salariosPorMes, dados.salariosPorMes); salariosPorMes = r5.obj; novos.salarios = r5.novos;
  const r6 = mergeObjPreferAtual(faturasPorMes, dados.faturasPorMes); faturasPorMes = r6.obj; novos.faturas = r6.novos;

  novos.vales = mergeValesPorMes(valesPorMes, dados.valesPorMes);
  novos.registros = mergeRegistroHabitos(registroHabitos, dados.registroHabitos);
  novos.conquistas = mergeObjPreferAtual(conquistasDesbloqueadas, dados.conquistasDesbloqueadas).novos;

  // Cartão e salarioMes: só preenche se atual está zerado
  if (dados.cartao && (!cartao || (cartao.fatura === 0 && Number(cartao.limite || 0) === 0))) cartao = dados.cartao;
  if ((!salarioMes || salarioMes === 0) && dados.salarioMes) salarioMes = Number(dados.salarioMes || 0);

  salvar(); iniciarCampos(); renderizar();
  const total = Object.values(novos).reduce(function (a, b) { return a + b; }, 0);
  toast("Mesclagem concluída: " + total + " itens novos adicionados.", "success");
  console.log("Mesclagem detalhada:", novos);
  return true;
}

function importarBackupArquivoComoMerge(evento) {
  const arquivo = evento.target.files && evento.target.files[0];
  if (!arquivo) return;
  const leitor = new FileReader();
  leitor.onload = function () {
    try {
      const dados = JSON.parse(leitor.result);
      if (!confirm("Mesclar este backup com as informações atuais?\nNada do que você tem cadastrado vai ser apagado — só serão adicionados itens novos do JSON.")) return;
      mesclarBackup(dados);
    } catch (e) {
      toast("Arquivo de backup inválido.", "error"); console.warn(e);
    } finally { evento.target.value = ""; }
  };
  leitor.readAsText(arquivo);
}

async function mesclarDoClipboard() {
  try {
    let txt = "";
    if (navigator.clipboard && navigator.clipboard.readText) txt = await navigator.clipboard.readText();
    if (!txt) txt = prompt("Cole o conteúdo do JSON aqui:") || "";
    txt = txt.trim();
    if (!txt) return;
    const dados = JSON.parse(txt);
    if (!confirm("Mesclar este JSON com as informações atuais?\nNada do que você tem cadastrado vai ser apagado.")) return;
    mesclarBackup(dados);
  } catch (e) {
    toast("JSON inválido ou clipboard vazio.", "error"); console.warn(e);
  }
}

function importarBackupArquivo(evento) {
  const arquivo = evento.target.files && evento.target.files[0];
  if (!arquivo) return;
  const leitor = new FileReader();
  leitor.onload = function () {
    try {
      const dados = JSON.parse(leitor.result);
      if (!confirm("Importar este backup e substituir as informações atuais?")) return;
      if (aplicarBackup(dados)) toast("Backup importado.", "success");
    } catch (e) {
      toast("Arquivo de backup inválido.", "error"); console.warn(e);
    } finally { evento.target.value = ""; }
  };
  leitor.readAsText(arquivo);
}
function restaurarExemplos() {
  if (!confirm("Restaurar dados de exemplo? Isso substitui o que está cadastrado.")) return;
  contas = exemplosContas(); metas = exemplosMetas(); comprasCartao = [];
  cartao = { nome: "Cartão principal", fatura: 0, vencimento: hoje, limite: 5000 };
  salarioMes = 0; salariosPorMes = {}; faturasPorMes = {}; valesPorMes = {};
  habitos = exemplosHabitos(); registroHabitos = {}; conquistasDesbloqueadas = {};
  salvar(); iniciarCampos(); renderizar();
}
function limparTudo() {
  if (!confirm("Tem certeza que deseja apagar TODOS os dados?")) return;
  contas = []; metas = []; comprasCartao = [];
  cartao = { nome: "Cartão principal", fatura: 0, vencimento: hoje, limite: 5000 };
  salarioMes = 0; salariosPorMes = {}; faturasPorMes = {}; valesPorMes = {};
  habitos = []; registroHabitos = {}; conquistasDesbloqueadas = {};
  salvar(); iniciarCampos(); renderizar();
}

/* ===========================================================
   Snapshots automáticos no IndexedDB (histórico até 30 versões)
   =========================================================== */
const SNAPSHOT_INTERVALO_HORAS = 6;   // cria novo snapshot se passou X horas do último
const SNAPSHOT_MAX = 30;              // mantém até N snapshots

function talvezCriarSnapshot() {
  const agora = new Date();
  let criar = false;
  if (!snapshots.length) {
    criar = true;
  } else {
    const ultimo = new Date(snapshots[snapshots.length - 1].data);
    const horas = (agora - ultimo) / 36e5;
    if (horas >= SNAPSHOT_INTERVALO_HORAS) criar = true;
  }
  if (!criar) return;
  snapshots.push({
    data: agora.toISOString(),
    dados: montarBackupAtual()
  });
  // poda
  while (snapshots.length > SNAPSHOT_MAX) snapshots.shift();
  dbSet("snapshots", snapshots).catch(function () {});
}
function listarSnapshots() {
  // mais recente em cima
  return snapshots.slice().reverse().map(function (s, i) {
    return Object.assign({}, s, { _idx: snapshots.length - 1 - i });
  });
}
function restaurarSnapshotIdx(idx) {
  const s = snapshots[idx];
  if (!s || !s.dados) return toast("Snapshot inválido.", "error");
  if (!confirm("Restaurar a versão de " + new Date(s.data).toLocaleString("pt-BR") + "?\nO estado atual será substituído.")) return;
  aplicarBackup(s.dados);
  toast("Versão restaurada.", "success");
}
function baixarSnapshotIdx(idx) {
  const s = snapshots[idx];
  if (!s) return;
  const blob = new Blob([JSON.stringify(s.dados, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "snapshot-" + s.data.slice(0, 19).replace(/[T:]/g, "-") + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function excluirSnapshotIdx(idx) {
  if (!snapshots[idx]) return;
  if (!confirm("Excluir esta versão?")) return;
  snapshots.splice(idx, 1);
  dbSet("snapshots", snapshots);
  renderizarSnapshots();
}
function renderizarSnapshots() {
  if (!$("listaSnapshots")) return;
  const lista = listarSnapshots();
  if (!lista.length) {
    $("listaSnapshots").innerHTML = '<p class="empty">Nenhuma versão guardada ainda. Conforme você usar o app, snapshots são salvos automaticamente a cada 6 horas.</p>';
    return;
  }
  $("listaSnapshots").innerHTML = lista.map(function (s) {
    const d = new Date(s.data);
    const dataStr = d.toLocaleString("pt-BR");
    const contas = (s.dados && Array.isArray(s.dados.contas)) ? s.dados.contas.length : 0;
    const habit = (s.dados && Array.isArray(s.dados.habitos)) ? s.dados.habitos.length : 0;
    return '<div class="item"><div><p class="item-title">' + escHtml(dataStr) + '</p>'
      + '<p class="item-meta"><span class="badge">' + contas + ' contas</span><span class="badge">' + habit + ' hábitos</span></p></div>'
      + '<div class="item-actions">'
      + '<button class="btn btn-small btn-green" onclick="restaurarSnapshotIdx(' + s._idx + ')">Restaurar</button>'
      + '<button class="btn btn-small btn-dark" onclick="baixarSnapshotIdx(' + s._idx + ')">Baixar</button>'
      + '<button class="btn btn-small btn-red" onclick="excluirSnapshotIdx(' + s._idx + ')">Excluir</button>'
      + '</div></div>';
  }).join("");
}

/* ===========================================================
   Colar JSON do clipboard
   =========================================================== */
async function colarJSON() {
  try {
    let txt = "";
    if (navigator.clipboard && navigator.clipboard.readText) {
      txt = await navigator.clipboard.readText();
    }
    if (!txt) {
      txt = prompt("Cole o conteúdo do JSON aqui:") || "";
    }
    txt = txt.trim();
    if (!txt) return;
    const dados = JSON.parse(txt);
    if (!confirm("Importar este JSON e substituir as informações atuais?")) return;
    if (aplicarBackup(dados)) toast("Dados importados.", "success");
  } catch (e) {
    toast("JSON inválido ou clipboard vazio.", "error");
    console.warn(e);
  }
}

/* ===========================================================
   Backup automático em pasta sincronizada (File System Access API)
   =========================================================== */
function fsaSuportado() { return typeof window.showDirectoryPicker === "function"; }
async function escolherPastaBackup() {
  if (!fsaSuportado()) {
    toast("Seu navegador não suporta escolher pasta. Use 'Exportar backup' manualmente.", "warn");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: "financas-backup", mode: "readwrite", startIn: "documents" });
    // Pede permissão de escrita
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") { toast("Permissão negada.", "warn"); return; }
    pastaBackupHandle = handle;
    await dbSet("_backup_pasta_handle", handle);
    toast("Pasta conectada: " + handle.name, "success");
    await gravarBackupAgora();
    renderizarStatusBackup();
  } catch (e) {
    if (e && e.name === "AbortError") return; // user cancelou
    toast("Não foi possível conectar a pasta.", "error"); console.warn(e);
  }
}
async function esquecerPastaBackup() {
  pastaBackupHandle = null;
  await dbSet("_backup_pasta_handle", null);
  toast("Pasta de backup desconectada.", "warn");
  renderizarStatusBackup();
}
async function gravarBackupAgora() {
  if (!pastaBackupHandle) {
    // Sem pasta — cai pro download manual
    exportarBackupArquivo();
    return;
  }
  try {
    const perm = await pastaBackupHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      const re = await pastaBackupHandle.requestPermission({ mode: "readwrite" });
      if (re !== "granted") { toast("Sem permissão pra escrever na pasta.", "warn"); return; }
    }
    const arquivoHandle = await pastaBackupHandle.getFileHandle("backup-financas.json", { create: true });
    const w = await arquivoHandle.createWritable();
    await w.write(JSON.stringify(montarBackupAtual(), null, 2));
    await w.close();
    ultimaGravacaoBackupStr = new Date().toISOString();
    await dbSet("ultimaGravacaoBackup", ultimaGravacaoBackupStr);
    renderizarStatusBackup();
  } catch (e) {
    toast("Falha ao gravar backup na pasta.", "error"); console.warn(e);
  }
}
let _autoBackupTimer = null;
function agendarBackupAutoSeConfigurado() {
  if (!pastaBackupHandle) return;
  if (_autoBackupTimer) clearTimeout(_autoBackupTimer);
  // Debounce: grava 5s após a última alteração
  _autoBackupTimer = setTimeout(function () {
    gravarBackupAgora();
  }, 5000);
}
function renderizarStatusBackup() {
  const txt = pastaBackupHandle ? pastaBackupHandle.name : "não configurada";
  if ($("statusPastaBackup")) $("statusPastaBackup").innerText = txt;
  if ($("statusPastaBackup2")) $("statusPastaBackup2").innerText = txt;
  if ($("ultimaGravacaoBackup")) {
    if (ultimaGravacaoBackupStr) {
      try {
        const d = new Date(ultimaGravacaoBackupStr);
        $("ultimaGravacaoBackup").innerText = d.toLocaleString("pt-BR");
      } catch (e) { $("ultimaGravacaoBackup").innerText = ultimaGravacaoBackupStr; }
    } else { $("ultimaGravacaoBackup").innerText = "—"; }
  }
  if ($("avisoFSCompat")) {
    $("avisoFSCompat").innerText = fsaSuportado()
      ? ""
      : "Aviso: este navegador não suporta a API de pastas. No iPhone (Safari), use 'Exportar backup' manualmente e guarde no Drive/Dropbox.";
  }
}

/* ===========================================================
   PWA: service worker + botão instalar
   =========================================================== */
function registrarSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function (e) {
      console.warn("Service worker não registrado:", e);
    });
  }
}
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = $("btnInstalarPWA"); if (btn) btn.classList.add("visible");
});
async function instalarPWA() {
  if (!deferredInstallPrompt) {
    toast("App não pode ser instalado agora (ou já está instalado).", "warn");
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === "accepted") toast("App instalado.", "success");
  deferredInstallPrompt = null;
  const btn = $("btnInstalarPWA"); if (btn) btn.classList.remove("visible");
}

/* ===========================================================
   Init
   =========================================================== */
function iniciarCampos() {
  if ($("salarioMes")) $("salarioMes").value = salarioMes || "";
  if ($("mesReferencia")) $("mesReferencia").value = chaveMesAtual();
  if ($("faturaMesReferencia")) $("faturaMesReferencia").value = chaveMesAtual();
  ["contaData", "parcelaData", "cartaoVencimento", "compraData", "metaPrazo", "abastData", "alimData"].forEach(function (x) { if ($(x)) $(x).value = hoje; });
  if ($("valesMesReferencia")) $("valesMesReferencia").value = chaveMesAtual();
  if ($("cartaoNome")) $("cartaoNome").value = cartao.nome || "Cartão principal";
  if ($("cartaoFatura")) $("cartaoFatura").value = cartao.fatura || 0;
  if ($("cartaoLimite")) $("cartaoLimite").value = cartao.limite || 0;
  limparFormularioHabito();
}

async function iniciar() {
  try {
    await openDB();
    // Migra dados do localStorage do app antigo, se houver
    await migrarLocalStorageSeNecessario();
    await carregarTudo();
    // Recupera handle da pasta de backup, se existir
    try {
      const handle = await dbGet("_backup_pasta_handle");
      if (handle) {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm === "granted" || perm === "prompt") pastaBackupHandle = handle;
      }
    } catch (e) { /* ignora */ }
    iniciarCampos();
    aplicarTemaSalvo();
    alternarCampoQuinzenasConta();
    alternarCampoQuinzenas();
    renderizar();
    renderizarStatusBackup();
    registrarSW();
  } catch (e) {
    console.error("Erro no init:", e);
    toast("Erro ao iniciar o app. Veja o console.", "error");
  }
}

window.addEventListener("DOMContentLoaded", iniciar);

/* Expor funções globais usadas em onclick */
window.openTab = openTab;
window.alternarTema = alternarTema;
window.salvarSalario = salvarSalario;
window.salvarContaFormulario = salvarContaFormulario;
window.limparFormularioConta = limparFormularioConta;
window.alternarCampoQuinzenasConta = alternarCampoQuinzenasConta;
window.alternarCampoQuinzenas = alternarCampoQuinzenas;
window.adicionarParcela = adicionarParcela;
window.salvarCartao = salvarCartao;
window.salvarCompraFormulario = salvarCompraFormulario;
window.limparFormularioCompra = limparFormularioCompra;
window.salvarMetaFormulario = salvarMetaFormulario;
window.limparFormularioMeta = limparFormularioMeta;
window.marcarPago = marcarPago;
window.excluirConta = excluirConta;
window.excluirCompra = excluirCompra;
window.excluirMeta = excluirMeta;
window.editarConta = editarConta;
window.editarCompra = editarCompra;
window.editarMeta = editarMeta;
window.salvarSalarioMesReferencia = salvarSalarioMesReferencia;
window.irParaMesAnterior = irParaMesAnterior;
window.irParaProximoMes = irParaProximoMes;
window.irParaMesAtual = irParaMesAtual;
window.imprimirRelatorioMes = imprimirRelatorioMes;
window.renderizarMesAMes = renderizarMesAMes;
window.salvarFaturaMes = salvarFaturaMes;
window.limparFaturaMesSelecionado = limparFaturaMesSelecionado;
window.preencherMesesAteDezembro = preencherMesesAteDezembro;
window.editarFaturaMes = editarFaturaMes;
window.excluirFaturaMes = excluirFaturaMes;
window.marcarCartaoAtualizado = marcarCartaoAtualizado;
window.salvarHabitoFormulario = salvarHabitoFormulario;
window.editarHabito = editarHabito;
window.excluirHabito = excluirHabito;
window.limparFormularioHabito = limparFormularioHabito;
window.registrarHabito = registrarHabito;
window.definirHabitoHoje = definirHabitoHoje;
window.escolherPastaBackup = escolherPastaBackup;
window.gravarBackupAgora = gravarBackupAgora;
window.esquecerPastaBackup = esquecerPastaBackup;
window.exportarBackupArquivo = exportarBackupArquivo;
window.importarBackupArquivo = importarBackupArquivo;
window.restaurarExemplos = restaurarExemplos;
window.limparTudo = limparTudo;
window.instalarPWA = instalarPWA;
window.renderizar = renderizar;
window.salvarValeGasolina = salvarValeGasolina;
window.salvarValeAlimentacao = salvarValeAlimentacao;
window.adicionarAbastecimento = adicionarAbastecimento;
window.adicionarAlimentacao = adicionarAlimentacao;
window.alterarMesVales = alterarMesVales;
window.irParaMesAtualVales = irParaMesAtualVales;
window.renderizarVales = renderizarVales;
window.restaurarSnapshotIdx = restaurarSnapshotIdx;
window.baixarSnapshotIdx = baixarSnapshotIdx;
window.excluirSnapshotIdx = excluirSnapshotIdx;
window.colarJSON = colarJSON;
window.alterarMesCalendario = alterarMesCalendario;
window.irParaMesAtualCalendario = irParaMesAtualCalendario;
window.selecionarDiaCalendario = selecionarDiaCalendario;
window.mesclarBackup = mesclarBackup;
window.importarBackupArquivoComoMerge = importarBackupArquivoComoMerge;
window.mesclarDoClipboard = mesclarDoClipboard;
