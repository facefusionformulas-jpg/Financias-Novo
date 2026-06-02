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
let usuario = { nome: "", senhaHash: "", senhaSalt: "", criadoEm: "" };
let seguranca = { bloqueioAtivo: false, biometriaCredId: null, setupPulado: false, notificacoesAtivas: false, diasAntesNotificar: 3 };
let contasSelecionadas = new Set(); // ids selecionados para ações em lote
let modoSelecao = false; // quando ativo, mostra checkboxes nos itens

const CATEGORIAS_PADRAO = [
  "Casa", "Veículo", "Combustível", "Alimentação", "Mercado",
  "Saúde", "Educação", "Lazer", "Vestuário", "Empréstimo",
  "Cartão", "Telecom", "Investimento", "Trabalho", "Imposto",
  "Doação", "Outros"
];

/**
 * Versão do schema de dados.
 * Bumpe quando alterar a forma como os dados são armazenados
 * (ex: novos campos obrigatórios, renomeações, mudança de tipo).
 * Adicione lógica de migração em `migrarSchema()`.
 */
const SCHEMA_VERSION = 2;

/**
 * Aplica migrações sequenciais até trazer os dados pra SCHEMA_VERSION atual.
 * Roda uma vez após `carregarTudo()`. Idempotente — pode rodar de novo sem dano.
 * @returns {Promise<boolean>} true se aplicou alguma migração
 */
async function migrarSchema() {
  let versao = 1;
  try {
    const v = await dbGet("_schema_version");
    if (typeof v === "number") versao = v;
  } catch (e) {}
  let aplicou = false;

  if (versao < 2) {
    // Migração 1→2: adiciona campo `adiada` em todas as contas (default false),
    // normaliza categorias e garante campos de seguranca novos.
    contas = contas.map(function (c) {
      const novo = Object.assign({}, c);
      if (novo.adiada === undefined) novo.adiada = false;
      if (novo.categoria) novo.categoria = normalizarCategoria(novo.categoria);
      return novo;
    });
    if (!seguranca.notificacoesAtivas) seguranca.notificacoesAtivas = false;
    if (!seguranca.diasAntesNotificar) seguranca.diasAntesNotificar = 3;
    aplicou = true;
  }

  // Próxima migração entraria aqui: if (versao < 3) { ... }

  if (aplicou) {
    salvar();
    console.log("[schema] Migrado para v" + SCHEMA_VERSION);
  }
  await dbSet("_schema_version", SCHEMA_VERSION);
  return aplicou;
}

let contaEditandoId = null;
let compraEditandoId = null;
let metaEditandoId = null;
let habitoEditandoId = null;

let deferredInstallPrompt = null;
let pastaBackupHandle = null;
let ultimaGravacaoBackupStr = "";

/* ===========================================================
   Captura visual de erros (banner vermelho fixo no topo)
   =========================================================== */
function mostrarErroVisual(msg) {
  try {
    let bar = document.getElementById("erroVisual");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "erroVisual";
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;padding:10px 14px;font-family:system-ui,sans-serif;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:10px;box-shadow:0 4px 12px rgba(0,0,0,0.4)";
      const span = document.createElement("span");
      span.id = "erroVisualMsg";
      bar.appendChild(span);
      const btn = document.createElement("button");
      btn.innerText = "Fechar";
      btn.style.cssText = "background:transparent;color:#fff;border:1px solid #fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0";
      btn.onclick = function () { bar.remove(); };
      bar.appendChild(btn);
      document.body.appendChild(bar);
    }
    document.getElementById("erroVisualMsg").innerText = "⚠ " + msg;
  } catch (_) { /* nada */ }
}
window.addEventListener("error", function (e) {
  if (e && e.message) mostrarErroVisual("JS: " + e.message + " @ " + (e.filename || "?") + ":" + (e.lineno || "?"));
});
window.addEventListener("unhandledrejection", function (e) {
  const m = e && e.reason && (e.reason.message || e.reason.toString()) || "promise rejection";
  mostrarErroVisual("Promise: " + m);
});

/* ===========================================================
   Helpers genéricos
   =========================================================== */
/** Atalho pra getElementById. @param {string} id @returns {HTMLElement|null} */
function $(id) { return document.getElementById(id); }
/** Gera ID único compacto (~13 chars). @returns {string} */
function idNovo() { return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2); }
/** Escapa HTML pra prevenir XSS em strings injetadas em innerHTML. @param {*} s @returns {string} */
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
  });
}
/** Formata número como R$ pt-BR. @param {number|string} v @returns {string} */
function dinheiro(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
/** Converte ISO date (AAAA-MM-DD) pra DD/MM/AAAA. @param {string} d @returns {string} */
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
  usuario = (data.usuario && typeof data.usuario === "object") ? data.usuario : { nome: "", senhaHash: "", senhaSalt: "", criadoEm: "" };
  seguranca = (data.seguranca && typeof data.seguranca === "object") ? data.seguranca : { bloqueioAtivo: false, biometriaCredId: null, setupPulado: false };
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
      habitos, registroHabitos, conquistasDesbloqueadas,
      usuario, seguranca
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
// Mapa: aba principal → lista de sub-tabs
const SUB_TABS = {
  financas: [
    { id: "contas",         label: "A pagar",  countId: "badgeApagar" },
    { id: "contasadiadas",  label: "Adiadas",  countId: "badgeAdiadas" },
    { id: "contaspagas",    label: "Pagas",    countId: "badgePagas"  },
    { id: "cartao",         label: "Cartão" },
    { id: "vales",          label: "Vales"  }
  ],
  metas: [
    { id: "metas-lista", label: "Metas" },
    { id: "conquistas",  label: "Conquistas" }
  ],
  analise: [
    { id: "graficos", label: "Gráficos" },
    { id: "mesames",  label: "Mês a mês" },
    { id: "ia",       label: "Plano IA"  }
  ]
};

function openTab(id, btn) {
  // Esconde todas as sections
  document.querySelectorAll(".tab").forEach(function (t) { t.classList.add("hidden"); });

  // Atualiza sidebar
  document.querySelectorAll(".sidebar-nav .sidebar-item").forEach(function (b) { b.classList.remove("active"); });
  if (btn) btn.classList.add("active");
  if (window.innerWidth <= 900) fecharSidebar();

  // Atualiza título mobile
  const titulo = btn ? (btn.querySelector("span") ? btn.querySelector("span").innerText : "Painel") : "Painel";
  const mt = document.querySelector(".mobile-title");
  if (mt) mt.innerText = titulo;

  // Aba com sub-tabs?
  if (SUB_TABS[id]) {
    renderSubTabsBar(id, SUB_TABS[id]);
    openInner(SUB_TABS[id][0].id);
  } else {
    const bar = $("subTabsBar");
    if (bar) bar.classList.add("hidden");
    if ($(id)) $(id).classList.remove("hidden");
  }

  renderizar();
}

function renderSubTabsBar(parentId, subs) {
  const bar = $("subTabsBar");
  if (!bar) return;
  bar.innerHTML = subs.map(function (s) {
    return '<button class="sub-tab-btn" data-target="' + s.id + '" onclick="openInner(\'' + s.id + '\', this)">'
      + '<span>' + escHtml(s.label) + '</span>'
      + (s.countId ? '<span class="badge-count" id="' + s.countId + '">0</span>' : '')
      + '</button>';
  }).join("");
  bar.classList.remove("hidden");
}

function openInner(id, btn) {
  // Esconde só sections .tab
  document.querySelectorAll(".tab").forEach(function (t) { t.classList.add("hidden"); });
  if ($(id)) $(id).classList.remove("hidden");
  // Marca sub-tab ativa
  document.querySelectorAll("#subTabsBar .sub-tab-btn").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-target") === id);
  });
  renderizar();
}

function openTabPorId(tab) {
  // Aceita IDs de sub-tabs também
  for (const parent in SUB_TABS) {
    if (SUB_TABS[parent].some(function (s) { return s.id === tab; })) {
      // É uma sub-tab; abre a principal primeiro
      const btnPrincipal = Array.from(document.querySelectorAll(".sidebar-nav .sidebar-item")).find(function (x) {
        const oc = x.getAttribute("onclick") || ""; return oc.indexOf("'" + parent + "'") !== -1;
      });
      openTab(parent, btnPrincipal);
      openInner(tab);
      return;
    }
  }
  const b = Array.from(document.querySelectorAll(".sidebar-nav .sidebar-item")).find(function (x) {
    const oc = x.getAttribute("onclick") || ""; return oc.indexOf("'" + tab + "'") !== -1;
  });
  openTab(tab, b);
}
function toggleSidebar() {
  $("sidebar").classList.toggle("open");
  $("sidebarOverlay").classList.toggle("visible");
}
function fecharSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebarOverlay").classList.remove("visible");
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
   Autenticação (setup inicial, senha, biometria/WebAuthn)
   =========================================================== */
async function sha256Hex(texto) {
  const data = new TextEncoder().encode(texto);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
function gerarSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
async function hashSenha(senha, salt) {
  return sha256Hex(senha + ":" + salt);
}

function setupNecessario() {
  return !usuario.criadoEm && !seguranca.setupPulado;
}
function bloqueioPrecisaSerMostrado() {
  return !!(seguranca.bloqueioAtivo && usuario.senhaHash);
}

// Sessão ativa: sessionStorage (dura enquanto aba existe) + localStorage (manter sempre conectado)
function sessaoAtiva() {
  try {
    if (sessionStorage.getItem("financas_sessao") === "ativa") return true;
    const persist = localStorage.getItem("financas_manter_conectado");
    if (persist) {
      // Aceita "sim" (formato novo) ou JSON antigo com `ate`
      if (persist === "sim") {
        sessionStorage.setItem("financas_sessao", "ativa");
        return true;
      }
      try {
        const dados = JSON.parse(persist);
        if (dados && dados.ate && new Date(dados.ate) > new Date()) {
          sessionStorage.setItem("financas_sessao", "ativa");
          // Migra pro formato novo (sempre conectado)
          localStorage.setItem("financas_manter_conectado", "sim");
          return true;
        }
      } catch (_) { /* não é JSON */ }
      localStorage.removeItem("financas_manter_conectado");
    }
  } catch (e) {}
  return false;
}
function marcarSessaoAtiva(manterConectado) {
  try {
    sessionStorage.setItem("financas_sessao", "ativa");
    if (manterConectado) {
      localStorage.setItem("financas_manter_conectado", "sim");
    } else {
      localStorage.removeItem("financas_manter_conectado");
    }
  } catch (e) {}
}
function encerrarSessao() {
  try {
    sessionStorage.removeItem("financas_sessao");
    localStorage.removeItem("financas_manter_conectado");
  } catch (e) {}
}
/* ===========================================================
   Notificações nativas (push local) de vencimento
   =========================================================== */
function notificacoesSuportadas() {
  return "Notification" in window;
}
async function pedirPermissaoNotificacoes() {
  if (!notificacoesSuportadas()) {
    toast("Notificações não suportadas neste navegador.", "warn");
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    toast("Notificações foram bloqueadas. Ative nas configurações do navegador.", "warn");
    return false;
  }
  const r = await Notification.requestPermission();
  return r === "granted";
}
async function alternarNotificacoes() {
  const checked = $("confNotificacoes").checked;
  if (checked) {
    const ok = await pedirPermissaoNotificacoes();
    if (!ok) { $("confNotificacoes").checked = false; return; }
    seguranca.notificacoesAtivas = true;
    salvar();
    toast("Notificações ativadas. Você será avisado dos vencimentos.", "success");
    setTimeout(verificarENotificar, 500);
  } else {
    seguranca.notificacoesAtivas = false;
    salvar();
    toast("Notificações desativadas.", "warn");
  }
}
function salvarDiasAntes() {
  const d = Number($("confDiasAntes").value || 3);
  seguranca.diasAntesNotificar = d;
  salvar();
}
/**
 * Detecta se a página está rodando como PWA instalada (standalone).
 * Importante: nesse modo, `new Notification()` lança "Illegal constructor".
 * @returns {boolean}
 */
function isPWAInstalada() {
  try {
    if (window.matchMedia && (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches
    )) return true;
    if (window.navigator.standalone) return true; // iOS Safari instalado
  } catch (e) {}
  return false;
}

/**
 * Dispara notificação preferindo Service Worker. Funciona em PWA standalone
 * (onde `new Notification()` é proibido) e em aba normal.
 * @param {string} titulo
 * @param {NotificationOptions} opts
 * @returns {Promise<boolean>}
 */
async function dispararNotificacao(titulo, opts) {
  if (!notificacoesSuportadas()) {
    toast("Notificações não suportadas neste navegador.", "error");
    return false;
  }
  if (Notification.permission !== "granted") {
    toast("Permissão de notificações não concedida.", "warn");
    return false;
  }
  opts = opts || {};

  // 1) Service Worker (universal — funciona em standalone E em browser)
  if ("serviceWorker" in navigator) {
    try {
      // Timeout de 4s pra serviceWorker.ready não pendurar
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error("SW ready timeout")); }, 4000); })
      ]);
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(titulo, opts);
        return true;
      }
      console.warn("[notif] SW pronto mas sem showNotification");
    } catch (e) {
      console.warn("[notif] SW falhou:", e);
      // continua pro fallback ↓
    }
  }

  // 2) Em PWA standalone, `new Notification()` é PROIBIDO — não tenta
  if (isPWAInstalada()) {
    toast("Service Worker não respondeu. Feche e abra o app de novo.", "error", 5000);
    return false;
  }

  // 3) Fallback construtor (só em aba normal)
  try {
    new Notification(titulo, opts);
    return true;
  } catch (e) {
    toast("Erro: " + (e && e.message || e), "error", 5000);
    return false;
  }
}

async function testarNotificacao() {
  const ok = await pedirPermissaoNotificacoes();
  if (!ok) return;
  const sucesso = await dispararNotificacao("Teste de notificação", {
    body: "Funcionou. Você será avisado dos vencimentos automaticamente.",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: "financas-teste"
  });
  if (sucesso) toast("Notificação enviada.", "success");
  else toast("Não foi possível enviar. Verifique permissões.", "error");
}
async function verificarENotificar() {
  if (!seguranca.notificacoesAtivas) return;
  if (!notificacoesSuportadas() || Notification.permission !== "granted") return;
  const dias = Number(seguranca.diasAntesNotificar || 3);
  const urgentes = todasContas().filter(function (c) {
    return c.status !== "pago" && !c.adiada && diasAte(c.data) >= 0 && diasAte(c.data) <= dias;
  });
  const vencidas = todasContas().filter(function (c) {
    return c.status !== "pago" && !c.adiada && diasAte(c.data) < 0;
  });
  // Só notifica 1 vez por dia
  const chave = "notif_disparada_" + hoje;
  try {
    if (localStorage.getItem(chave) === "1") return;
  } catch (e) {}
  let disparou = false;
  if (vencidas.length) {
    const total = vencidas.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
    const ok = await dispararNotificacao(vencidas.length + " conta(s) vencida(s)", {
      body: "Total atrasado: " + dinheiro(total),
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "financas-vencidas",
      renotify: true
    });
    if (ok) disparou = true;
  }
  if (urgentes.length) {
    const total = urgentes.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
    const ok = await dispararNotificacao("Contas vencendo em até " + dias + " dia" + (dias === 1 ? "" : "s"), {
      body: urgentes.length + " conta(s) · " + dinheiro(total),
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "financas-urgentes",
      renotify: true
    });
    if (ok) disparou = true;
  }
  if (disparou) {
    try { localStorage.setItem(chave, "1"); } catch (e) {}
  }
}

function bloquearAgora() {
  if (!usuario.senhaHash) { toast("Defina uma senha antes nas configurações.", "warn"); return; }
  encerrarSessao();
  fecharConfig();
  verificarBloqueioAoAbrir(true);
}

function mostrarOverlay(id) {
  const el = $(id); if (el) el.classList.remove("hidden");
}
function esconderOverlay(id) {
  const el = $(id); if (el) el.classList.add("hidden");
}

async function salvarSetupInicial() {
  const nome = $("setupNome").value.trim();
  const senha = $("setupSenha").value;
  if (!nome) return toast("Digite seu nome.", "warn");
  usuario.nome = nome;
  usuario.criadoEm = new Date().toISOString();
  if (senha) {
    usuario.senhaSalt = gerarSalt();
    usuario.senhaHash = await hashSenha(senha, usuario.senhaSalt);
  }
  await dbSet("usuario", usuario);
  await dbSet("seguranca", seguranca);
  esconderOverlay("setupOverlay");
  toast("Bem-vindo, " + nome + "!", "success");
  atualizarNomeSidebar();
  renderizar();
}
function pularSetupInicial() {
  seguranca.setupPulado = true;
  dbSet("seguranca", seguranca);
  esconderOverlay("setupOverlay");
}

async function tentarDesbloquearComSenha() {
  const senha = $("bloqueioSenha").value;
  if (!senha) return;
  const hash = await hashSenha(senha, usuario.senhaSalt);
  if (hash === usuario.senhaHash) {
    const manter = $("manterConectado") ? !!$("manterConectado").checked : true;
    marcarSessaoAtiva(manter);
    $("bloqueioSenha").value = "";
    $("bloqueioErro").innerText = "";
    esconderOverlay("bloqueioOverlay");
    toast("Desbloqueado.", "success");
  } else {
    $("bloqueioErro").innerText = "Senha incorreta.";
    $("bloqueioSenha").select();
  }
}

function verificarBloqueioAoAbrir(forcar) {
  if (!bloqueioPrecisaSerMostrado()) return;
  if (!forcar && sessaoAtiva()) return; // já desbloqueado nesta sessão / dispositivo lembrado
  $("bloqueioSaudacao").innerText = usuario.nome ? "Olá, " + usuario.nome : "Bloqueado";
  mostrarOverlay("bloqueioOverlay");
  if (seguranca.biometriaCredId) {
    $("btnBioDesbloquear").classList.remove("hidden");
    setTimeout(function () { desbloquearComBiometria(true); }, 300);
  } else {
    $("btnBioDesbloquear").classList.add("hidden");
  }
  setTimeout(function () { if ($("bloqueioSenha")) $("bloqueioSenha").focus(); }, 100);
}

// WebAuthn — biometria/PIN do dispositivo
function biometriaSuportada() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}
async function registrarBiometria() {
  if (!biometriaSuportada()) throw new Error("Biometria não suportada neste navegador.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = new TextEncoder().encode((usuario.nome || "usuario") + ":" + (usuario.criadoEm || ""));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: challenge,
      rp: { name: "Finanças & Rotina" },
      user: {
        id: userId,
        name: usuario.nome || "usuario",
        displayName: usuario.nome || "Usuário"
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000,
      attestation: "none"
    }
  });
  if (!credential) throw new Error("Sem credencial retornada.");
  seguranca.biometriaCredId = Array.from(new Uint8Array(credential.rawId));
  await dbSet("seguranca", seguranca);
  return true;
}
async function desbloquearComBiometria(automatico) {
  if (!seguranca.biometriaCredId || !biometriaSuportada()) {
    if (!automatico) toast("Biometria não disponível.", "warn");
    return false;
  }
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credIdArray = new Uint8Array(seguranca.biometriaCredId);
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        allowCredentials: [{ type: "public-key", id: credIdArray }],
        userVerification: "required",
        timeout: 60000
      }
    });
    if (assertion) {
      const manter = $("manterConectado") ? !!$("manterConectado").checked : true;
      marcarSessaoAtiva(manter);
      $("bloqueioSenha").value = "";
      $("bloqueioErro").innerText = "";
      esconderOverlay("bloqueioOverlay");
      toast("Desbloqueado.", "success");
      return true;
    }
  } catch (e) {
    if (!automatico) toast("Biometria falhou. Use a senha.", "warn");
    console.warn("WebAuthn falhou:", e);
  }
  return false;
}

// Configurações de segurança no modal
function atualizarNomeSidebar() {
  const el = $("sidebarUserName");
  if (el) el.innerText = usuario.nome || "pessoal";
}
function popularConfigSeguranca() {
  if ($("confNome")) $("confNome").value = usuario.nome || "";
  atualizarNomeSidebar();
  if ($("confBloqueioAtivo")) $("confBloqueioAtivo").checked = !!seguranca.bloqueioAtivo;
  if ($("confBiometriaAtiva")) $("confBiometriaAtiva").checked = !!seguranca.biometriaCredId;
  if ($("avisoBiometria")) {
    if (!biometriaSuportada()) {
      $("avisoBiometria").innerText = "Biometria não suportada neste navegador. Disponível em Chrome/Edge Android e iOS Safari modernos.";
    } else if (seguranca.biometriaCredId) {
      $("avisoBiometria").innerText = "Biometria registrada neste dispositivo.";
    } else {
      $("avisoBiometria").innerText = "";
    }
  }
  atualizarVisibilidadeBotaoBackupInicial();
  atualizarVisibilidadeBotaoCorrecoes();
  // Notificações
  if ($("confNotificacoes")) {
    $("confNotificacoes").checked = !!seguranca.notificacoesAtivas && notificacoesSuportadas() && Notification.permission === "granted";
  }
  if ($("confDiasAntes")) $("confDiasAntes").value = String(seguranca.diasAntesNotificar || 3);
  if ($("avisoNotificacoes")) {
    if (!notificacoesSuportadas()) {
      $("avisoNotificacoes").innerText = "Notificações não suportadas neste navegador.";
    } else if (Notification.permission === "denied") {
      $("avisoNotificacoes").innerText = "Permissão negada. Ative manualmente nas configurações do navegador.";
    } else if (seguranca.notificacoesAtivas) {
      $("avisoNotificacoes").innerText = "Ativo. Você é avisado uma vez por dia quando houver vencimentos.";
    } else {
      $("avisoNotificacoes").innerText = "";
    }
  }
}
function salvarNomeConfig() {
  const novo = $("confNome").value.trim();
  if (!novo) return toast("Nome não pode ficar vazio.", "warn");
  usuario.nome = novo;
  if (!usuario.criadoEm) usuario.criadoEm = new Date().toISOString();
  salvar();
  toast("Nome atualizado.", "success");
}
async function salvarSenhaConfig() {
  const nova = $("confSenhaNova").value;
  const confirma = $("confSenhaConfirma").value;
  if (nova !== confirma) return toast("As senhas não conferem.", "warn");
  if (!nova) {
    if (!confirm("Remover a senha do app? O bloqueio e a biometria serão desativados.")) return;
    usuario.senhaHash = ""; usuario.senhaSalt = "";
    seguranca.bloqueioAtivo = false; seguranca.biometriaCredId = null;
    $("confSenhaNova").value = ""; $("confSenhaConfirma").value = "";
    salvar(); popularConfigSeguranca();
    toast("Senha removida.", "warn");
    return;
  }
  usuario.senhaSalt = gerarSalt();
  usuario.senhaHash = await hashSenha(nova, usuario.senhaSalt);
  if (!usuario.criadoEm) usuario.criadoEm = new Date().toISOString();
  $("confSenhaNova").value = ""; $("confSenhaConfirma").value = "";
  salvar();
  toast("Senha atualizada.", "success");
}
function alternarBloqueioAtivo() {
  const novo = $("confBloqueioAtivo").checked;
  if (novo && !usuario.senhaHash) {
    $("confBloqueioAtivo").checked = false;
    return toast("Defina uma senha primeiro.", "warn");
  }
  seguranca.bloqueioAtivo = novo;
  salvar();
  toast(novo ? "Bloqueio ativado." : "Bloqueio desativado.", "success");
}
async function alternarBiometriaAtiva() {
  const novo = $("confBiometriaAtiva").checked;
  if (novo) {
    if (!biometriaSuportada()) {
      $("confBiometriaAtiva").checked = false;
      return toast("Biometria não suportada.", "error");
    }
    if (!usuario.senhaHash) {
      $("confBiometriaAtiva").checked = false;
      return toast("Defina uma senha primeiro.", "warn");
    }
    try {
      await registrarBiometria();
      popularConfigSeguranca();
      toast("Biometria ativada.", "success");
    } catch (e) {
      $("confBiometriaAtiva").checked = false;
      console.warn(e);
      toast("Não foi possível ativar a biometria. " + (e && e.message || ""), "error");
    }
  } else {
    seguranca.biometriaCredId = null;
    salvar(); popularConfigSeguranca();
    toast("Biometria desativada.", "warn");
  }
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
  const categoria = normalizarCategoria($("contaCategoria").value || "Outros");
  const freq = $("contaFrequencia").value;
  const quantas = freq === "unica" ? 1 : Math.max(1, Number($("contaQuantas").value || 1));
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data.", "warn");

  if (freq === "unica") {
    contas.push({
      id: idNovo(), nome: nome, valor: valor, data: data,
      tipo: "avulso", categoria: categoria, status: "pendente", origem: "manual"
    });
  } else {
    // Parcelas mensais ou quinzenais
    const grupo = idNovo();
    const passoFn = freq === "mensal" ? function (i) { return adicionarMeses(data, i); }
                                       : function (i) { return adicionarDias(data, i * 15); };
    const tipoConta = freq === "mensal" ? "mensal recorrente" : "quinzenal";
    for (let i = 0; i < quantas; i++) {
      contas.push({
        id: idNovo(),
        nome: quantas === 1 ? nome : nome + " (" + (i + 1) + "/" + quantas + ")",
        valor: valor,
        data: passoFn(i),
        tipo: tipoConta,
        categoria: categoria,
        status: "pendente",
        origem: quantas > 1 ? "recorrencia" : "manual",
        recorrencia: quantas > 1 ? { grupo: grupo, parcelaAtual: i + 1, totalParcelas: quantas, frequencia: freq } : undefined
      });
    }
  }
  limparFormularioConta(); salvar(); renderizar();
  toast(quantas > 1 ? quantas + " parcelas adicionadas." : "Conta adicionada.", "success");
}
function atualizarConta() {
  const nome = $("contaNome").value.trim();
  const valor = Number($("contaValor").value);
  const data = $("contaData").value;
  const categoria = normalizarCategoria($("contaCategoria").value || "Outros");
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data.", "warn");
  // Edição só altera campos básicos — tipo/recorrência ficam intactos
  contas = contas.map(function (i) {
    return String(i.id) === String(contaEditandoId)
      ? Object.assign({}, i, { nome: nome, valor: valor, data: data, categoria: categoria })
      : i;
  });
  limparFormularioConta(); salvar(); renderizar();
  toast("Conta atualizada.", "success");
}
function atualizarCampoQuantasConta() {
  const freq = $("contaFrequencia") ? $("contaFrequencia").value : "unica";
  const qInput = $("contaQuantas");
  if (!qInput) return;
  if (freq === "unica") {
    qInput.classList.add("hidden");
    qInput.value = "";
  } else {
    qInput.classList.remove("hidden");
    if (!qInput.value) qInput.value = "1";
  }
}
function limparFormularioConta() {
  contaEditandoId = null;
  if ($("contaNome")) $("contaNome").value = "";
  if ($("contaValor")) $("contaValor").value = "";
  if ($("contaData")) $("contaData").value = hoje;
  if ($("contaCategoria")) $("contaCategoria").value = "Casa";
  if ($("contaFrequencia")) $("contaFrequencia").value = "unica";
  if ($("contaQuantas")) $("contaQuantas").value = "";
  atualizarCampoQuantasConta();
  if ($("btnConta")) $("btnConta").innerText = "Adicionar";
  if ($("btnCancelarConta")) $("btnCancelarConta").classList.add("hidden");
}
// Mantida pra compat com chamadas antigas
function alternarCampoQuinzenasConta() { atualizarCampoQuantasConta(); }

function adicionarParcela() {
  const nome = $("parcelaNome").value.trim(),
    valor = Number($("parcelaValor").value),
    total = $("parcelaTotal").value,
    atual = $("parcelaAtual").value,
    data = $("parcelaData").value,
    frequencia = $("parcelaFrequencia").value,
    categoria = normalizarCategoria($("parcelaCategoria").value || "Parcelas"),
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
    data = $("compraData").value, categoria = normalizarCategoria($("compraCategoria").value || "Cartão");
  if (!nome || !valor || !data) return toast("Preencha nome, valor e data da compra.", "warn");
  comprasCartao.push({ id: idNovo(), nome: nome, valor: valor, data: data, categoria: categoria });
  limparFormularioCompra(); salvar(); renderizar();
}
function atualizarCompra() {
  const nome = $("compraNome").value.trim(), valor = Number($("compraValor").value),
    data = $("compraData").value, categoria = normalizarCategoria($("compraCategoria").value || "Cartão");
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
function adicionarValorMeta(idMeta) {
  const m = metas.find(function (x) { return String(x.id) === String(idMeta); });
  if (!m) return;
  const faltam = Number(m.alvo || 0) - Number(m.guardado || 0);
  const dica = faltam > 0 ? " (falta " + dinheiro(faltam) + ")" : "";
  const v = prompt(
    "Quanto guardar a mais em \"" + m.nome + "\"?" + dica + "\n\nUse vírgula ou ponto. Pode usar negativo pra retirar.",
    "0"
  );
  if (v === null || v.trim() === "") return;
  const num = Number(String(v).replace(",", ".").trim());
  if (!isFinite(num) || num === 0) { if (num === 0) return; return toast("Valor inválido.", "warn"); }
  m.guardado = Math.max(0, Number(m.guardado || 0) + num);
  salvar(); renderizar();
  const sinal = num >= 0 ? "+" : "";
  toast(sinal + dinheiro(num) + " em " + m.nome, "success");
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
    return String(c.id) === String(idv) ? Object.assign({}, c, { status: c.status === "pago" ? "pendente" : "pago", adiada: false }) : c;
  });
  salvar(); renderizar();
}
function alternarAdiada(idv) {
  if (idv === "fatura-cartao") return toast("A fatura do cartão é gerada automaticamente.", "warn");
  contas = contas.map(function (c) {
    return String(c.id) === String(idv) ? Object.assign({}, c, { adiada: !c.adiada }) : c;
  });
  salvar(); renderizar();
  toast("Conta movida.", "success");
}
/* ===========================================================
   Categorias padronizadas
   =========================================================== */
/**
 * Normaliza nome de categoria: trim + title case com preservação de stopwords.
 * Garante que "MOTO", "moto", "Moto" sejam todos "Moto" (anti-duplicata).
 * @param {string} cat
 * @returns {string}
 * @example normalizarCategoria("CARRO de luxo") // "Carro de Luxo"
 */
function normalizarCategoria(cat) {
  if (!cat) return "Outros";
  const stop = new Set(["de", "do", "da", "dos", "das", "e"]);
  return String(cat).trim().toLowerCase().split(/\s+/).map(function (w, i) {
    if (i > 0 && stop.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
function popularDatalistCategorias() {
  const dl = $("categoriasList");
  if (!dl) return;
  const usadas = Array.from(new Set(contas.map(function (c) { return normalizarCategoria(c.categoria); }))).filter(Boolean);
  const todas = Array.from(new Set([].concat(CATEGORIAS_PADRAO, usadas))).sort(function (a, b) {
    return a.localeCompare(b, "pt-BR");
  });
  dl.innerHTML = todas.map(function (c) { return '<option value="' + escHtml(c) + '"></option>'; }).join("");
}

/* ===========================================================
   Duplicar grupo de recorrência
   =========================================================== */
function duplicarGrupoRecorrencia(grupoId, nomeRef) {
  if (!grupoId) return;
  const parcelas = contas.filter(function (c) { return c.recorrencia && c.recorrencia.grupo === grupoId; });
  if (!parcelas.length) return toast("Grupo não encontrado.", "warn");
  parcelas.sort(function (a, b) { return new Date(a.data) - new Date(b.data); });
  const ultima = parcelas[parcelas.length - 1];
  const sugestao = adicionarMeses(ultima.data, 1);
  const dataInicio = prompt(
    "Duplicar \"" + (nomeRef || "este grupo") + "\" (" + parcelas.length + " parcelas).\n\nData de início da nova série (AAAA-MM-DD):",
    sugestao
  );
  if (!dataInicio || !/^\d{4}-\d{2}-\d{2}$/.test(dataInicio)) {
    if (dataInicio !== null) toast("Data inválida. Use AAAA-MM-DD.", "warn");
    return;
  }
  const novoGrupo = idNovo();
  const freq = (ultima.recorrencia && ultima.recorrencia.frequencia) || "mensal";
  const total = parcelas.length;
  const nomeBase = (nomeRef || ultima.nome).replace(/\s*\(\d+\/\d+\)\s*$/, "").trim();
  for (let i = 0; i < total; i++) {
    const data = freq === "quinzenal" ? adicionarDias(dataInicio, i * 15) : adicionarMeses(dataInicio, i);
    contas.push({
      id: idNovo(),
      nome: nomeBase + " (" + (i + 1) + "/" + total + ")",
      valor: ultima.valor,
      data: data,
      tipo: freq === "quinzenal" ? "quinzenal" : "mensal recorrente",
      categoria: normalizarCategoria(ultima.categoria),
      status: "pendente",
      origem: "recorrencia",
      recorrencia: { grupo: novoGrupo, parcelaAtual: i + 1, totalParcelas: total, frequencia: freq }
    });
  }
  salvar(); renderizar();
  toast(total + " parcelas duplicadas começando " + dataBR(dataInicio), "success", 4000);
}

/* ===========================================================
   Seleção em lote (marcar pagas, adiar, excluir)
   =========================================================== */
function toggleSelecaoConta(id) {
  if (contasSelecionadas.has(id)) contasSelecionadas.delete(id);
  else contasSelecionadas.add(id);
  atualizarBarraSelecao();
  // Atualiza só o item visualmente (sem re-render completo)
  const items = document.querySelectorAll('.item-check[data-id="' + id + '"]');
  items.forEach(function (el) {
    const item = el.closest(".item");
    if (item) item.classList.toggle("selecionada", contasSelecionadas.has(id));
  });
}
function atualizarBarraSelecao() {
  const barra = $("barraSelecao");
  if (!barra) return;
  const n = contasSelecionadas.size;
  if (n === 0) {
    barra.classList.add("hidden");
  } else {
    barra.classList.remove("hidden");
    $("selCount").innerText = n + " selecionada" + (n === 1 ? "" : "s");
  }
}
function limparSelecao() {
  contasSelecionadas.clear();
  atualizarBarraSelecao();
  renderizar();
}
function alternarModoSelecao() {
  modoSelecao = !modoSelecao;
  if (!modoSelecao) contasSelecionadas.clear();
  atualizarBotaoModoSelecao();
  atualizarBarraSelecao();
  renderizar();
}
function atualizarBotaoModoSelecao() {
  const btn = $("btnModoSelecao");
  if (!btn) return;
  if (modoSelecao) {
    btn.innerText = "Cancelar seleção";
    btn.classList.remove("btn-dark");
    btn.classList.add("btn");
  } else {
    btn.innerText = "Selecionar várias";
    btn.classList.add("btn-dark");
    btn.classList.remove("btn");
  }
}
function marcarSelecionadasPagas() {
  if (!contasSelecionadas.size) return;
  const ids = new Set(contasSelecionadas);
  contas = contas.map(function (c) {
    return ids.has(c.id) ? Object.assign({}, c, { status: "pago", adiada: false }) : c;
  });
  const n = ids.size;
  contasSelecionadas.clear();
  salvar(); renderizar();
  toast(n + " conta(s) marcada(s) como pagas.", "success");
}
function adiarSelecionadas() {
  if (!contasSelecionadas.size) return;
  const ids = new Set(contasSelecionadas);
  contas = contas.map(function (c) {
    return (ids.has(c.id) && c.status !== "pago") ? Object.assign({}, c, { adiada: true }) : c;
  });
  const n = ids.size;
  contasSelecionadas.clear();
  salvar(); renderizar();
  toast(n + " conta(s) adiada(s).", "success");
}
function excluirSelecionadas() {
  if (!contasSelecionadas.size) return;
  const n = contasSelecionadas.size;
  if (!confirm("Excluir " + n + " conta(s)? Não tem volta.")) return;
  const ids = new Set(contasSelecionadas);
  contas = contas.filter(function (c) { return !ids.has(c.id); });
  contasSelecionadas.clear();
  salvar(); renderizar();
  toast(n + " conta(s) excluída(s).", "warn");
}

function excluirGrupoRecorrencia(grupoId, nomeRef) {
  if (!grupoId) return;
  const matches = contas.filter(function (c) { return c.recorrencia && c.recorrencia.grupo === grupoId; });
  if (!matches.length) return toast("Grupo não encontrado.", "warn");
  const total = matches.length;
  const valorTotal = matches.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
  const pagas = matches.filter(function (c) { return c.status === "pago"; }).length;
  let msg = "Apagar TODAS as " + total + " parcelas de \"" + (nomeRef || "este grupo") + "\"";
  if (pagas) msg += "\n(" + pagas + " já estão marcadas como pagas)";
  msg += "?\nTotal: " + valorTotal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  msg += "\n\nEssa ação não tem volta — só dá pra recuperar restaurando um snapshot.";
  if (!confirm(msg)) return;
  contas = contas.filter(function (c) { return !(c.recorrencia && c.recorrencia.grupo === grupoId); });
  salvar(); renderizar();
  toast(total + " parcelas removidas.", "warn", 4000);
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
  $("contaNome").value = c.nome;
  $("contaValor").value = c.valor;
  $("contaData").value = c.data;
  $("contaCategoria").value = c.categoria || "Outros";
  // Em edição, mostra como pagamento único (edita só essa parcela)
  if ($("contaFrequencia")) $("contaFrequencia").value = "unica";
  if ($("contaQuantas")) $("contaQuantas").value = "";
  atualizarCampoQuantasConta();
  $("btnConta").innerText = "Salvar edição";
  $("btnCancelarConta").classList.remove("hidden");
  openTabPorId("contas");
  window.scrollTo({ top: 0, behavior: "smooth" });
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

function renderizarContasAdiadas() {
  if (!$("listaContasAdiadas")) return;
  const adiadas = contas.filter(function (c) { return c.adiada && c.status !== "pago"; })
    .sort(function (a, b) { return new Date(a.data) - new Date(b.data); });
  if (!adiadas.length) {
    $("listaContasAdiadas").innerHTML = '<p class="empty">Nenhuma conta adiada. Quando você não conseguir pagar uma conta agora, toca em "Adiar" na lista — ela aparece aqui pra você não esquecer.</p>';
  } else {
    const total = adiadas.reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
    $("listaContasAdiadas").innerHTML =
      '<div class="grupo-contas">'
      + '<div class="grupo-header"><span class="grupo-titulo metric-red">' + adiadas.length + ' conta(s) adiada(s)</span><span class="grupo-total">' + dinheiro(total) + '</span></div>'
      + '<div class="list">' + adiadas.map(itemConta).join("") + '</div>'
      + '</div>';
  }
  if ($("badgeAdiadas")) $("badgeAdiadas").innerText = adiadas.length;
}

function renderizarContasPagas() {
  if (!$("listaContasPagas")) return;
  const pagas = contas.filter(function (c) { return c.status === "pago"; })
    .sort(function (a, b) { return new Date(b.data) - new Date(a.data); });
  // Popula select de meses (uma vez)
  const sel = $("filtroMesPagas");
  if (sel && sel.options.length <= 1) {
    const meses = Array.from(new Set(pagas.map(function (c) { return chaveMesDaData(c.data); }))).sort().reverse();
    meses.forEach(function (m) {
      const opt = document.createElement("option");
      opt.value = m; opt.innerText = nomeMes(m);
      sel.appendChild(opt);
    });
  }
  const busca = ($("buscaPagas") ? ($("buscaPagas").value || "") : "").toLowerCase();
  const filtroMes = $("filtroMesPagas") ? $("filtroMesPagas").value || "todos" : "todos";
  const filtradas = pagas.filter(function (c) {
    const matchBusca = c.nome.toLowerCase().includes(busca) || (c.categoria || "").toLowerCase().includes(busca);
    const matchMes = filtroMes === "todos" || chaveMesDaData(c.data) === filtroMes;
    return matchBusca && matchMes;
  });
  if (!filtradas.length) {
    $("listaContasPagas").innerHTML = '<p class="empty">Nenhuma conta paga ainda.</p>';
  } else {
    // Agrupa por mês
    const porMes = {};
    filtradas.forEach(function (c) {
      const m = chaveMesDaData(c.data);
      if (!porMes[m]) porMes[m] = [];
      porMes[m].push(c);
    });
    let html = "";
    Object.keys(porMes).sort().reverse().forEach(function (m) {
      const total = porMes[m].reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
      html += '<div class="grupo-contas">'
            + '<div class="grupo-header"><span class="grupo-titulo">' + nomeMes(m) + ' · ' + porMes[m].length + '</span><span class="grupo-total metric-green">' + dinheiro(total) + '</span></div>'
            + '<div class="list">' + porMes[m].map(itemConta).join("") + '</div>'
            + '</div>';
    });
    $("listaContasPagas").innerHTML = html;
  }
  if ($("badgePagas")) $("badgePagas").innerText = pagas.length;
}

function itemConta(c) {
  const classe = c.status === "pago" ? "paid" : "";
  const label = c.adiada ? "Adiada" : urgencia(c);
  let bc = "";
  if (label === "Adiada") bc = "badge-yellow";
  else if (label.indexOf("Vencida") === 0) bc = "badge-red";
  else if (label === "Vence hoje" || label === "Vence amanhã" || (label.indexOf("Vence em") === 0 && diasAte(c.data) <= 7)) bc = "badge-yellow";
  else if (label === "Pago") bc = "badge-green";
  const podeAdiar = c.status !== "pago" && c.id !== "fatura-cartao";
  const btnAdiar = podeAdiar
    ? '<button class="btn btn-small btn-dark" onclick="alternarAdiada(\'' + c.id + '\')" title="' + (c.adiada ? "Voltar pra A pagar" : "Adiar pra lembrar depois") + '">' + (c.adiada ? "Reativar" : "Adiar") + '</button>'
    : '';
  const temGrupo = c.recorrencia && c.recorrencia.grupo;
  const nomeBase = c.nome.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim();
  const btnDup = temGrupo
    ? '<button class="btn btn-small btn-dark" onclick="duplicarGrupoRecorrencia(\'' + c.recorrencia.grupo + '\', \'' + nomeBase.replace(/'/g, "\\'") + '\')" title="Duplicar grupo de recorrência inteiro">Duplicar grupo</button>'
    : '';
  const btnGrupo = temGrupo
    ? '<button class="btn btn-small btn-red" onclick="excluirGrupoRecorrencia(\'' + c.recorrencia.grupo + '\', \'' + nomeBase.replace(/'/g, "\\'") + '\')" title="Apagar TODAS as parcelas deste grupo">Apagar grupo</button>'
    : '';
  const isFatura = c.id === "fatura-cartao";
  const selecionada = contasSelecionadas.has(c.id);
  const checkbox = (modoSelecao && !isFatura)
    ? '<input type="checkbox" class="item-check" data-id="' + c.id + '" ' + (selecionada ? "checked" : "") + ' onchange="toggleSelecaoConta(\'' + c.id + '\')" onclick="event.stopPropagation()" aria-label="Selecionar conta">'
    : '';
  // Em modo seleção, esconde os botões individuais (ficam as ações em lote)
  const acoesIndividuais = modoSelecao
    ? ''
    : '<button class="btn btn-small btn-dark" onclick="marcarPago(\'' + c.id + '\')">' + (c.status === "pago" ? "Reabrir" : "Pagar") + '</button>'
      + btnAdiar
      + '<button class="btn btn-small btn-dark" onclick="editarConta(\'' + c.id + '\')">Editar</button>'
      + '<button class="btn btn-small btn-red" onclick="excluirConta(\'' + c.id + '\')">Excluir</button>'
      + btnDup
      + btnGrupo;
  return '<div class="item' + (selecionada ? ' selecionada' : '') + '">'
       + '<div class="item-left">' + checkbox
       + '<div><p class="item-title ' + classe + '">' + escHtml(c.nome) + '</p>'
       + '<p class="item-meta"><span class="badge">' + escHtml(c.tipo) + '</span><span class="badge">' + escHtml(c.categoria) + '</span><span class="badge ' + bc + '">' + escHtml(label) + '</span></p>'
       + '<p class="item-meta">Vencimento: ' + dataBR(c.data) + '</p></div>'
       + '</div>'
       + '<div class="item-actions"><span class="amount">' + dinheiro(c.valor) + '</span>'
       + acoesIndividuais
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
  try { return renderizarInterno(); }
  catch (e) {
    console.error("Erro em renderizar():", e);
    mostrarErroVisual("Falha ao renderizar: " + (e && e.message || e));
    throw e;
  }
}
function renderizarInterno() {
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
    const busca = ($("buscaConta") ? ($("buscaConta").value || "") : "").toLowerCase();
    const fc = $("filtroCategoria") ? ($("filtroCategoria").value || "todos") : "todos";
    // Popula categorias únicas no dropdown (uma vez)
    const selCat = $("filtroCategoria");
    if (selCat) {
      const cats = Array.from(new Set(contas.map(function (c) { return (c.categoria || "Geral").trim(); }).filter(Boolean))).sort();
      const valorAtual = selCat.value;
      if (selCat.options.length - 1 !== cats.length) {
        // limpa e repopula
        while (selCat.options.length > 1) selCat.remove(1);
        cats.forEach(function (cat) {
          const opt = document.createElement("option");
          opt.value = cat; opt.innerText = cat;
          selCat.appendChild(opt);
        });
        if (valorAtual && Array.from(selCat.options).some(function(o){return o.value === valorAtual;})) {
          selCat.value = valorAtual;
        }
      }
    }
    // Aba "A pagar" mostra só pendentes NÃO adiadas, agrupado por urgência
    const pendentes = lista.filter(function (c) {
      const matchBusca = c.nome.toLowerCase().includes(busca) || (c.categoria || "").toLowerCase().includes(busca);
      const matchCat = fc === "todos" || (c.categoria || "Geral").trim() === fc;
      return c.status !== "pago" && !c.adiada && matchBusca && matchCat;
    }).sort(function (a, b) { return new Date(a.data) - new Date(b.data); });
    const grupos = { vencidas: [], hoje: [], semana: [], mes: [], futuras: [] };
    pendentes.forEach(function (c) {
      const d = diasAte(c.data);
      if (d < 0) grupos.vencidas.push(c);
      else if (d === 0) grupos.hoje.push(c);
      else if (d <= 7) grupos.semana.push(c);
      else if (mesmoMesAtual(c.data)) grupos.mes.push(c);
      else grupos.futuras.push(c);
    });
    const titulos = { vencidas: "Vencidas", hoje: "Vence hoje", semana: "Próximos 7 dias", mes: "Ainda este mês", futuras: "Meses seguintes" };
    const classesT = { vencidas: "metric-red", hoje: "metric-red", semana: "", mes: "", futuras: "" };
    let html = "";
    ["vencidas", "hoje", "semana", "mes", "futuras"].forEach(function (g) {
      if (grupos[g].length) {
        const total = grupos[g].reduce(function (s, c) { return s + Number(c.valor || 0); }, 0);
        html += '<div class="grupo-contas">'
              + '<div class="grupo-header"><span class="grupo-titulo ' + classesT[g] + '">' + titulos[g] + ' · ' + grupos[g].length + '</span><span class="grupo-total">' + dinheiro(total) + '</span></div>'
              + '<div class="list">' + grupos[g].map(itemConta).join("") + '</div>'
              + '</div>';
      }
    });
    $("listaContas").innerHTML = html || '<p class="empty">Nenhuma conta pendente. Tudo em dia.</p>';
    if ($("badgeApagar")) $("badgeApagar").innerText = pendentes.length;
  }

  renderizarContasAdiadas();
  renderizarContasPagas();

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
           + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
           + '<button class="btn btn-small btn-green" onclick="adicionarValorMeta(\'' + m.id + '\')" title="Adicionar (ou retirar) valor guardado sem editar">+ R$ Guardar</button>'
           + '<button class="btn btn-small btn-dark" onclick="editarMeta(\'' + m.id + '\')">Editar</button>'
           + '<button class="btn btn-small btn-red" onclick="excluirMeta(\'' + m.id + '\')">Excluir</button>'
           + '</div></div>';
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

  // IA Anti-Sufoco agora é função separada e inteligente
  if ($("analiseIA")) renderizarIA();

  safeCall(renderizarRotina, "renderizarRotina");
  safeCall(renderizarConquistas, "renderizarConquistas");
  safeCall(renderizarHoje, "renderizarHoje");
  safeCall(renderizarVales, "renderizarVales");
  safeCall(renderizarMesAMes, "renderizarMesAMes");
  safeCall(renderizarStatusBackup, "renderizarStatusBackup");
  safeCall(renderizarSnapshots, "renderizarSnapshots");
  safeCall(renderizarCalendario, "renderizarCalendario");
  safeCall(renderizarGraficos, "renderizarGraficos");
  safeCall(popularDatalistCategorias, "popularDatalistCategorias");
  safeCall(atualizarBarraSelecao, "atualizarBarraSelecao");
  safeCall(atualizarBotaoModoSelecao, "atualizarBotaoModoSelecao");
}
function safeCall(fn, label) {
  try { fn(); }
  catch (e) {
    console.error("Erro em " + label + ":", e);
    mostrarErroVisual(label + ": " + (e && e.message || e));
  }
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
/* ===========================================================
   IA Anti-Sufoco (inteligente, com ações)
   =========================================================== */
function gerarPlanoIA() {
  const chave = chaveMesAtual();
  const s = helperSaldoMes(chave);
  const pctComp = s.salario > 0 ? (s.total / s.salario * 100) : 0;
  const alertas = [];
  const padroes = [];
  const sugestoes = [];

  // 1. Alertas críticos
  const vencidas = todasContas().filter(function (c) { return c.status !== "pago" && !c.adiada && diasAte(c.data) < 0; });
  if (vencidas.length) {
    const totalVenc = vencidas.reduce(function (sum, c) { return sum + Number(c.valor || 0); }, 0);
    alertas.push({
      tipo: "critico",
      titulo: vencidas.length + " conta(s) vencida(s)",
      desc: "Total atrasado: " + dinheiro(totalVenc) + ". Pague ou adie pra organizar.",
      acaoLabel: "Ver A pagar",
      acaoClick: "openTabPorId('contas')"
    });
  }
  if (s.salario > 0 && s.saldo < 0) {
    alertas.push({
      tipo: "critico",
      titulo: "Saldo previsto negativo este mês",
      desc: "Você vai gastar " + dinheiro(Math.abs(s.saldo)) + " a mais que o salário. Considere adiar contas não-essenciais.",
      acaoLabel: "Ver A pagar",
      acaoClick: "openTabPorId('contas')"
    });
  }
  if (pctComp >= 90 && pctComp < 100) {
    alertas.push({
      tipo: "aviso",
      titulo: pctComp.toFixed(0) + "% do salário comprometido",
      desc: "Folga muito pequena. Qualquer despesa extra desequilibra o mês."
    });
  }
  const urgentes7 = proximasContas().filter(function (c) { return c.status !== "pago" && !c.adiada && diasAte(c.data) <= 7 && diasAte(c.data) >= 0; });
  if (urgentes7.length && !vencidas.length) {
    const totalUrg = urgentes7.reduce(function (sum, c) { return sum + Number(c.valor || 0); }, 0);
    alertas.push({
      tipo: "aviso",
      titulo: urgentes7.length + " conta(s) vencem em até 7 dias",
      desc: "Total: " + dinheiro(totalUrg) + ". Programe os pagamentos.",
      acaoLabel: "Ver A pagar",
      acaoClick: "openTabPorId('contas')"
    });
  }

  // 2. Padrões: compromissos pesados (grupos > 20% renda)
  if (s.salario > 0) {
    const grupos = {};
    contas.forEach(function (c) {
      if (!c.recorrencia || !c.recorrencia.grupo) return;
      const g = c.recorrencia.grupo;
      if (!grupos[g]) {
        grupos[g] = {
          nome: c.nome.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim(),
          parcelaValor: c.valor,
          pendentes: 0,
          total: c.recorrencia.totalParcelas || 0
        };
      }
      if (c.status !== "pago") grupos[g].pendentes++;
    });
    Object.values(grupos).filter(function (g) { return g.pendentes > 0; }).forEach(function (g) {
      const pct = g.parcelaValor / s.salario * 100;
      if (pct >= 20) {
        padroes.push({
          nome: g.nome,
          pct: pct,
          parcelaValor: g.parcelaValor,
          pendentes: g.pendentes,
          msg: g.nome + " consome " + pct.toFixed(0) + "% do salário (" + dinheiro(g.parcelaValor) + "/mês, " + g.pendentes + " parcelas restantes)",
          sugestao: pct >= 40
            ? "Peso muito alto. Considere refinanciamento ou renegociação."
            : pct >= 30
            ? "Peso significativo. Avalie se vale antecipar pra quitar antes."
            : "Peso moderado. Fique de olho pra não esticar mais."
        });
      }
    });
    padroes.sort(function (a, b) { return b.pct - a.pct; });
  }

  // 3. Sugestões positivas / ações
  if (s.salario > 0 && s.saldo > 0) {
    sugestoes.push({
      tipo: "positivo",
      titulo: "Sobra de " + dinheiro(s.saldo) + " este mês",
      desc: "Destine parte pra meta ou reserva — antes que vire compra impulsiva.",
      acaoLabel: "Ir pras Metas",
      acaoClick: "openTabPorId('metas-lista')"
    });
  }
  if (habitos.length) {
    const cumpridos = habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length;
    if (cumpridos === habitos.length) {
      sugestoes.push({
        tipo: "positivo",
        titulo: "Dia perfeito de rotina",
        desc: "Você bateu todas as metas hoje. Mantém o ritmo."
      });
    } else if (cumpridos > 0) {
      sugestoes.push({
        tipo: "info",
        titulo: "Faltam " + (habitos.length - cumpridos) + " hábito(s) pra fechar o dia",
        desc: "Cada pequena ação conta. Comece pelo mais fácil.",
        acaoLabel: "Ir pra Rotina",
        acaoClick: "openTabPorId('rotina')"
      });
    }
  }
  const chaveCart = chaveMesAtual();
  const vgRec = valeDoMes(chaveCart, "gasolina");
  const vaRec = valeDoMes(chaveCart, "alimentacao");
  if (vgRec || vaRec) {
    const vgSaldo = vgRec - gastoCategoriaDoMes(chaveCart, "Combustível");
    const vaSaldo = vaRec - gastoCategoriaDoMes(chaveCart, "Alimentação");
    if (vgSaldo < 0 || vaSaldo < 0) {
      sugestoes.push({
        tipo: "info",
        titulo: "Vale estourou",
        desc: (vgSaldo < 0 ? "VG: " + dinheiro(Math.abs(vgSaldo)) + " além do recebido. " : "") + (vaSaldo < 0 ? "VA: " + dinheiro(Math.abs(vaSaldo)) + " além do recebido." : ""),
        acaoLabel: "Ver Vales",
        acaoClick: "openTabPorId('vales')"
      });
    }
  }

  // 4. Projeção até dezembro
  const mesAtualNum = new Date(hoje + "T00:00:00").getMonth();
  const mesesAteFim = 12 - mesAtualNum - 1;
  let projecao = null;
  if (s.salario > 0 && mesesAteFim > 0) {
    let saldoAcum = 0;
    let mesesPos = 0;
    const detalhes = [];
    for (let i = 1; i <= mesesAteFim; i++) {
      const d = new Date(hoje + "T00:00:00");
      d.setMonth(d.getMonth() + i);
      const ch = d.toISOString().slice(0, 7);
      const sm = helperSaldoMes(ch);
      saldoAcum += sm.saldo;
      if (sm.saldo >= 0) mesesPos++;
      detalhes.push({ chave: ch, saldo: sm.saldo });
    }
    projecao = { mesesAteFim: mesesAteFim, saldoAcum: saldoAcum, mesesPos: mesesPos, detalhes: detalhes };
  }

  return { resumo: s, pctComp: pctComp, alertas: alertas, padroes: padroes, sugestoes: sugestoes, projecao: projecao };
}

function renderizarIA() {
  if (!$("analiseIA")) return;
  const p = gerarPlanoIA();

  // === Painel "Análise do mês" ===
  let html = '<div style="display:flex;flex-direction:column;gap:14px">';
  // Resumo em 3 colunas (com break-word pra não estourar em telas estreitas)
  html += '<div class="ia-resumo-grid">';
  html += '<div class="ia-resumo-cell"><p class="metric-title">Salário</p><p class="ia-resumo-valor">' + dinheiro(p.resumo.salario) + '</p></div>';
  html += '<div class="ia-resumo-cell"><p class="metric-title">Gasto previsto</p><p class="ia-resumo-valor">' + dinheiro(p.resumo.total) + '</p></div>';
  html += '<div class="ia-resumo-cell"><p class="metric-title">Saldo</p><p class="ia-resumo-valor ' + (p.resumo.saldo >= 0 ? 'metric-green' : 'metric-red') + '">' + dinheiro(p.resumo.saldo) + '</p></div>';
  html += '</div>';

  // Alertas
  if (p.alertas.length) {
    html += '<div><h4 style="font-size:13px;text-transform:uppercase;color:var(--muted);letter-spacing:0.05em;margin-bottom:8px">Alertas</h4>';
    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    p.alertas.forEach(function (a) {
      const cor = a.tipo === "critico" ? "var(--red)" : "var(--yellow)";
      const bg = a.tipo === "critico" ? "var(--red-soft-bg)" : "var(--yellow-soft-bg)";
      html += '<div style="border-left:3px solid ' + cor + ';background:' + bg + ';border-radius:6px;padding:10px 12px">';
      html += '<strong style="color:var(--text)">' + escHtml(a.titulo) + '</strong>';
      html += '<div style="font-size:12px;color:var(--muted);margin-top:3px">' + escHtml(a.desc) + '</div>';
      if (a.acaoLabel) {
        html += '<button class="btn btn-small btn-dark" style="margin-top:8px" onclick="' + a.acaoClick + '">' + escHtml(a.acaoLabel) + '</button>';
      }
      html += '</div>';
    });
    html += '</div></div>';
  } else {
    html += '<div style="padding:10px 12px;background:var(--green-soft-bg);border-left:3px solid var(--green);border-radius:6px;font-size:13px"><strong style="color:var(--green)">Sem alertas críticos.</strong> Tudo sob controle por agora.</div>';
  }

  // Padrões pesados
  if (p.padroes.length) {
    html += '<div><h4 style="font-size:13px;text-transform:uppercase;color:var(--muted);letter-spacing:0.05em;margin-bottom:8px">Compromissos pesados</h4>';
    html += '<div style="display:flex;flex-direction:column;gap:6px">';
    p.padroes.forEach(function (pad) {
      html += '<div style="padding:8px 10px;background:var(--card2);border-radius:6px;font-size:12px">';
      html += '<div style="color:var(--text)"><strong>' + escHtml(pad.nome) + '</strong> · ' + pad.pct.toFixed(0) + '% da renda</div>';
      html += '<div style="color:var(--muted);margin-top:2px">' + escHtml(pad.sugestao) + '</div>';
      html += '<div class="progress" style="margin-top:6px;height:4px"><div class="progress-bar" style="width:' + Math.min(100, pad.pct) + '%;background:' + (pad.pct >= 40 ? 'var(--red)' : pad.pct >= 30 ? 'var(--yellow)' : 'var(--primary)') + '"></div></div>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  html += '</div>';
  $("analiseIA").innerHTML = html;

  // === Painel "Plano sugerido" ===
  let plano = '<div style="display:flex;flex-direction:column;gap:12px">';

  // Sugestões
  if (p.sugestoes.length) {
    plano += '<div><h4 style="font-size:13px;text-transform:uppercase;color:var(--muted);letter-spacing:0.05em;margin-bottom:8px">Sugestões</h4>';
    plano += '<div style="display:flex;flex-direction:column;gap:6px">';
    p.sugestoes.forEach(function (s) {
      const cor = s.tipo === "positivo" ? "var(--green)" : "var(--primary)";
      const bg = s.tipo === "positivo" ? "var(--green-soft-bg)" : "var(--card2)";
      plano += '<div style="padding:10px 12px;background:' + bg + ';border-left:3px solid ' + cor + ';border-radius:6px;font-size:13px">';
      plano += '<strong>' + escHtml(s.titulo) + '</strong>';
      plano += '<div style="color:var(--muted);font-size:12px;margin-top:3px">' + escHtml(s.desc) + '</div>';
      if (s.acaoLabel) {
        plano += '<button class="btn btn-small btn-dark" style="margin-top:6px" onclick="' + s.acaoClick + '">' + escHtml(s.acaoLabel) + '</button>';
      }
      plano += '</div>';
    });
    plano += '</div></div>';
  }

  // Projeção
  if (p.projecao) {
    plano += '<div><h4 style="font-size:13px;text-transform:uppercase;color:var(--muted);letter-spacing:0.05em;margin-bottom:8px">Projeção até dezembro</h4>';
    plano += '<div style="padding:12px;background:var(--card2);border-radius:8px">';
    plano += '<div style="font-size:13px">Saldo acumulado nos próximos <strong>' + p.projecao.mesesAteFim + ' meses</strong>:</div>';
    plano += '<div class="' + (p.projecao.saldoAcum >= 0 ? "metric-green" : "metric-red") + '" style="font-family:JetBrains Mono,monospace;font-size:22px;font-weight:700;margin-top:6px">' + dinheiro(p.projecao.saldoAcum) + '</div>';
    plano += '<div style="font-size:12px;color:var(--muted);margin-top:4px"><strong>' + p.projecao.mesesPos + '</strong> de ' + p.projecao.mesesAteFim + ' meses devem ficar positivos.</div>';
    plano += '</div></div>';
  }

  // Top 3 prioridades agora
  plano += '<div><h4 style="font-size:13px;text-transform:uppercase;color:var(--muted);letter-spacing:0.05em;margin-bottom:8px">Foco da semana</h4>';
  const prioridades = [];
  if (p.alertas.find(function (a) { return a.titulo.indexOf("vencida") >= 0; })) prioridades.push("Pagar ou adiar contas vencidas");
  if (p.resumo.saldo < 0) prioridades.push("Revisar gastos pra fechar o mês no zero");
  if (p.padroes.length) prioridades.push("Avaliar " + p.padroes[0].nome + " (maior peso na renda)");
  if (habitos.length && habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length < habitos.length) prioridades.push("Fechar a rotina do dia");
  if (p.resumo.saldo > 0) prioridades.push("Guardar parte da sobra pra meta/reserva");
  if (!prioridades.length) prioridades.push("Cadastrar mais dados pro app sugerir ações melhores");
  plano += '<ol style="margin:0 0 0 18px;line-height:1.7;font-size:13px;color:var(--text)">';
  prioridades.slice(0, 4).forEach(function (pr) { plano += '<li>' + escHtml(pr) + '</li>'; });
  plano += '</ol></div>';

  plano += '</div>';
  $("planoIA").innerHTML = plano;
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
  const maxDots = (window.innerWidth <= 650) ? 3 : 6;
  const dots = cs.slice(0, maxDots).map(function (c) {
    let classe = "gray";
    if (c.status === "pago") classe = "green";
    else {
      const d = diasAte(c.data);
      if (d < 0) classe = "red";
      else if (d <= 7) classe = "yellow";
    }
    return '<span class="cal-dot ' + classe + '" title="' + escHtml(c.nome) + ' — ' + dinheiro(c.valor) + '"></span>';
  }).join("");
  const sobra = cs.length > maxDots ? '<span class="cal-more">+' + (cs.length - maxDots) + '</span>' : '';

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
   Gráficos (pizza, linha, barras) — SVG puro, sem dependência
   =========================================================== */
const CORES_CHART = [
  "#6366f1", "#06b6d4", "#22c55e", "#f59e0b", "#ec4899",
  "#8b5cf6", "#10b981", "#f97316", "#3b82f6", "#a855f7",
  "#14b8a6", "#ef4444", "#eab308", "#84cc16", "#0ea5e9"
];
function corCategoria(idx) { return CORES_CHART[idx % CORES_CHART.length]; }

function gastosPorCategoriaDoMes(chave) {
  // Soma TODAS as contas (pagas e pendentes) do mês por categoria
  const out = {};
  todasContas().forEach(function (c) {
    if (chaveMesDaData(c.data) !== chave) return;
    const cat = (c.categoria || "Sem categoria").trim();
    out[cat] = (out[cat] || 0) + Number(c.valor || 0);
  });
  // Adiciona faturas manuais como categoria "Cartão fatura"
  if (faturaDoMes(chave) > 0) {
    const cat = "Cartão fatura";
    out[cat] = (out[cat] || 0) + faturaDoMes(chave);
  }
  return out;
}

function saldoHistoricoMensal(n) {
  // Retorna últimos n meses, do mais antigo ao mais recente
  const arr = [];
  const d = new Date(hoje + "T00:00:00");
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const ref = new Date(d);
    ref.setMonth(ref.getMonth() - i);
    const chave = ref.toISOString().slice(0, 7);
    const s = helperSaldoMes(chave);
    arr.push({ chave: chave, mes: nomeMes(chave).split(" ")[0], salario: s.salario, total: s.total, saldo: s.saldo });
  }
  return arr;
}

function renderizarPizza(gastos) {
  const wrap = $("chartPizza");
  if (!wrap) return;
  const entries = Object.entries(gastos).sort(function (a, b) { return b[1] - a[1]; });
  const total = entries.reduce(function (s, e) { return s + e[1]; }, 0);
  if (total <= 0) {
    wrap.innerHTML = '<p class="empty" style="text-align:center;padding:60px 0">Sem gastos este mês.</p>';
    $("legendaPizza").innerHTML = "";
    $("totalCategorias").innerText = "R$ 0,00";
    return;
  }
  $("totalCategorias").innerText = dinheiro(total);
  const r = 40, cx = 50, cy = 50, sw = 16;
  const C = 2 * Math.PI * r;
  let offset = 0;
  let segments = "";
  entries.forEach(function (e, i) {
    const pct = e[1] / total;
    const len = pct * C;
    segments += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + corCategoria(i) + '" stroke-width="' + sw + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '"></circle>';
    offset += len;
  });
  wrap.innerHTML =
    '<svg viewBox="0 0 100 100">'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--progress-bg)" stroke-width="' + sw + '"></circle>'
    + segments
    + '</svg>'
    + '<div class="chart-pizza-center">'
    + '<div class="total">' + dinheiro(total) + '</div>'
    + '<div class="label">' + entries.length + ' categorias</div>'
    + '</div>';
  // Legenda
  $("legendaPizza").innerHTML = entries.map(function (e, i) {
    const pct = (e[1] / total * 100).toFixed(1);
    return '<div class="chart-legenda-item">'
      + '<div class="left"><span class="dot-cat" style="background:' + corCategoria(i) + '"></span><span class="nome">' + escHtml(e[0]) + '</span></div>'
      + '<span class="valor">' + dinheiro(e[1]) + ' · ' + pct + '%</span>'
      + '</div>';
  }).join("");
}

function renderizarBarras(gastos) {
  const wrap = $("chartBarras");
  if (!wrap) return;
  const entries = Object.entries(gastos).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
  if (!entries.length) { wrap.innerHTML = '<p class="empty">Sem gastos este mês.</p>'; return; }
  const max = entries[0][1];
  wrap.innerHTML = entries.map(function (e, i) {
    const pct = (e[1] / max * 100).toFixed(1);
    return '<div class="barra-item">'
      + '<div class="barra-label"><span class="nome">' + escHtml(e[0]) + '</span><span class="valor">' + dinheiro(e[1]) + '</span></div>'
      + '<div class="barra-trilho"><div class="barra-fg" style="width:' + pct + '%;background:' + corCategoria(i) + '"></div></div>'
      + '</div>';
  }).join("");
}

function renderizarLinha(historico) {
  const wrap = $("chartLinha");
  if (!wrap) return;
  if (!historico.length) { wrap.innerHTML = '<p class="empty">Sem histórico.</p>'; return; }
  const W = 600, H = 200, padL = 50, padR = 14, padT = 14, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const saldos = historico.map(function (h) { return h.saldo; });
  const minS = Math.min.apply(null, saldos.concat([0]));
  const maxS = Math.max.apply(null, saldos.concat([0]));
  const range = (maxS - minS) || 1;
  const stepX = historico.length > 1 ? innerW / (historico.length - 1) : innerW / 2;
  function xAt(i) { return padL + i * stepX; }
  function yAt(v) { return padT + innerH - ((v - minS) / range) * innerH; }
  const y0 = yAt(0);

  // Eixo Y: 4 linhas de grid
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const v = minS + (range * i / 4);
    const y = yAt(v);
    grid += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" class="linha-grid"/>';
    grid += '<text x="' + (padL - 8) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="var(--muted2)" font-family="JetBrains Mono">' + dinheiro(v).replace("R$ ", "") + '</text>';
  }
  // Linha y=0
  grid += '<line x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '" class="linha-eixo"/>';

  // Polyline
  const pontos = historico.map(function (h, i) { return xAt(i) + "," + yAt(h.saldo); }).join(" ");
  // Polygon pra área
  const areaPontos = pontos + " " + xAt(historico.length - 1) + "," + y0 + " " + xAt(0) + "," + y0;

  // Pontos + labels
  let pontosSVG = "";
  historico.forEach(function (h, i) {
    const x = xAt(i), y = yAt(h.saldo);
    pontosSVG += '<circle cx="' + x + '" cy="' + y + '" r="4" class="ponto" style="stroke:' + (h.saldo >= 0 ? 'var(--green)' : 'var(--red)') + '"/>';
    pontosSVG += '<text x="' + x + '" y="' + (H - padB + 16) + '" class="mes-label">' + escHtml(h.mes) + '</text>';
    // Valor acima/abaixo do ponto
    const labelY = h.saldo >= 0 ? y - 10 : y + 16;
    pontosSVG += '<text x="' + x + '" y="' + labelY + '" class="ponto-label">' + dinheiro(h.saldo).replace("R$ ", "") + '</text>';
  });

  const media = saldos.reduce(function (s, v) { return s + v; }, 0) / saldos.length;
  if ($("saldoMedia")) $("saldoMedia").innerText = "Média: " + dinheiro(media);

  wrap.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">'
    + '<defs>'
    + '<linearGradient id="gradLinha" x1="0" y1="0" x2="1" y2="0">'
    +   '<stop offset="0%" stop-color="#6366f1"/>'
    +   '<stop offset="100%" stop-color="#22c55e"/>'
    + '</linearGradient>'
    + '<linearGradient id="gradArea" x1="0" y1="0" x2="0" y2="1">'
    +   '<stop offset="0%" stop-color="#6366f1" stop-opacity="0.4"/>'
    +   '<stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>'
    + '</linearGradient>'
    + '</defs>'
    + grid
    + '<polygon points="' + areaPontos + '" class="linha-area"/>'
    + '<polyline points="' + pontos + '" class="linha-fg"/>'
    + pontosSVG
    + '</svg>';
}

function renderizarGraficos() {
  if (!$("chartPizza")) return;
  const chave = chaveMesAtual();
  const gastos = gastosPorCategoriaDoMes(chave);
  renderizarPizza(gastos);
  renderizarBarras(gastos);
  renderizarLinha(saldoHistoricoMensal(6));
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
function proximoGrupoRecorrenciaAQuitar() {
  // Agrupa contas por recorrencia.grupo e calcula faltam-pra-quitar
  const grupos = {};
  contas.forEach(function (c) {
    if (!c.recorrencia || !c.recorrencia.grupo) return;
    const g = c.recorrencia.grupo;
    if (!grupos[g]) grupos[g] = { nome: c.nome.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim(), total: c.recorrencia.totalParcelas || 0, pagas: 0, pendentes: 0, proximaData: null, valorParcela: c.valor };
    if (c.status === "pago") grupos[g].pagas++;
    else {
      grupos[g].pendentes++;
      const d = new Date(c.data + "T00:00:00");
      if (!grupos[g].proximaData || d < grupos[g].proximaData) grupos[g].proximaData = d;
    }
  });
  // Filtra: tem pendentes (>0) e total > 0
  const arr = Object.keys(grupos).map(function (k) { return Object.assign({ id: k }, grupos[k]); })
    .filter(function (g) { return g.pendentes > 0 && g.total > 0; });
  if (!arr.length) return null;
  // Ordena: menos pendentes primeiro (mais perto de quitar)
  arr.sort(function (a, b) { return a.pendentes - b.pendentes; });
  return arr[0];
}

function renderizarHoje() {
  if (!$("hoje")) return;

  // Saudação
  $("hojeSaudacao").innerText = saudacaoHora() + (usuario.nome ? ", " + usuario.nome : "") + "!";
  $("hojeData").innerText = dataHojeExtenso();

  // Hero: saldo previsto, % comprometido, barra
  const s = helperSaldoMes(chaveMesAtual());
  $("heroSaldo").innerText = dinheiro(s.saldo);
  $("heroSaldo").className = "hero-saldo-valor " + (s.saldo >= 0 ? "metric-green" : "metric-red");
  const pctComp = s.salario > 0 ? Math.min(120, Math.round(s.total / s.salario * 100)) : 0;
  $("heroComprometido").innerText = pctComp + "%";
  $("heroGasto").innerText = dinheiro(s.total);
  $("heroSalario").innerText = dinheiro(s.salario);
  const barra = $("heroBarraFG");
  barra.style.width = Math.min(100, pctComp) + "%";
  barra.classList.toggle("alerta", pctComp >= 90);

  // Card de ação: contas vencendo em ≤7 dias (ignora adiadas)
  const urgentes = proximasContas().filter(function (c) { return c.status !== "pago" && !c.adiada && diasAte(c.data) <= 7; });
  const vencidas = todasContas().filter(function (c) { return c.status !== "pago" && !c.adiada && diasAte(c.data) < 0; });
  const cardAcao = $("cardAcao");
  cardAcao.classList.remove("urgente", "tudo-em-dia");
  if (vencidas.length) {
    cardAcao.classList.add("urgente");
    $("acaoTitulo").innerText = vencidas.length + " conta(s) vencida(s) — pague já";
    const total = vencidas.reduce(function (sum, c) { return sum + Number(c.valor || 0); }, 0);
    $("acaoTotal").innerText = dinheiro(total);
    $("acoesLista").innerHTML = vencidas.slice(0, 6).map(itemConta).join("");
  } else if (urgentes.length) {
    $("acaoTitulo").innerText = urgentes.length + " conta(s) nos próximos 7 dias";
    const total = urgentes.reduce(function (sum, c) { return sum + Number(c.valor || 0); }, 0);
    $("acaoTotal").innerText = dinheiro(total);
    $("acoesLista").innerHTML = urgentes.slice(0, 6).map(itemConta).join("");
  } else {
    cardAcao.classList.add("tudo-em-dia");
    $("acaoTitulo").innerText = "Tudo em dia nos próximos 7 dias";
    $("acaoTotal").innerText = "";
    $("acoesLista").innerHTML = '<p class="empty">Não há nada urgente. Aproveita o sossego.</p>';
  }

  // Rotina
  const totalHab = habitos.length;
  const cumpridos = habitos.filter(function (h) { return bateuMetaNoDia(h.id, hoje); }).length;
  $("rotinaScore").innerText = cumpridos + " / " + totalHab;
  $("hojeHabitos").innerHTML = totalHab
    ? habitos.map(linhaHabitoCompacta).join("")
    : '<p class="empty">Cadastre hábitos na aba Rotina.</p>';

  // Próximo marco (recorrência a quitar)
  const grupo = proximoGrupoRecorrenciaAQuitar();
  if (grupo) {
    const pct = grupo.total > 0 ? Math.round(grupo.pagas / grupo.total * 100) : 0;
    const proxIso = grupo.proximaData.toISOString().slice(0, 10);
    $("proxMarco").innerHTML =
      '<div class="item" style="border-left-color:var(--green)">'
      + '<div><p class="item-title">' + escHtml(grupo.nome) + '</p>'
      + '<p class="item-meta">Faltam <strong>' + grupo.pendentes + '</strong> de ' + grupo.total + ' parcelas · próxima ' + dataBR(proxIso) + ' (' + dinheiro(grupo.valorParcela) + ')</p>'
      + '<div class="progress" style="margin:8px 0 0"><div class="progress-bar" style="width:' + pct + '%"></div></div>'
      + '<p class="item-meta">' + pct + '% concluído</p>'
      + '</div></div>';
  } else {
    // Fallback: próxima conquista
    const todasC = gerarConquistas();
    const pendentesC = todasC.filter(function (c) { return !c.desbloqueada && c.alvo > 0; }).sort(function (a, b) { return b.pct - a.pct; });
    if (pendentesC.length) {
      const c = pendentesC[0];
      $("proxMarco").innerHTML = '<div class="item"><div><p class="item-title">' + escHtml(c.titulo) + '</p>'
        + '<p class="item-meta">' + escHtml(c.desc) + '</p>'
        + '<div class="progress" style="margin:8px 0 0"><div class="progress-bar" style="width:' + c.pct + '%"></div></div>'
        + '<p class="item-meta">' + c.atual + ' / ' + c.alvo + '</p></div></div>';
    } else {
      $("proxMarco").innerHTML = '<p class="empty">Sem marcos pendentes no momento.</p>';
    }
  }

  // Mini cartão
  const fatura = totalCartao();
  const limite = Number(cartao.limite || 0);
  $("miniCartaoValor").innerText = dinheiro(fatura);
  $("miniCartaoSub").innerText = limite > 0
    ? "de " + dinheiro(limite) + " · vence " + dataBR(cartao.vencimento)
    : "Vence " + dataBR(cartao.vencimento);

  // Mini vales — somatório do saldo (recebido - gasto) do mês
  const chave = chaveMesAtual();
  const vgRec = valeDoMes(chave, "gasolina");
  const vaRec = valeDoMes(chave, "alimentacao");
  const vgSaldo = vgRec - gastoCategoriaDoMes(chave, "Combustível");
  const vaSaldo = vaRec - gastoCategoriaDoMes(chave, "Alimentação");
  if (vgRec || vaRec) {
    $("miniValesValor").innerText = dinheiro(vgSaldo + vaSaldo);
    $("miniValesSub").innerText = "VG " + dinheiro(vgSaldo) + " · VA " + dinheiro(vaSaldo);
  } else {
    $("miniValesValor").innerText = "—";
    $("miniValesSub").innerText = "Cadastre seus vales em Finanças → Vales";
  }
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

async function aplicarCorrecoesRemotas(arquivo) {
  arquivo = arquivo || "correcoes-v1.json";
  const id = arquivo.replace(/\.json$/, "");
  if (!seguranca.correcoesAplicadas) seguranca.correcoesAplicadas = {};
  if (seguranca.correcoesAplicadas[id]) {
    if (!confirm("Correções '" + id + "' já foram aplicadas em " + new Date(seguranca.correcoesAplicadas[id]).toLocaleString("pt-BR") + ". Aplicar de novo?")) return;
  }
  try {
    const resp = await fetch("./imports/" + arquivo + "?t=" + Date.now(), { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const c = await resp.json();
    let removidas = 0, atualizadas = 0, adicionadas = 0;
    if (Array.isArray(c.remover) && c.remover.length) {
      const ids = new Set(c.remover.map(String));
      const antes = contas.length;
      contas = contas.filter(function (x) { return !ids.has(String(x.id)); });
      removidas = antes - contas.length;
    }
    if (Array.isArray(c.atualizar)) {
      c.atualizar.forEach(function (u) {
        const idx = contas.findIndex(function (x) { return String(x.id) === String(u.id); });
        if (idx >= 0 && u.changes) {
          contas[idx] = Object.assign({}, contas[idx], u.changes);
          atualizadas++;
        }
      });
    }
    if (Array.isArray(c.adicionar)) {
      const existentes = new Set(contas.map(function (x) { return String(x.id); }));
      c.adicionar.forEach(function (n) {
        if (n && n.id && !existentes.has(String(n.id))) { contas.push(n); adicionadas++; }
      });
    }
    seguranca.correcoesAplicadas[id] = new Date().toISOString();
    salvar(); renderizar();
    toast("Correções aplicadas: −" + removidas + " removidas, +" + adicionadas + " novas, ~" + atualizadas + " atualizadas.", "success", 5000);
    atualizarVisibilidadeBotaoCorrecoes();
  } catch (e) {
    toast("Falha: " + (e && e.message || e), "error");
    console.warn(e);
  }
}
function atualizarVisibilidadeBotaoCorrecoes() {
  const apl = seguranca.correcoesAplicadas || {};
  const b1 = $("btnCorrecoesV1");
  if (b1) {
    const ok = !!apl["correcoes-v1"];
    b1.innerText = ok ? "Correções v1 aplicadas" : "Aplicar correções v1";
    b1.disabled = ok;
  }
  const b2 = $("btnCorrecoesV2");
  if (b2) {
    const ok = !!apl["correcoes-v2"];
    b2.innerText = ok ? "Pay joy adicionado" : "Aplicar correções v2 (Pay joy)";
    b2.disabled = ok;
  }
}

async function importarBackupInicialRemoto() {
  if (seguranca.backupInicialImportado) {
    if (!confirm("Você já importou esse backup antes. Mesclar de novo? Itens que já foram adicionados serão ignorados (deduplica por id).")) return;
  }
  const btn = $("btnImportarBackupInicial");
  if (btn) { btn.disabled = true; btn.innerText = "Baixando..."; }
  try {
    const resp = await fetch("./imports/backup-inicial.json?t=" + Date.now(), { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const dados = await resp.json();
    const total = (dados.contas || []).length;
    if (!confirm("Mesclar " + total + " contas do backup inicial? Nada vai ser apagado — só itens novos serão adicionados.")) {
      if (btn) { btn.disabled = false; btn.innerText = "Importar meus dados antigos"; }
      return;
    }
    mesclarBackup(dados);
    seguranca.backupInicialImportado = new Date().toISOString();
    dbSet("seguranca", seguranca);
    atualizarVisibilidadeBotaoBackupInicial();
  } catch (e) {
    toast("Falha ao baixar backup: " + (e && e.message || e), "error");
    console.warn(e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = "Importar meus dados antigos"; }
  }
}
function atualizarVisibilidadeBotaoBackupInicial() {
  const btn = $("btnImportarBackupInicial");
  if (!btn) return;
  if (seguranca.backupInicialImportado) {
    btn.style.display = "none";
    const aviso = $("avisoBackupInicial");
    if (aviso) aviso.innerText = "Backup inicial importado em " + new Date(seguranca.backupInicialImportado).toLocaleString("pt-BR");
  } else {
    btn.style.display = "";
  }
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
   Modal de configurações (engrenagem)
   =========================================================== */
function abrirConfig() {
  const m = $("modalConfig");
  if (!m) return;
  m.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  renderizarStatusBackup();
  renderizarSnapshots();
  popularConfigSeguranca();
  // Re-consulta versão do SW toda vez que o modal abre
  if (_swRegistration) pedirVersaoSW(_swRegistration);
  else if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    pedirVersaoSW({ active: navigator.serviceWorker.controller });
  }
}
function fecharConfig() {
  const m = $("modalConfig");
  if (!m) return;
  m.classList.add("hidden");
  document.body.style.overflow = "";
}
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    const m = $("modalConfig");
    if (m && !m.classList.contains("hidden")) fecharConfig();
  }
});

/* ===========================================================
   PWA: service worker + botão instalar + auto-update
   =========================================================== */
const APP_VERSION = "1.1";   // bump quando lançar mudança significativa
let _swRegistration = null;
let _swNovoEsperando = null;

function registrarSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").then(function (reg) {
    _swRegistration = reg;
    if (reg.waiting && navigator.serviceWorker.controller) {
      _swNovoEsperando = reg.waiting;
      mostrarBannerAtualizacao();
    }
    reg.addEventListener("updatefound", function () {
      const novo = reg.installing;
      if (!novo) return;
      novo.addEventListener("statechange", function () {
        if (novo.state === "installed" && navigator.serviceWorker.controller) {
          _swNovoEsperando = novo;
          mostrarBannerAtualizacao();
        }
      });
    });
    let recarregando = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (recarregando) return;
      recarregando = true;
      window.location.reload();
    });
    // Checa atualização a cada 30 minutos
    setInterval(function () { reg.update().catch(function () {}); }, 30 * 60 * 1000);
    // Pede versão do SW (com timeout — SWs antigos não respondem)
    pedirVersaoSW(reg);
    // Listener global pra responses sem MessageChannel
    navigator.serviceWorker.addEventListener("message", function (e) {
      if (e.data && e.data.type === "VERSION") {
        const v = $("modalConfigVersao");
        if (v) v.innerText = "SW " + e.data.version;
      }
    });
  }).catch(function (e) {
    console.warn("Service worker não registrado:", e);
  });
}

function mostrarBannerAtualizacao() {
  let banner = document.getElementById("bannerUpdate");
  if (banner) return;
  banner = document.createElement("div");
  banner.id = "bannerUpdate";
  banner.className = "update-banner";
  banner.innerHTML =
    '<span>Nova versão disponível</span>'
    + '<button class="btn btn-small btn-green" type="button" onclick="aplicarAtualizacao()">Atualizar</button>'
    + '<button class="btn btn-small btn-dark" type="button" onclick="document.getElementById(\'bannerUpdate\').remove()">Depois</button>';
  document.body.appendChild(banner);
}
function pedirVersaoSW(reg) {
  const alvo = (reg && reg.active) || navigator.serviceWorker.controller;
  if (!alvo) {
    const v = $("modalConfigVersao");
    if (v) v.innerText = "SW não ativado";
    return;
  }
  let respondeu = false;
  try {
    const ch = new MessageChannel();
    ch.port1.onmessage = function (e) {
      respondeu = true;
      if (e.data && e.data.type === "VERSION") {
        const v = $("modalConfigVersao");
        if (v) v.innerText = "SW " + e.data.version;
      }
    };
    alvo.postMessage({ type: "GET_VERSION" }, [ch.port2]);
    // Sem port — também envia broadcast pra ser pego pelo listener global
    alvo.postMessage({ type: "GET_VERSION" });
    setTimeout(function () {
      if (!respondeu) {
        const v = $("modalConfigVersao");
        if (v && v.innerText.indexOf("SW ") !== 0) v.innerText = "SW antigo (atualize)";
      }
    }, 1500);
  } catch (e) {
    console.warn("Erro pedindo versão SW:", e);
  }
}

function aplicarAtualizacao() {
  if (_swNovoEsperando) {
    _swNovoEsperando.postMessage({ type: "SKIP_WAITING" });
  } else {
    window.location.reload();
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
    if ($("modalConfigAppVersao")) $("modalConfigAppVersao").innerText = APP_VERSION;
    await openDB();
    // Migra dados do localStorage do app antigo, se houver
    await migrarLocalStorageSeNecessario();
    await carregarTudo();
    await migrarSchema();
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
    atualizarNomeSidebar();
    alternarCampoQuinzenasConta();
    alternarCampoQuinzenas();
    renderizar();
    renderizarStatusBackup();
    // Bloqueio aparece SE estiver ativado — antes do app ficar visível pra interação
    verificarBloqueioAoAbrir();
    // Setup só na primeira vez
    if (setupNecessario()) {
      mostrarOverlay("setupOverlay");
      setTimeout(function () { if ($("setupNome")) $("setupNome").focus(); }, 100);
    }
    registrarSW();
    // Verifica notificações pendentes (uma vez no boot + a cada 60 min)
    setTimeout(verificarENotificar, 1500);
    setInterval(verificarENotificar, 60 * 60 * 1000);
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
window.abrirConfig = abrirConfig;
window.fecharConfig = fecharConfig;
window.aplicarAtualizacao = aplicarAtualizacao;
window.salvarSetupInicial = salvarSetupInicial;
window.pularSetupInicial = pularSetupInicial;
window.tentarDesbloquearComSenha = tentarDesbloquearComSenha;
window.desbloquearComBiometria = desbloquearComBiometria;
window.salvarNomeConfig = salvarNomeConfig;
window.salvarSenhaConfig = salvarSenhaConfig;
window.alternarBloqueioAtivo = alternarBloqueioAtivo;
window.alternarBiometriaAtiva = alternarBiometriaAtiva;
window.importarBackupInicialRemoto = importarBackupInicialRemoto;
window.toggleSidebar = toggleSidebar;
window.fecharSidebar = fecharSidebar;
window.atualizarNomeSidebar = atualizarNomeSidebar;
window.bloquearAgora = bloquearAgora;
window.alternarAdiada = alternarAdiada;
window.aplicarCorrecoesRemotas = aplicarCorrecoesRemotas;
window.excluirGrupoRecorrencia = excluirGrupoRecorrencia;
window.duplicarGrupoRecorrencia = duplicarGrupoRecorrencia;
window.toggleSelecaoConta = toggleSelecaoConta;
window.limparSelecao = limparSelecao;
window.marcarSelecionadasPagas = marcarSelecionadasPagas;
window.adiarSelecionadas = adiarSelecionadas;
window.excluirSelecionadas = excluirSelecionadas;
window.alternarNotificacoes = alternarNotificacoes;
window.salvarDiasAntes = salvarDiasAntes;
window.testarNotificacao = testarNotificacao;
window.alternarModoSelecao = alternarModoSelecao;
window.adicionarValorMeta = adicionarValorMeta;
window.atualizarCampoQuantasConta = atualizarCampoQuantasConta;
// Expostos só pra testes (não usados na UI)
window.normalizarCategoria = normalizarCategoria;
window.escHtml = escHtml;
window.dinheiro = dinheiro;
window.dataBR = dataBR;
window.adicionarMeses = adicionarMeses;
window.adicionarDias = adicionarDias;
