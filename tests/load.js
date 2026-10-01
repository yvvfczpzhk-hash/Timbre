'use strict';
// Charge les modules « purs » de TIMBRE (analyse, modèle, catalogue, état, planification, import)
// directement depuis index.html, sans navigateur : ce sont exactement ceux que l'app exécute.
const fs = require('fs'), path = require('path'), vm = require('vm');

function loadTimbre() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('/* ==== audio.js ==== */');
  if (start < 8 || end < 0) throw new Error('index.html : script introuvable');
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  vm.runInContext(html.slice(start, end), ctx, { filename: 'index.html' });
  return ctx.TB;
}
module.exports = { loadTimbre };
