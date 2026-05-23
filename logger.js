/**
 * EPIMELEIA V3.4 — Oracle Node · logger.js
 * ─────────────────────────────────────────
 * Logger centralizado con timestamp y formato corporativo.
 */

function log(tipo, msg, data = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] [EPIMELEIA-V3.4] [${tipo.padEnd(10)}] ${msg}${extra}`);
}

module.exports = { log };
