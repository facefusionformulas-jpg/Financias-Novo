"use strict";

/* Smoke tests do módulo Planejamento — só funções puras de cálculo.
   Carrega planejamento.js num VM context e roda assertions dentro do mesmo escopo
   (porque `let`/`const` no top-level do módulo não vazam pro sandbox). */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "planejamento.js"), "utf8");

const sandbox = {
  console: console,
  window: {},
  document: { getElementById: () => null },
  dbGet: async () => undefined,
  dbSet: async () => undefined,
  dbSetMany: async () => undefined,
  prompt: () => null,
  confirm: () => false,
  alert: () => undefined,
  setTimeout: setTimeout,
  setInterval: setInterval,
  Math: Math,
  Date: Date,
  Number: Number,
  String: String,
  Array: Array,
  Object: Object,
  JSON: JSON
};
sandbox.global = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx);

/** Avalia código DENTRO do contexto do módulo — vê os let/const internos. */
function inside(code) { return vm.runInContext(code, ctx); }

let passou = 0, falhou = 0;
function ok(cond, label) {
  if (cond) { console.log("OK " + label); passou++; }
  else { console.log("XX " + label); falhou++; }
}
function eq(a, b, label) {
  if (a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.01)) {
    console.log("OK " + label); passou++;
  } else {
    console.log("XX " + label + " — esperado " + JSON.stringify(b) + ", got " + JSON.stringify(a));
    falhou++;
  }
}

// === 1. plRestante ===
eq(inside("plRestante({valor_total:100, valor_pago:30})"), 70, "plRestante calcula resto");
eq(inside("plRestante({valor_total:100, valor_pago:150})"), 0, "plRestante nunca negativo");
eq(inside("plRestante({valor_total:0, valor_pago:0})"), 0, "plRestante zero pra dívida zerada");

// === 2. plPesoTipo ===
ok(inside("plPesoTipo('cartao') > plPesoTipo('pessoal')"), "cartão pesa mais que pessoal");
ok(inside("plPesoTipo('fintech') > plPesoTipo('imposto')"), "fintech pesa mais que imposto");
ok(inside("plPesoTipo('cartao') > plPesoTipo('fintech')"), "cartão pesa mais que fintech");

// === 3. plOrdenarDividas — avalanche por tipo ===
inside(`
  pl_dividas.length = 0;
  [
    {id:"a", nome:"Carlos",  valor_total:355,  valor_pago:0,   tipo:"pessoal",  juros:0,  status:"aberta"},
    {id:"b", nome:"Cartão",  valor_total:2300, valor_pago:0,   tipo:"cartao",   juros:0,  status:"aberta"},
    {id:"c", nome:"Mercado", valor_total:1227, valor_pago:0,   tipo:"conta",    juros:0,  status:"aberta"},
    {id:"d", nome:"Pay Joy", valor_total:342,  valor_pago:0,   tipo:"fintech",  juros:0,  status:"aberta"},
    {id:"e", nome:"Quitada", valor_total:100,  valor_pago:100, tipo:"cartao",   juros:50, status:"quitada"}
  ].forEach(d => pl_dividas.push(d));
`);
eq(inside("plOrdenarDividas(pl_dividas).length"), 4, "ordenação ignora quitadas");
eq(inside("plOrdenarDividas(pl_dividas)[0].id"), "b", "cartão vem primeiro (peso 100)");
eq(inside("plOrdenarDividas(pl_dividas)[1].id"), "d", "fintech vem segundo (peso 90)");
eq(inside("plOrdenarDividas(pl_dividas)[2].id"), "c", "conta vem terceiro (peso 60)");
eq(inside("plOrdenarDividas(pl_dividas)[3].id"), "a", "pessoal vem último (peso 10)");

// === 3b. Juros declarado tem prioridade sobre tipo ===
inside(`
  pl_dividas.length = 0;
  [
    {id:"x", nome:"Pessoal alto juros", valor_total:100, valor_pago:0, tipo:"pessoal", juros:15, status:"aberta"},
    {id:"y", nome:"Cartão baixo juros", valor_total:100, valor_pago:0, tipo:"cartao",  juros:2,  status:"aberta"}
  ].forEach(d => pl_dividas.push(d));
`);
eq(inside("plOrdenarDividas(pl_dividas)[0].id"), "x", "juros maior vem primeiro mesmo se for tipo pessoal");

// === 4. plTotalDividas / plTotalPago ===
inside(`
  pl_dividas.length = 0;
  [
    {id:"a", valor_total:355,  valor_pago:0,   status:"aberta"},
    {id:"b", valor_total:2300, valor_pago:0,   status:"aberta"},
    {id:"c", valor_total:1227, valor_pago:0,   status:"aberta"},
    {id:"d", valor_total:342,  valor_pago:0,   status:"aberta"},
    {id:"e", valor_total:100,  valor_pago:100, status:"quitada"}
  ].forEach(d => pl_dividas.push(d));
`);
eq(inside("plTotalDividas()"), 4224, "total das em aberto");
eq(inside("plTotalPago()"), 100, "total já pago");

// === 5. plPisoSobrevivencia ===
inside(`
  Object.assign(pl_config, {
    salario_fixo: 2000, parcela_moto: 1213, internet: 40, das_mei: 80,
    custos_operacionais_estimados: 900
  });
`);
// custos: 1213+40+80+900 = 2233 − salário 2000 = 233
eq(inside("plPisoSobrevivencia()"), 233, "piso = custos − salário");

inside("pl_config.salario_fixo = 5000;");
eq(inside("plPisoSobrevivencia()"), 0, "piso nunca negativo se salário cobre tudo");
inside("pl_config.salario_fixo = 2000;");

// === 6. plProjecao — 3 meses com iFood na meta ===
inside(`
  pl_ifood.length = 0;
  Object.assign(pl_caixa, { meta: 0, saldo: 0, movimentos: [] });
  pl_dividas.length = 0;
  // Cenário real: 11 dívidas do Daividson (~R$ 5.997)
  PL_DIVIDAS_INICIAIS.forEach(d => pl_dividas.push(Object.assign({ id: 'pl_' + Math.random(), valor_pago: 0, status: 'aberta' }, d)));
`);
const proj = inside("plProjecao(4000)");
eq(proj.length, 3, "projeção 3 meses");
ok(proj[0].pago_dividas > 0, "M1 paga dívidas (com iFood 4000)");
ok(proj[2].divida_restante < proj[0].divida_restante, "dívida diminui ao longo dos meses");
// Sobra = 2000+4000 - 1333 - 900 = 3767/mês. Dívida total ~5997. Quita em ~2 meses.
ok(proj[1].divida_restante < 3000, "M2 já quitou metade ou mais");
ok(proj[2].caixa_acumulado > 0, "M3 já tem dinheiro no caixa");
ok(proj[2].divida_restante <= 0.01, "M3 zerou a dívida no cenário meta");

// === 7. plProjecao com só salário ===
const projZero = inside("plProjecao(0)");
// entradas 2000, custos 2233 → sobra -233 → não paga dívida nem caixa
eq(projZero[0].pago_dividas, 0, "só salário: não paga dívida (sobra negativa)");
eq(projZero[0].pro_caixa, 0, "só salário: nada vai pro caixa");

// === 8. plDinheiro ===
eq(inside("plDinheiro(1234.5)"), "R$ 1.234,50", "formato BR com separador de milhar");
eq(inside("plDinheiro(0)"), "R$ 0,00", "zero formatado");
eq(inside("plDinheiro(-50)"), "-R$ 50,00", "negativo com sinal");

// === 9. plChaveMes ===
eq(inside("plChaveMes(new Date(2026, 5, 8))"), "2026-06", "chaveMes formato AAAA-MM (junho 2026)");

// === 10. Dívidas iniciais ===
eq(inside("PL_DIVIDAS_INICIAIS.length"), 11, "11 dívidas pré-cadastradas");
const totalInicial = inside("PL_DIVIDAS_INICIAIS.reduce((s, d) => s + d.valor_total, 0)");
ok(Math.abs(totalInicial - 5997.44) < 1, "total das dívidas iniciais ~= R$ 5.997 (got " + totalInicial.toFixed(2) + ")");

// === 11. Ordenação real das dívidas do Daividson ===
inside(`
  pl_dividas.length = 0;
  PL_DIVIDAS_INICIAIS.forEach(d => pl_dividas.push(Object.assign({ id: d.nome, valor_pago: 0, status: 'aberta' }, d)));
`);
const ordReal = inside("plOrdenarDividas(pl_dividas).map(d => d.nome)");
// Cartão tem peso 100, fintech 90 — Cartão de crédito deve vir primeiro
eq(ordReal[0], "Cartão de crédito", "Cartão de crédito é prioridade 1");
// As 3 fintechs (Pay Joy, Blipay, Facio) devem vir antes da Conta Mercado
const idxMercado = ordReal.indexOf("Mercado");
ok(ordReal.indexOf("Pay Joy") < idxMercado, "Pay Joy (fintech) antes do Mercado (conta)");
ok(ordReal.indexOf("Blipay") < idxMercado, "Blipay (fintech) antes do Mercado (conta)");
ok(ordReal.indexOf("Facio") < idxMercado, "Facio (fintech) antes do Mercado (conta)");
// Carlos (pessoal) deve vir por último
eq(ordReal[ordReal.length - 1], "Carlos", "Carlos (pessoal) vai pro fim da fila");

// === 12. Backup/restore — montar e aplicar (v4.1) ===
inside(`
  pl_dividas.length = 0;
  PL_DIVIDAS_INICIAIS.forEach(d => pl_dividas.push(Object.assign({ id: 'pl_' + d.nome, valor_pago: 0, status: 'aberta' }, d)));
  pl_ifood.length = 0;
  pl_ifood.push({ id: 'r1', data: '2026-06-08', ganho: 250, horas: 8, km: 100, gasto_combustivel: 21 });
  Object.assign(pl_caixa, { meta: 5000, saldo: 1200, movimentos: [{ id: 'm1', data: '2026-06-01', valor: 1200, tipo: 'entrada', descricao: 'inicial' }] });
`);
const backupSnap = inside("plMontarBackup()");
ok(backupSnap.pl_dividas && backupSnap.pl_dividas.length === 11, "plMontarBackup inclui as 11 dívidas");
ok(backupSnap.pl_ifood && backupSnap.pl_ifood.length === 1, "plMontarBackup inclui ifood");
eq(backupSnap.pl_caixa.saldo, 1200, "plMontarBackup inclui caixa saldo");
eq(backupSnap.pl_caixa.meta, 5000, "plMontarBackup inclui caixa meta");
ok(backupSnap.pl_config && backupSnap.pl_config.salario_fixo === 2000, "plMontarBackup inclui config");

// === 13. Aplicar backup substitui o estado ===
inside(`
  pl_dividas.length = 0;
  pl_ifood.length = 0;
  Object.assign(pl_caixa, { meta: 0, saldo: 0, movimentos: [] });
`);
eq(inside("pl_dividas.length"), 0, "estado zerado antes de aplicar backup");
inside("plAplicarBackup(" + JSON.stringify(backupSnap) + ")");
eq(inside("pl_dividas.length"), 11, "aplicar backup restaura 11 dívidas");
eq(inside("pl_ifood.length"), 1, "aplicar backup restaura ifood");
eq(inside("pl_caixa.saldo"), 1200, "aplicar backup restaura caixa saldo");

// === 14. Limpar tudo zera dívidas/ifood/caixa mas preserva config ===
inside("plLimparTudo()");
eq(inside("pl_dividas.length"), 0, "plLimparTudo zera dividas");
eq(inside("pl_ifood.length"), 0, "plLimparTudo zera ifood");
eq(inside("pl_caixa.saldo"), 0, "plLimparTudo zera caixa saldo");
eq(inside("pl_config.salario_fixo"), 2000, "plLimparTudo PRESERVA config (salário fica)");

// === v4.2: Vinculação com contas Finanças ===

// 16. plNormalizarNome — match fuzzy
eq(inside('plNormalizarNome("Cartão de Crédito")'), "cartao de credito", "normaliza acentos + lowercase");
eq(inside('plNormalizarNome("Mercado 3/6")'), "mercado", "remove sufixo de parcela X/Y");
eq(inside('plNormalizarNome("Mercado (2/6)")'), "mercado", "remove sufixo (X/Y) com parênteses");
eq(inside('plNormalizarNome("  Pay  Joy  ")'), "pay joy", "trima e normaliza espaços");

// 17. Detecção de duplicatas vs contas[]
inside(`
  pl_dividas.length = 0;
  pl_dividas.push({ id:'d1', nome:'Mercado', valor_total:1227, valor_pago:0, tipo:'conta', status:'aberta' });
  pl_dividas.push({ id:'d2', nome:'Cartão de crédito', valor_total:2300, valor_pago:0, tipo:'cartao', status:'aberta' });
  pl_dividas.push({ id:'d3', nome:'Aluguel', valor_total:500, valor_pago:0, tipo:'conta', status:'aberta' });
  // Simula contas existentes (precisa estar no sandbox)
  globalThis.contas = [
    { id:'c1', nome:'Mercado 1/6', valor:204.50, data:'2026-06-10', status:'pendente' },
    { id:'c2', nome:'Mercado 2/6', valor:204.50, data:'2026-07-10', status:'pendente' },
    { id:'c3', nome:'Cartão de Crédito', valor:2300, data:'2026-06-11', status:'pago' }
  ];
`);
eq(inside("plBuscarContasParecidas(pl_dividas[0]).length"), 2, "achou 2 contas Mercado parecidas com a dívida");
eq(inside("plBuscarContasParecidas(pl_dividas[1]).length"), 1, "achou 1 conta Cartão de Crédito (case-insensitive)");
eq(inside("plBuscarContasParecidas(pl_dividas[2]).length"), 0, "Aluguel não tem duplicata");

// 18. Valor pago EFETIVO = soma das parcelas pagas em Contas
inside("plVincularConta('d1','c1'); plVincularConta('d1','c2');");
eq(inside("pl_dividas[0].contas_vinculadas.length"), 2, "Mercado tem 2 contas vinculadas");
eq(inside("plValorPagoEfetivo(pl_dividas[0])"), 0, "ambas pendentes → pago = 0");
inside("contas[0].status = 'pago'");
eq(inside("plValorPagoEfetivo(pl_dividas[0])"), 204.50, "1 parcela paga → pago = R$ 204,50");
inside("contas[1].status = 'pago'");
eq(inside("plValorPagoEfetivo(pl_dividas[0])"), 409.00, "2 parcelas pagas → pago = R$ 409,00");
eq(inside("plRestante(pl_dividas[0])"), 818.00, "restante = total − pago efetivo");

// 19. plValorPagoEfetivo cai pro valor_pago armazenado quando NÃO há vínculo
inside(`
  pl_dividas.push({ id:'d4', nome:'Solo', valor_total:100, valor_pago:30, tipo:'conta', status:'aberta' });
`);
eq(inside("plValorPagoEfetivo(pl_dividas[pl_dividas.length-1])"), 30, "sem vínculo → usa valor_pago armazenado");

// 20. Cartão de crédito: 1 conta paga = vinculada → dívida fica quitada automaticamente
inside("plVincularConta('d2','c3')");
eq(inside("plValorPagoEfetivo(pl_dividas[1])"), 2300, "Cartão (vinculado a c3 paga) → pago = total");
eq(inside("plRestante(pl_dividas[1])"), 0, "Cartão restante = 0");
eq(inside("pl_dividas[1].status"), "quitada", "Cartão fica quitada automaticamente ao vincular");

// 21. plTotalPago soma os efetivos
const totalPagoVinc = inside("plTotalPago()");
ok(totalPagoVinc >= 2300 + 409, "plTotalPago usa valores efetivos das vinculadas");

// 22. Desvincular reverte
inside("plDesvincularConta('d1','c1')");
eq(inside("pl_dividas[0].contas_vinculadas.length"), 1, "após desvincular: 1 vínculo");
eq(inside("plValorPagoEfetivo(pl_dividas[0])"), 204.50, "pago efetivo cai pra 1 conta paga");

// === 15. Mesclar backup não duplica ===
inside(`
  pl_dividas.length = 0;
  pl_dividas.push({ id: 'a', nome: 'Existe', valor_total: 100, valor_pago: 0, tipo: 'cartao', status: 'aberta' });
`);
const novos = inside("plMesclarBackup({ pl_dividas: [{ id: 'a', nome: 'Duplicata', valor_total: 999 }, { id: 'b', nome: 'Nova', valor_total: 50, valor_pago: 0, tipo: 'fintech', status: 'aberta' }] })");
eq(inside("pl_dividas.length"), 2, "mesclar adiciona só a nova (id 'b'), não duplica 'a'");
eq(inside("pl_dividas.find(d => d.id === 'a').nome"), "Existe", "mesclar preserva nome original do id 'a'");
ok(novos >= 1, "plMesclarBackup retorna contagem de novos");

console.log("");
console.log("─".repeat(40));
console.log("Resultado: " + passou + " ok / " + falhou + " falhas");
process.exit(falhou > 0 ? 1 : 0);
