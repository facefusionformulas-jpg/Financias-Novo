"use strict";

/*
  Camada de storage: IndexedDB com API simples baseada em Promises.
  Toda a aplicação usa dbGet/dbSet/dbGetAll/dbSetMany — nunca toca em
  localStorage diretamente. Assim podemos trocar a implementação sem
  mexer no resto.
*/

const DB_NAME = "financas_db";
const DB_VERSION = 1;
const STORE = "kv";

let _db = null;

function openDB() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

function dbGet(key) {
  return new Promise(function (resolve, reject) {
    if (!_db) return reject(new Error("DB não aberto"));
    const tx = _db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = function () { resolve(req.result ? req.result.value : undefined); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

function dbSet(key, value) {
  return new Promise(function (resolve, reject) {
    if (!_db) return reject(new Error("DB não aberto"));
    const tx = _db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put({ key: key, value: value });
    req.onsuccess = function () { resolve(); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

function dbGetAll() {
  return new Promise(function (resolve, reject) {
    if (!_db) return reject(new Error("DB não aberto"));
    const tx = _db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = function () {
      const out = {};
      (req.result || []).forEach(function (r) { out[r.key] = r.value; });
      resolve(out);
    };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

function dbSetMany(kvObj) {
  return new Promise(function (resolve, reject) {
    if (!_db) return reject(new Error("DB não aberto"));
    const tx = _db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    Object.keys(kvObj).forEach(function (k) {
      store.put({ key: k, value: kvObj[k] });
    });
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function (e) { reject(e.target.error); };
  });
}

function dbClear() {
  return new Promise(function (resolve, reject) {
    if (!_db) return reject(new Error("DB não aberto"));
    const tx = _db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = function () { resolve(); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

/*
  Migração one-shot do localStorage do app antigo (file://) — só funciona
  se este HTML for aberto na MESMA origem que tinha os dados antigos. Em
  hospedagem GitHub Pages, a migração precisa ser feita via importação
  de backup JSON.
*/
async function migrarLocalStorageSeNecessario() {
  try {
    const flag = await dbGet("_migrado_de_localStorage");
    if (flag) return false;
    const mapa = {
      "financas_contas_limpo_v1": "contas",
      "financas_metas_limpo_v1": "metas",
      "financas_compras_limpo_v1": "comprasCartao",
      "financas_cartao_limpo_v1": "cartao",
      "financas_salario_limpo_v1": "salarioMes",
      "financas_cartao_atualizado_limpo_v1": "ultimaAtualizacaoCartao",
      "financas_salarios_por_mes_limpo_v1": "salariosPorMes",
      "financas_faturas_por_mes_limpo_v1": "faturasPorMes",
      "financas_habitos_v1": "habitos",
      "financas_registro_habitos_v1": "registroHabitos",
      "financas_conquistas_v1": "conquistasDesbloqueadas",
      "financas_tema_v1": "tema"
    };
    let migrou = false;
    const setAll = {};
    Object.keys(mapa).forEach(function (lsKey) {
      const bruto = localStorage.getItem(lsKey);
      if (bruto === null) return;
      try {
        // Se for número simples (salarioMes), parseia como número
        if (lsKey === "financas_salario_limpo_v1") {
          setAll[mapa[lsKey]] = Number(bruto || 0);
        } else if (lsKey === "financas_cartao_atualizado_limpo_v1" || lsKey === "financas_tema_v1") {
          setAll[mapa[lsKey]] = bruto;
        } else {
          setAll[mapa[lsKey]] = JSON.parse(bruto);
        }
        migrou = true;
      } catch (e) { /* ignora chave corrompida */ }
    });
    if (migrou) {
      setAll._migrado_de_localStorage = new Date().toISOString();
      await dbSetMany(setAll);
    } else {
      // mesmo sem dados a migrar, marca a flag pra não ficar verificando toda hora
      await dbSet("_migrado_de_localStorage", new Date().toISOString());
    }
    return migrou;
  } catch (e) {
    console.warn("Migração localStorage→IDB falhou:", e);
    return false;
  }
}

window.openDB = openDB;
window.dbGet = dbGet;
window.dbSet = dbSet;
window.dbGetAll = dbGetAll;
window.dbSetMany = dbSetMany;
window.dbClear = dbClear;
window.migrarLocalStorageSeNecessario = migrarLocalStorageSeNecessario;
