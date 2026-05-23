/**
 * EPIMELEIA V3.4 — Oracle Node · blockchain.js
 * ─────────────────────────────────────────────
 * Toda la interacción con los contratos del protocolo.
 * Expone funciones limpias para que scheduler.js no toque ethers directamente.
 */

const { ethers }       = require('ethers');
const { config }       = require('./config');
const { log }          = require('./logger');

// ─── ABIs mínimos por contrato ──────────────────────────────────

const ABI_CORE = [
  // Lectura
  "function getTotalActivos() external view returns (uint256)",
  "function getListaActivoIds() external view returns (uint256[])",
  "function getDatosOracle(uint256 activoId) external view returns (bool, uint8, uint8, int256, int256, uint256, address)",
  "function getBadgePublico(uint256 activoId) external view returns (string, string, uint8, bool, uint256)",
  "function modoTest() external view returns (bool)",
  "function getPeriodoBilling() external view returns (uint256)",
  "function getVentanaSatelital() external view returns (uint256)",
  // Eventos para escucha
  "event ActivoRegistrado(uint256 indexed activoId, address indexed wallet, string nombre, uint8 tipo, uint8 nivel, uint256 timestamp)",
  "event SelloExcelencia(uint256 indexed activoId, address indexed owner, string nombre, bytes32 selloHash, uint256 timestamp)",
  "event BajaMALUSO(uint256 indexed activoId, address indexed wallet, string motivo, uint256 timestamp)",
];

const ABI_CERT = [
  "function certificarQ(uint256 activoId, bytes32 hashEvidencia, string metadataURI, uint256 trimestre, string satelite, string bandaEspectral, uint16 nubosidadPct, string urlDescarga, string uuid) external",
  "function registrarHuecoOpacidad(uint256 activoId, uint256 diaInicio, uint256 diaFin, string causa, bool esCausaClimatica) external",
  "function registrarEvidenciaVentana(uint256 activoId, uint256 trimestre, bytes32 hashEvidencia, string satelite, uint16 nubosidadPct, string urlDescarga) external",
  "function getCertificaciones(uint256 activoId) external view returns (tuple(uint256,uint256,bytes32,address,uint8,uint8,string,bool,string,string,uint16,string,string)[])",
  "function getHuecos(uint256 activoId) external view returns (tuple(uint256,uint256,uint256,string,bool)[])",
  "function getIndiceContinuidad(uint256 activoId) external view returns (uint256)",
  "event CertificacionRealizada(uint256 indexed activoId, bytes32 hashEvidencia, uint256 trimestre, string satelite, uint16 nubosidadPct, uint256 timestamp)",
  "event HuecoOpacidadRegistrado(uint256 indexed activoId, string causa, bool esCausaClimatica, uint256 timestamp)",
];

const ABI_BILLING = [
  "function getEstadoBilling(uint256 activoId) external view returns (uint256, uint256, uint256, bool, uint256, bool)",
  "function getSaldo(uint256 activoId) external view returns (uint256)",
  "function getProximosVencimientos(uint256 activoId) external view returns (uint256, uint256)",
  "event ReporteTrimestralTrigger(uint256 indexed activoId, address indexed owner, uint256 trimestre, uint256 timestamp)",
  "event AlertaSaldoBajo(uint256 indexed activoId, address indexed owner, uint256 saldoActual, uint256 feeRequerido, uint256 diasRestantes, uint256 timestamp)",
];

// ─── Provider y signer ─────────────────────────────────────────

let provider, oracleWallet, contratoCore, contratoCert, contratoBilling;

function inicializarBlockchain() {
  provider     = new ethers.JsonRpcProvider(config.red.rpc);
  oracleWallet = new ethers.Wallet(config.oracle.privateKey, provider);

  contratoCore    = new ethers.Contract(config.contratos.core,    ABI_CORE,    oracleWallet);
  contratoCert    = new ethers.Contract(config.contratos.cert,    ABI_CERT,    oracleWallet);
  contratoBilling = new ethers.Contract(config.contratos.billing, ABI_BILLING, oracleWallet);

  log('BLOCKCHAIN', `Contratos inicializados`, {
    core:    config.contratos.core,
    cert:    config.contratos.cert,
    billing: config.contratos.billing,
  });
}

// ─── Lectura de activos ────────────────────────────────────────

/**
 * Retorna la lista completa de IDs de activos activos en el protocolo.
 */
async function getListaActivos() {
  const ids = await contratoCore.getListaActivoIds();
  return ids.map(id => Number(id));
}

/**
 * Retorna los datos necesarios para el oracle de un activo específico.
 */
async function getDatosActivo(activoId) {
  const [activo, nivel, tipo, latRaw, lngRaw, radioKm, owner] =
    await contratoCore.getDatosOracle(activoId);

  if (!activo) return null;

  return {
    activoId,
    activo,
    nivel:     Number(nivel),
    tipo:      Number(tipo),
    latitud:   Number(latRaw)  / 1e6,
    longitud:  Number(lngRaw)  / 1e6,
    radioKm:   Number(radioKm),
    owner,
  };
}

/**
 * Retorna el estado de billing de un activo.
 */
async function getEstadoBilling(activoId) {
  const [saldo, ultimoBilling, proximoBilling, enGracia, feeProximo, alertaActiva] =
    await contratoBilling.getEstadoBilling(activoId);
  return {
    saldo:         ethers.formatEther(saldo),
    saldoWei:      saldo,
    ultimoBilling: Number(ultimoBilling),
    proximoBilling:Number(proximoBilling),
    enGracia,
    feeProximo:    ethers.formatEther(feeProximo),
    alertaActiva,
  };
}

// ─── Certificación ────────────────────────────────────────────

/**
 * Graba una certificación Q en blockchain.
 */
async function certificarEnChain(params) {
  const {
    activoId, hashEvidencia, metadataURI, trimestre,
    satelite, bandaEspectral, nubosidadPct,
    urlDescarga, uuid
  } = params;

  log('CERT', `Certificando en Polygon`, { activoId, trimestre, satelite });

  const tx = await contratoCert.certificarQ(
    activoId,
    hashEvidencia,
    metadataURI,
    trimestre,
    satelite,
    bandaEspectral,
    nubosidadPct,
    urlDescarga,
    uuid,
    { gasLimit: config.gas.certificar }
  );

  const receipt = await tx.wait();
  log('CERT', `Certificación confirmada`, {
    activoId,
    txHash:  receipt.hash,
    bloque:  receipt.blockNumber,
    trimestre,
  });

  return receipt;
}

/**
 * Registra evidencia de ventana de 15 días — Ajuste 7.
 */
async function registrarEvidenciaVentana(params) {
  const { activoId, trimestre, hashEvidencia, satelite, nubosidadPct, urlDescarga } = params;

  const tx = await contratoCert.registrarEvidenciaVentana(
    activoId, trimestre, hashEvidencia, satelite, nubosidadPct, urlDescarga,
    { gasLimit: config.gas.certificar }
  );

  const receipt = await tx.wait();
  log('VENTANA', `Evidencia de ventana grabada`, { activoId, trimestre, txHash: receipt.hash });
  return receipt;
}

/**
 * Registra un Hueco de Opacidad en blockchain.
 * @param causaClimatica true si la causa es meteorológica (nubosidad).
 */
async function registrarHueco(activoId, causa, causaClimatica = false) {
  const diaActual = Math.floor(Date.now() / 1000 / 86400);

  log('HUECO', `Registrando Hueco de Opacidad`, { activoId, causa, causaClimatica });

  const tx = await contratoCert.registrarHuecoOpacidad(
    activoId,
    diaActual,
    diaActual,
    causa,
    causaClimatica,
    { gasLimit: config.gas.hueco }
  );

  const receipt = await tx.wait();
  log('HUECO', `Hueco grabado — inalterable`, { activoId, txHash: receipt.hash });
  return receipt;
}

// ─── Escucha de eventos para reportes trimestrales (Ajuste 21) ──

/**
 * Escucha el evento ReporteTrimestralTrigger y dispara el reporte por email.
 */
function escucharReportesTrimestrales(onTrigger) {
  contratoBilling.on('ReporteTrimestralTrigger', (activoId, owner, trimestre, timestamp) => {
    log('EMAIL', `Trigger reporte trimestral`, { activoId: Number(activoId), owner, trimestre: Number(trimestre) });
    onTrigger({ activoId: Number(activoId), owner, trimestre: Number(trimestre), timestamp: Number(timestamp) });
  });
}

/**
 * Escucha alertas de saldo bajo para notificar a la empresa — Ajuste 5.
 */
function escucharAlertasSaldo(onAlerta) {
  contratoBilling.on('AlertaSaldoBajo', (activoId, owner, saldo, fee, diasRestantes) => {
    log('ALERTA', `Saldo bajo detectado`, { activoId: Number(activoId), owner, diasRestantes: Number(diasRestantes) });
    onAlerta({ activoId: Number(activoId), owner, saldo, fee, diasRestantes: Number(diasRestantes) });
  });
}

// ─── Info de red ───────────────────────────────────────────────

async function getInfoRed() {
  const network = await provider.getNetwork();
  const balance = await provider.getBalance(oracleWallet.address);
  const total   = await contratoCore.getTotalActivos();

  return {
    chainId:        Number(network.chainId),
    nombre:         network.name,
    oracleAddress:  oracleWallet.address,
    balancePOL:     ethers.formatEther(balance),
    totalActivos:   Number(total),
  };
}

module.exports = {
  inicializarBlockchain,
  getListaActivos,
  getDatosActivo,
  getEstadoBilling,
  certificarEnChain,
  registrarEvidenciaVentana,
  registrarHueco,
  escucharReportesTrimestrales,
  escucharAlertasSaldo,
  getInfoRed,
  get provider() { return provider; },
  get oracleWallet() { return oracleWallet; },
};
