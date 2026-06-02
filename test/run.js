/*
  Testes vanilla pro app, usando jsdom + fake-indexeddb.
  Rodar: `node test/run.js` (precisa de `npm install jsdom fake-indexeddb`)
  Saída: 1 linha por teste com ✓ / ✗. Exit code 1 se algo falhar.
*/
"use strict";

require("fake-indexeddb/auto");
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dbCode = fs.readFileSync(path.join(ROOT, "db.js"), "utf8");
const appCode = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

const dom = new JSDOM(html, {
  url: "http://localhost/",
  pretendToBeVisual: true,
  runScripts: "dangerously"
});
const { window } = dom;
window.indexedDB = global.indexedDB;
window.IDBKeyRange = global.IDBKeyRange;
try { Object.defineProperty(window, "crypto", { value: require("crypto").webcrypto || global.crypto, configurable: true }); }
catch (e) { /* já tem crypto */ }
window.alert = () => {};
window.confirm = () => true;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener: () => {}, removeListener: () => {} }));
window.fetch = () => Promise.reject(new Error("no network"));
window.console = console;

const sDb = window.document.createElement("script");
sDb.textContent = dbCode;
window.document.body.appendChild(sDb);
const sApp = window.document.createElement("script");
sApp.textContent = appCode;
window.document.body.appendChild(sApp);
window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

let passou = 0, falhou = 0;
function test(grupo, nome, fn) {
  try {
    fn();
    console.log("  ✓ [" + grupo + "] " + nome);
    passou++;
  } catch (e) {
    console.log("  ✗ [" + grupo + "] " + nome + " — " + e.message);
    falhou++;
  }
}

setTimeout(function () {
  // -------- normalizarCategoria --------
  test("categoria", "vira Title Case", function () {
    assert.strictEqual(window.normalizarCategoria("MOTO"), "Moto");
    assert.strictEqual(window.normalizarCategoria("moto"), "Moto");
    assert.strictEqual(window.normalizarCategoria("Moto"), "Moto");
  });
  test("categoria", "preserva stopwords", function () {
    assert.strictEqual(window.normalizarCategoria("carro de luxo"), "Carro de Luxo");
    assert.strictEqual(window.normalizarCategoria("CASA DA VOVÓ"), "Casa da Vovó");
  });
  test("categoria", "vazia vira Outros", function () {
    assert.strictEqual(window.normalizarCategoria(""), "Outros");
    assert.strictEqual(window.normalizarCategoria(null), "Outros");
  });

  // -------- escHtml --------
  test("escHtml", "escapa <script>", function () {
    assert.strictEqual(window.escHtml("<script>"), "&lt;script&gt;");
  });
  test("escHtml", "escapa aspas", function () {
    assert.strictEqual(window.escHtml('a "b" \'c\''), 'a &quot;b&quot; &#39;c&#39;');
  });

  // -------- dinheiro --------
  test("dinheiro", "formata pt-BR", function () {
    assert.match(window.dinheiro(1234.5), /R\$\s?1\.234,50/);
    assert.match(window.dinheiro(0), /R\$\s?0,00/);
  });

  // -------- dataBR --------
  test("dataBR", "converte ISO pra pt-BR", function () {
    assert.strictEqual(window.dataBR("2026-06-15"), "15/06/2026");
    assert.strictEqual(window.dataBR(""), "--/--/----");
  });

  // -------- adicionarMeses / adicionarDias --------
  test("datas", "adicionarMeses preserva dia", function () {
    assert.strictEqual(window.adicionarMeses("2026-01-15", 1), "2026-02-15");
    assert.strictEqual(window.adicionarMeses("2026-01-31", 1), "2026-02-28");
  });
  test("datas", "adicionarDias", function () {
    assert.strictEqual(window.adicionarDias("2026-01-15", 30), "2026-02-14");
  });

  console.log("\n" + passou + " passou, " + falhou + " falharam");
  process.exit(falhou ? 1 : 0);
}, 2000);
