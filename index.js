/**
 * EPIMELEIA V3.4 — Oracle Node · index.js
 * ─────────────────────────────────────────
 * Punto de entrada. Inicia todo el sistema y lo deja corriendo.
 *
 * Uso:
 *   node index.js              → modo normal
 *   node index.js --test-cert  → fuerza una ventana satelital inmediata (test)
 *
 * Requiere:
 *   npm install ethers axios dotenv node-cron
 */

const { config, validarConfig } = require('./config');
const { log }                   = require('./logger');
const blockchain                = require('./blockchain');
const scheduler                 = require('./scheduler');
const reports                   = require('./reports');

async function iniciar() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           EPIMELEIA V3.4 — Oracle Node                       ║');
  console.log('║     Notario Digital de Conducta Ambiental Corporativa        ║');
  console.log('║     Primera certificación: Hidrovía Paraná-Paraguay          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  // ── Validar configuración ────────────────────────────────────
  const erroresConfig = validarConfig();
  if (erroresConfig.length > 0) {
    erroresConfig.forEach(e => log('ERROR', `Config: ${e}`));
    log('FATAL', 'Configuración incompleta. Revisá el archivo .env');
    process.exit(1);
  }

  log('SYSTEM', `Modo: ${config.modoTest ? 'TEST (valores simbólicos)' : 'PRODUCCIÓN'}`);

  // ── Inicializar conexión blockchain ──────────────────────────
  try {
    blockchain.inicializarBlockchain();
    const info = await blockchain.getInfoRed();

    log('SYSTEM', `Red: ${info.nombre} (chainId: ${info.chainId})`);
    log('SYSTEM', `Oracle wallet: ${info.oracleAddress}`);
    log('SYSTEM', `Balance POL: ${info.balancePOL}`);
    log('SYSTEM', `Activos registrados: ${info.totalActivos}`);
    log('SYSTEM', `Trimestre actual: Q${scheduler.trimestreActual() % 10}/${Math.floor(scheduler.trimestreActual() / 10)}`);

    if (parseFloat(info.balancePOL) < 0.01 && !config.modoTest) {
      log('WARN', `Balance bajo en oracle wallet. Recargá POL para gas.`);
    }

  } catch (err) {
    log('FATAL', `Error conectando a Polygon: ${err.message}`);
    process.exit(1);
  }

  // ── Iniciar escucha de eventos ───────────────────────────────
  scheduler.iniciarEscuchaEventos();

  // ── Iniciar schedulers cron ──────────────────────────────────
  scheduler.iniciarSchedulers();

  // ── Si se pasa --test-cert, correr ventana inmediatamente ────
  if (process.argv.includes('--test-cert')) {
    log('SYSTEM', `Flag --test-cert detectado. Ejecutando ventana satelital de prueba...`);
    await scheduler.procesarVentanaSatelital();
  }

  // ── Notificar arranque al admin ──────────────────────────────
  await reports.notificarAdmin('ORACLE_INICIADO', {
    version:    '3.4',
    modoTest:   config.modoTest,
    timestamp:  new Date().toISOString(),
  });

  log('SYSTEM', `══ ORACLE EPIMELEIA V3.4 ACTIVO ══`);
  log('SYSTEM', `Escuchando eventos · Ventanas satelitales programadas`);
  log('SYSTEM', `Primer certificado: Hidrovía Paraná-Paraguay`);
  console.log('');
}

// ── Manejo de errores no capturados ─────────────────────────────
process.on('uncaughtException', async (err) => {
  log('FATAL', `Error no capturado: ${err.message}`);
  await reports.notificarAdmin('ORACLE_CRASH', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  log('ERROR', `Promise rechazada: ${reason}`);
  await reports.notificarAdmin('ORACLE_REJECTION', { reason: String(reason) });
});

process.on('SIGTERM', () => {
  log('SYSTEM', 'SIGTERM recibido. Cerrando oracle ordenadamente...');
  process.exit(0);
});

// ── Arrancar ────────────────────────────────────────────────────
iniciar().catch(err => {
  log('FATAL', `Error crítico en arranque: ${err.message}`);
  process.exit(1);
});

// ── Exports para testing ────────────────────────────────────────
module.exports = { scheduler, blockchain, reports };
