/**
 * EPIMELEIA V3.4 — Oracle Node · scheduler.js
 * ─────────────────────────────────────────────
 * Cerebro del oracle: coordina ventanas satelitales, multi-activo,
 * reportes trimestrales y alertas. Completamente autónomo — Ajuste 8.
 */

const cron       = require('node-cron');
const { config } = require('./config');
const { log }    = require('./logger');
const blockchain = require('./blockchain');
const satellite  = require('./satellite');
const reports    = require('./reports');
const { ethers } = require('ethers');

// ─── Trimestre actual ───────────────────────────────────────────

function trimestreActual() {
  const ahora = new Date();
  const año   = ahora.getFullYear();
  const q     = Math.floor(ahora.getMonth() / 3) + 1;
  return año * 10 + q; // ej: 20241, 20242, 20243, 20244
}

// ─── Proceso de ventana satelital (PV-L1) ──────────────────────

/**
 * Procesa todos los activos activos en una ventana de 15 días.
 * Por cada activo:
 *   1. Consulta Sentinel/Copernicus
 *   2. Si nubosidad OK → certifica en blockchain
 *   3. Si nubosidad alta → registra Hueco Climático (Ajuste 1)
 *   4. Si sin señal → registra Hueco SATELLITE_LOSS
 */
async function procesarVentanaSatelital() {
  const trimestre = trimestreActual();
  log('SCHEDULER', `══ VENTANA SATELITAL Q${trimestre % 10}/${Math.floor(trimestre / 10)} ══`);

  let ids;
  try {
    ids = await blockchain.getListaActivos();
    log('SCHEDULER', `Activos a procesar: ${ids.length}`);
  } catch (err) {
    log('ERROR', `No se pudo obtener lista de activos: ${err.message}`);
    await reports.notificarAdmin('ERROR_LISTA_ACTIVOS', { error: err.message });
    return;
  }

  let certificados = 0, huecos = 0, omitidos = 0;

  for (const activoId of ids) {
    try {
      await _procesarActivoL1(activoId, trimestre);

      // Pausa entre activos para no saturar el RPC
      await _pausa(config.pausas.entreActivos);

      certificados++;
    } catch (err) {
      log('ERROR', `Error procesando activo ${activoId}: ${err.message}`);
      await reports.notificarAdmin('ERROR_ACTIVO', { activoId, error: err.message });

      // Reintento con backoff
      let reintentos = 0;
      while (reintentos < config.pausas.maxReintentos) {
        await _pausa(config.pausas.reintento * (reintentos + 1));
        try {
          await _procesarActivoL1(activoId, trimestre);
          certificados++;
          break;
        } catch (e) {
          reintentos++;
          log('WARN', `Reintento ${reintentos}/${config.pausas.maxReintentos} para activo ${activoId}`);
        }
      }
      if (reintentos === config.pausas.maxReintentos) {
        huecos++;
        log('ERROR', `Activo ${activoId} no procesado después de ${reintentos} reintentos`);
      }
    }
  }

  log('SCHEDULER', `══ VENTANA COMPLETADA ══`, {
    trimestre, certificados, huecos, omitidos,
    totalActivos: ids.length
  });

  await reports.notificarAdmin('VENTANA_SATELITAL_COMPLETADA', {
    trimestre, certificados, huecos, totalActivos: ids.length,
    timestamp: new Date().toISOString()
  });
}

/**
 * Procesa un activo individual en la ventana PV-L1.
 */
async function _procesarActivoL1(activoId, trimestre) {
  // Obtener datos del activo desde blockchain
  const datos = await blockchain.getDatosActivo(activoId);
  if (!datos || !datos.activo) {
    log('INFO', `Activo ${activoId} inactivo, omitiendo`);
    return;
  }

  // Solo procesar L1 automáticamente (L2 y L3 requieren acuerdo previo)
  if (datos.nivel !== 0) {
    log('INFO', `Activo ${activoId} es L${datos.nivel + 1} — requiere acuerdo previo`);
    await reports.notificarAdmin('ACTIVO_BAJO_ACUERDO', {
      activoId, nivel: `L${datos.nivel + 1}`, trimestre
    });
    return;
  }

  log('L1', `Procesando activo ${activoId}`, {
    tipo: config.indicadoresPorTipo[datos.tipo]?.nombre || 'OTRO',
    lat: datos.latitud, lng: datos.longitud
  });

  // Consultar Sentinel
  const reporte = await satellite.consultarSentinel(datos);

  // Evaluar si se puede certificar (Ajuste 1: umbral nubosidad)
  const evaluacion = satellite.evaluarNubosidad(reporte);

  if (!evaluacion.puedeCertificar) {
    // Registrar Hueco de Opacidad
    await blockchain.registrarHueco(
      activoId,
      evaluacion.causa,
      evaluacion.esClimatica || false
    );
    log('HUECO', `Activo ${activoId}: ${evaluacion.causa}`);
    return;
  }

  // Certificar en blockchain
  const hashEvidencia = satellite.generarHashEvidencia(reporte);
  const metadataURI   = satellite.generarMetadataURI(reporte, trimestre);

  await blockchain.certificarEnChain({
    activoId,
    hashEvidencia,
    metadataURI,
    trimestre,
    satelite:      reporte.satelite,
    bandaEspectral:reporte.bandaEspectral,
    nubosidadPct:  reporte.nubosidadPct,
    urlDescarga:   reporte.urlDescargaDatos,
    uuid:          reporte.uuid,
  });

  // Si hay evidencia adicional de ventana, registrarla también (Ajuste 7)
  await blockchain.registrarEvidenciaVentana({
    activoId,
    trimestre,
    hashEvidencia,
    satelite:      reporte.satelite,
    nubosidadPct:  reporte.nubosidadPct,
    urlDescarga:   reporte.urlDescargaDatos,
  });

  await reports.notificarAdmin('CERT_TRIMESTRAL_CONFIRMADA', {
    activoId,
    trimestre,
    satelite:   reporte.satelite,
    nubosidad:  reporte.nubosidadPct,
    timestamp:  new Date().toISOString(),
  });
}

// ─── Escucha de eventos blockchain ─────────────────────────────

/**
 * Escucha ReporteTrimestralTrigger para despachar reportes por email — Ajuste 21.
 */
function iniciarEscuchaEventos() {
  blockchain.escucharReportesTrimestrales(async ({ activoId, owner, trimestre }) => {
    try {
      log('EMAIL', `Preparando reporte trimestral`, { activoId, trimestre });

      // En producción, aquí se obtiene el email del activo desde un registro externo
      // (el email no se guarda on-chain por privacidad, solo el hash)
      const emailDestino = process.env[`EMAIL_ACTIVO_${activoId}`] || process.env.ADMIN_EMAIL || '';

      if (!emailDestino) {
        log('WARN', `Email no configurado para activo ${activoId}`);
        return;
      }

      const datos = await blockchain.getDatosActivo(activoId);
      const billing = await blockchain.getEstadoBilling(activoId);

      await reports.enviarReporteTrimestral({
        activoId,
        owner,
        trimestre,
        datosBilling:  billing,
        certs:         [],      // se obtendría del contrato cert
        huecos:        [],
        indiceCont:    0,
        emailDestino,
        nombreActivo:  datos?.nombre || `Activo ${activoId}`,
      });
    } catch (err) {
      log('ERROR', `Error enviando reporte trimestral activo ${activoId}: ${err.message}`);
    }
  });

  blockchain.escucharAlertasSaldo(async ({ activoId, owner, diasRestantes }) => {
    const emailDestino = process.env[`EMAIL_ACTIVO_${activoId}`] || process.env.ADMIN_EMAIL || '';
    if (!emailDestino) return;

    const billing = await blockchain.getEstadoBilling(activoId);
    const datos   = await blockchain.getDatosActivo(activoId);

    await reports.enviarAlertaSaldo({
      activoId, owner,
      emailDestino,
      nombreActivo:  datos?.nombre || `Activo ${activoId}`,
      saldoPOL:      billing.saldo,
      feeProximo:    billing.feeProximo,
      diasRestantes,
    });
  });

  log('SCHEDULER', `Escucha de eventos activada (reportes, alertas)`);
}

// ─── Schedulers cron ───────────────────────────────────────────

function iniciarSchedulers() {
  const schedVentana    = config.modoTest ? config.cron.testVentana     : config.cron.ventanaSatelital;
  const schedContinuidad = config.modoTest ? config.cron.testContinuidad : config.cron.continuidad;

  // Ventana satelital (cada 15 días en prod / cada minuto en test)
  cron.schedule(schedVentana, () => {
    log('CRON', `Job: Ventana satelital Q${trimestreActual() % 10}`);
    procesarVentanaSatelital().catch(err =>
      log('ERROR', `Error en ventana: ${err.message}`)
    );
  });

  // Healthcheck cada hora
  cron.schedule(config.cron.healthcheck, async () => {
    try {
      const info = await blockchain.getInfoRed();
      log('HEALTH', `Oracle activo`, info);
    } catch (err) {
      log('ERROR', `Healthcheck fallido: ${err.message}`);
      await reports.notificarAdmin('ORACLE_HEALTH_ERROR', { error: err.message });
    }
  });

  log('SCHEDULER', `Schedulers iniciados`, {
    modoTest:  config.modoTest,
    ventana:   schedVentana,
    healthcheck: config.cron.healthcheck,
  });
}

// ─── Helper ────────────────────────────────────────────────────

function _pausa(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  trimestreActual,
  procesarVentanaSatelital,
  iniciarSchedulers,
  iniciarEscuchaEventos,
};
