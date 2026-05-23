/**
 * EPIMELEIA V3.4 — Oracle Node · config.js
 * ─────────────────────────────────────────
 * Fuente única de verdad para toda la configuración.
 * En producción, todas las variables sensibles vienen de .env
 *
 * .env requerido:
 *   ORACLE_PRIVATE_KEY=0x...
 *   CORE_ADDRESS=0x...
 *   CERT_ADDRESS=0x...
 *   BILLING_ADDRESS=0x...
 *   ORACLE_CONTRACT_ADDRESS=0x...
 *   POLYGON_RPC=https://polygon-rpc.com
 *   SENTINEL_API_USER=...
 *   SENTINEL_API_KEY=...
 *   WEBHOOK_URL=https://...
 *   SENDGRID_API_KEY=...         (para reportes por email)
 *   SENDGRID_FROM=oracle@epimeleia.world
 *   MODO_TEST=true               (false en producción)
 */

require('dotenv').config();

const config = {

  // ── Red ────────────────────────────────────────────
  red: {
    rpc:     process.env.POLYGON_RPC     || 'https://polygon-rpc.com',
    chainId: 137,
    nombre:  'Polygon Mainnet',
  },

  // ── Contratos V3.4 ────────────────────────────────
  contratos: {
    core:    process.env.CORE_ADDRESS            || '',
    cert:    process.env.CERT_ADDRESS            || '',
    billing: process.env.BILLING_ADDRESS         || '',
    oracle:  process.env.ORACLE_CONTRACT_ADDRESS || '',
  },

  // ── Oracle wallet ─────────────────────────────────
  oracle: {
    privateKey: process.env.ORACLE_PRIVATE_KEY || '',
  },

  // ── Sentinel / Copernicus PV-L1 ───────────────────
  sentinel: {
    apiUser:    process.env.SENTINEL_API_USER || 'epimeleia_oracle',
    apiKey:     process.env.SENTINEL_API_KEY  || '',
    baseUrl:    'https://scihub.copernicus.eu/dhus/search',
    timeout:    15000,
    // Umbral de nubosidad: si supera este %, no se puede certificar (Ajuste 1)
    umbralNubosidad: 70,
  },

  // ── Modo Test vs Producción (Ajuste 15) ───────────
  modoTest: process.env.MODO_TEST === 'true' || process.env.MODO_TEST === '1',

  // Períodos en modo test (segundos) vs producción (días)
  periodos: {
    billing:       process.env.MODO_TEST === 'true' ? 60     : 90 * 24 * 3600,
    ventana:       process.env.MODO_TEST === 'true' ? 10     : 15 * 24 * 3600,
    gracia:        process.env.MODO_TEST === 'true' ? 30     :  7 * 24 * 3600,
    continuidad:   process.env.MODO_TEST === 'true' ? 20     : 24 * 3600,
  },

  // ── Notificaciones ────────────────────────────────
  notificaciones: {
    webhookUrl:      process.env.WEBHOOK_URL        || '',
    sendgridKey:     process.env.SENDGRID_API_KEY   || '',
    sendgridFrom:    process.env.SENDGRID_FROM      || 'oracle@epimeleia.world',
    timeoutWebhook:  8000,
  },

  // ── Gas settings ──────────────────────────────────
  gas: {
    certificar:     300000,
    hueco:          200000,
    continuidad:    80000,
    transferencia:  150000,
  },

  // ── Indicadores satelitales por tipo de actividad ─
  // El tipo declarado por el activo determina qué bandas analiza el oráculo
  indicadoresPorTipo: {
    0: { nombre: 'MINERIA',     bandas: 'B11 SWIR/B04 RED',        indicadores: ['expansion_area', 'sedimentos_agua', 'cobertura_vegetal'] },
    1: { nombre: 'FORESTAL',    bandas: 'B04/B08 NDVI',            indicadores: ['ndvi', 'cobertura_vegetal', 'deforestacion'] },
    2: { nombre: 'NAVAL',       bandas: 'B03 GREEN/B11 SWIR',      indicadores: ['area_portuaria', 'temperatura_superficial', 'turbidez_agua'] },
    3: { nombre: 'INDUSTRIAL',  bandas: 'B11 SWIR/B12 SWIR2',      indicadores: ['temperatura_superficial', 'emisiones', 'expansion_area'] },
    4: { nombre: 'DATA_CENTER', bandas: 'B11 SWIR/B10 CIRRUS',     indicadores: ['temperatura_superficial', 'consumo_energetico', 'area_construccion'] },
    5: { nombre: 'RESIDUOS',    bandas: 'B11 SWIR/B09 NIR',        indicadores: ['expansion_area', 'lixiviados', 'temperatura_superficial'] },
    6: { nombre: 'HIDROVIA',    bandas: 'B03 GREEN/B04 RED/B08 NIR',indicadores: ['nivel_hidrico', 'turbidez_agua', 'sedimentos', 'cobertura_vegetal'] },
    7: { nombre: 'OTRO',        bandas: 'B04/B08 NDVI',            indicadores: ['cobertura_vegetal', 'temperatura_superficial'] },
  },

  // ── Cron schedules ────────────────────────────────
  cron: {
    // Ventana satelital cada 15 días: días 1 y 15 de cada mes a las 06:00 UTC
    ventanaSatelital:   '0 6 1,15 * *',
    // Continuidad: diaria a medianoche UTC
    continuidad:        '0 0 * * *',
    // Verificación de estado: cada hora
    healthcheck:        '0 * * * *',
    // Modo test: cada minuto para todas las tareas
    testVentana:        '* * * * *',
    testContinuidad:    '*/2 * * * *',
  },

  // ── Pausas entre operaciones (ms) ─────────────────
  pausas: {
    entreActivos:  2000,
    reintento:     5000,
    maxReintentos: 3,
  },

};

// Validación mínima en arranque
function validarConfig() {
  const errores = [];
  if (!config.oracle.privateKey)       errores.push('ORACLE_PRIVATE_KEY no definida');
  if (!config.contratos.core)          errores.push('CORE_ADDRESS no definida');
  if (!config.contratos.cert)          errores.push('CERT_ADDRESS no definida');
  if (!config.contratos.billing)       errores.push('BILLING_ADDRESS no definida');
  if (!config.contratos.oracle)        errores.push('ORACLE_CONTRACT_ADDRESS no definida');
  if (!config.sentinel.apiKey && !config.modoTest) errores.push('SENTINEL_API_KEY no definida (requerida en producción)');
  return errores;
}

module.exports = { config, validarConfig };
