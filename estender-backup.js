// Script que estende o backup do user com parcelas contínuas até ago/2029
// nas contas que terminavam em 2026: SMART FIT, INTERNET CELULAR e MERCADO.
"use strict";

const fs = require("fs");
const path = require("path");

const ENTRADA = "C:\\Users\\distr\\Downloads\\backup-financas-2026-06-02.json";
const SAIDA = "C:\\Users\\distr\\Downloads\\backup-financas-estendido.json";

const backup = JSON.parse(fs.readFileSync(ENTRADA, "utf8"));

function novoId(idx) {
  return "id_" + Date.now().toString(36) + "_ext" + idx.toString(36) + Math.random().toString(36).slice(2, 8);
}

function adicionarMeses(dataIso, meses) {
  const d = new Date(dataIso + "T00:00:00");
  const dia = d.getDate();
  d.setMonth(d.getMonth() + meses);
  if (d.getDate() !== dia) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

// Quantos meses do início da extensão até ago/2029?
function mesesAteAgo2029(inicioIso) {
  const d = new Date(inicioIso + "T00:00:00");
  const fim = new Date("2029-08-31T00:00:00");
  let n = 0;
  while (d <= fim) {
    n++;
    const dia = d.getDate();
    d.setMonth(d.getMonth() + 1);
    if (d.getDate() !== dia) d.setDate(0);
  }
  return n;
}

const extensoes = [
  {
    grupo: "id_mpcoyzzq_ahmmnnfxkpr",     // Smart Fit
    nomeBase: "SMART FIT",
    valor: 149.9,
    categoria: "ACADEMIA",
    inicio: "2026-12-01",
    tipo: "mensal recorrente",
    parcelasJaExistentes: 7
  },
  {
    grupo: "id_mpcp190t_g0wnvdn3ia",       // Internet Celular
    nomeBase: "INTERNET CELULAR",
    valor: 40,
    categoria: "ESSENCIAL",
    inicio: "2026-12-20",
    tipo: "mensal recorrente",
    parcelasJaExistentes: 7
  },
  {
    grupo: "id_mpfogyq5_62ohbl5euf3",      // Mercado
    nomeBase: "MERCADO",
    valor: 200,
    categoria: "MERCADO",
    inicio: "2026-12-20",
    tipo: "mensal recorrente",
    parcelasJaExistentes: 6
  }
];

let adicionados = 0;
let idx = 0;

extensoes.forEach(function (ext) {
  const nMeses = mesesAteAgo2029(ext.inicio);
  const total = ext.parcelasJaExistentes + nMeses;
  for (let i = 0; i < nMeses; i++) {
    const dataIso = adicionarMeses(ext.inicio, i);
    const parcelaAtual = ext.parcelasJaExistentes + i + 1;
    backup.contas.push({
      id: novoId(idx++),
      nome: ext.nomeBase + " (" + parcelaAtual + "/" + total + ")",
      valor: ext.valor,
      data: dataIso,
      tipo: ext.tipo,
      categoria: ext.categoria,
      status: "pendente",
      origem: "recorrencia",
      recorrencia: {
        grupo: ext.grupo,
        parcelaAtual: parcelaAtual,
        totalParcelas: total,
        frequencia: "mensal"
      }
    });
    adicionados++;
  }
});

// Atualiza data do backup e adiciona nota
backup.dataBackup = new Date().toISOString();
backup.notaExtensao = "Estendido até ago/2029: SMART FIT, INTERNET CELULAR, MERCADO. " + adicionados + " parcelas adicionadas.";

fs.writeFileSync(SAIDA, JSON.stringify(backup, null, 2));

console.log("---");
console.log("Arquivo:", SAIDA);
console.log("Parcelas adicionadas:", adicionados);
console.log("Total de contas no backup:", backup.contas.length);
console.log("---");
