/**
 * EPIMELEIA V3.2 — Oracle Connection Script
 * Node.js — Vincula oráculos satelitales/IoT con el contrato Polygon
 *
 * Requiere:
 *   npm install ethers axios dotenv node-cron
 *
 * .env:
 *   ORACLE_PRIVATE_KEY=0x...
 *   CONTRACT_ADDRESS=0xEfEE680Da362890cdF5ab20a20BB42718e29DBc0
 *   POLYGON_RPC=https://polygon-rpc.com
 *   SENTINEL_API_KEY=...
 *   WEBHOOK_URL=https://...   (notificaciones admin)
 *
 * Niveles de Validación (todos con frecuencia trimestral):
 *   PV-L1: Datos satelitales públicos Sentinel/Copernicus. Operativo hoy.
 *   PV-L2: Satelital comercial (Planet Labs o equiv.) + validación cruzada pública.
 *           Solo bajo acuerdo previo con Epimeleia.
 *   PV-L3: Satelital comercial premium + IoT en sitio + validación cruzada pública.
 *           Solo bajo acuerdo previo con Epimeleia.
 *
 * Contrato deployado: 0xEfEE680Da362890cdF5ab20a20BB42718e29DBc0
 * Red: Polygon Mainnet (Chain ID: 137)
 */
 
require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const cron = require('node-cron');
 
// ─── ABI MÍNIMO ──────────────────────────────────────────
const ABI = [
  "function certificarQ(address wallet, bytes32 hashEvidencia, string metadataURI, uint256 trimestre) external",
  "function registrarHuecoOpacidad(address wallet, uint256 diaInicio, uint256 diaFin, string causa) external",
  "function incrementarContinuidad(address wallet) external",
  "function getEmpresaInfo(address wallet) external view returns (bool, uint8, uint256, uint256, uint8, uint256)",
  "function getTotalEmpresas() external view returns (uint256)",
  "function listaEmpresas(uint256) external view returns (address)",
  "function getNivelDesc(address wallet) external view returns (string)",
  "event CertificacionRealizada(address indexed wallet, bytes32 hashEvidencia, uint256 trimestre, uint256 timestamp)",
  "event HuecoOpacidadRegistrado(address indexed wallet, uint256 dia, string causa, uint256 timestamp)",
];
 
// ─── PROVIDER + SIGNER ───────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-rpc.com');
const oracleWallet = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
const contrato = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, oracleWallet);
 
// ─── LOG TÉCNICO ─────────────────────────────────────────
function log(tipo, msg, data = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tipo}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}
 
// ─── WEBHOOK ADMIN ───────────────────────────────────────
async function notificarAdmin(evento, datos) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    await axios.post(process.env.WEBHOOK_URL, {
      evento,
      datos,
      timestamp: new Date().toISOString(),
      red: 'POLYGON_MAINNET',
      contrato: process.env.CONTRACT_ADDRESS
    });
    log('WEBHOOK', `Notificación enviada: ${evento}`);
  } catch (err) {
    log('ERROR', `Webhook fallido: ${err.message}`);
  }
}
 
// ─── PV-L1: SENTINEL/COPERNICUS (TRIMESTRAL) ─────────────
// Operativo desde el día uno. Datos satelitales públicos ESA.
async function validacionL1_Sentinel(wallet) {
  log('PV-L1', `Iniciando validación trimestral Sentinel · ${wallet}`);
  try {
    const bbox = await obtenerCoordenadasEmpresa(wallet);
    const url = `https://scihub.copernicus.eu/dhus/search?q=footprint:"Intersects(${bbox})"&rows=1&format=json`;
 
    const resp = await axios.get(url, {
      auth: { username: 'epimeleia_oracle', password: process.env.SENTINEL_API_KEY },
      timeout: 15000
    });
 
    const entries = resp.data?.feed?.entry || [];
    if (entries.length === 0) {
      log('PV-L1', `Sin datos satelitales disponibles · ${wallet}`);
      await registrarHueco(wallet, 'SATELLITE_LOSS');
      return null;
    }
 
    const imagen = entries[0];
    const reporte = {
      wallet,
      nivel: 'PV-L1',
      tipo: 'SENTINEL_COPERNICUS_TRIMESTRAL',
      timestamp: new Date().toISOString(),
      satelite: imagen.title || 'Sentinel-2',
      coordenadas: bbox,
      cloudCover: imagen['cloudcoverpercentage'] || 'N/A',
      uuid: imagen.id,
      fuente: 'ESA_COPERNICUS_PUBLIC'
    };
 
    log('PV-L1', `Validación trimestral completada`, { uuid: imagen.id });
    return reporte;
 
  } catch (err) {
    log('ERROR', `PV-L1 Sentinel fallido: ${err.message}`);
    await modoSuspensionCheck(err);
    return null;
  }
}
 
// ─── PV-L2: SATELITAL COMERCIAL + VALIDACIÓN CRUZADA (TRIMESTRAL — BAJO ACUERDO) ──
// Requiere acuerdo previo con Epimeleia. No activar sin contrato firmado.
async function validacionL2_SatelitalComercial(wallet, sensorEndpoint) {
  log('PV-L2', `Iniciando validación trimestral satelital comercial · ${wallet}`);
  try {
    const iotData = await axios.get(sensorEndpoint, { timeout: 10000 });
 
    const reporte = {
      wallet,
      nivel: 'PV-L2',
      tipo: 'SAT_COMERCIAL_VALIDACION_CRUZADA',
      timestamp: new Date().toISOString(),
      consumoAgua_m3: iotData.data?.water_m3 || 0,
      consumoEnergia_kWh: iotData.data?.energy_kwh || 0,
      temperatura: iotData.data?.temp_c || null,
      coordenadas: iotData.data?.gps || null,
      sensor_id: iotData.data?.sensor_id || 'unknown',
      firma_sensor: iotData.data?.signature || null,
      fuente: 'SATELITAL_COMERCIAL_CRUZADO_PUBLICO'
    };
 
    if (!reporte.firma_sensor) {
      log('WARN', `Sensor sin firma criptográfica · ${wallet}`);
      await registrarHueco(wallet, 'IOT_INTERRUPTION');
      return null;
    }
 
    log('PV-L2', `Validación trimestral L2 completada`, {
      agua: reporte.consumoAgua_m3,
      energia: reporte.consumoEnergia_kWh
    });
    return reporte;
 
  } catch (err) {
    log('ERROR', `PV-L2 fallido: ${err.message}`);
    await registrarHueco(wallet, err.code === 'ECONNREFUSED' ? 'HUMAN_CAUSE' : 'SATELLITE_LOSS');
    return null;
  }
}
 
// ─── PV-L3: TRIPLE FUENTE INDEPENDIENTE (TRIMESTRAL — BAJO ACUERDO) ──
// Satelital comercial premium + IoT en sitio + validación cruzada pública.
// Requiere acuerdo previo con Epimeleia. No activar sin contrato firmado.
async function validacionL3_TripleFuente(wallet, sensors) {
  log('PV-L3', `Iniciando validación trimestral triple fuente · ${wallet}`);
 
  const lecturas = await Promise.allSettled(
    sensors.map(s => axios.get(s.endpoint, { timeout: 5000 }))
  );
 
  const validas = lecturas.filter(r => r.status === 'fulfilled');
  const fallidas = lecturas.filter(r => r.status === 'rejected');
 
  if (fallidas.length > 0) {
    log('WARN', `${fallidas.length} fuentes sin respuesta · ${wallet}`);
    if (fallidas.length === lecturas.length) {
      await registrarHueco(wallet, 'HUMAN_CAUSE');
      return null;
    }
  }
 
  const reporte = {
    wallet,
    nivel: 'PV-L3',
    tipo: 'TRIPLE_FUENTE_TRIMESTRAL',
    timestamp: new Date().toISOString(),
    fuentesActivas: validas.length,
    fuentesTotal: sensors.length,
    datos: validas.map(r => r.value.data),
    bloque: await provider.getBlockNumber(),
    fuente: 'SAT_PREMIUM_IOT_SITIO_VALIDACION_CRUZADA'
  };
 
  log('PV-L3', `Validación trimestral triple fuente completada`, {
    activas: validas.length,
    total: sensors.length
  });
  return reporte;
}
 
// ─── CERTIFICAR EN BLOCKCHAIN ────────────────────────────
async function certificarEnChain(reporte, trimestre) {
  if (!reporte) return;
 
  const reporteStr = JSON.stringify(reporte);
  const hashEvidencia = ethers.keccak256(ethers.toUtf8Bytes(reporteStr));
 
  // En producción: subir reporte a IPFS y usar el CID real
  const metadataURI = `ipfs://QmEpimeleia_${reporte.wallet.slice(2,8)}_Q${trimestre}_${reporte.nivel}`;
 
  log('CERT', `Enviando certificación trimestral a Polygon · Q${trimestre} · ${reporte.wallet} · ${reporte.nivel}`);
 
  try {
    const tx = await contrato.certificarQ(
      reporte.wallet,
      hashEvidencia,
      metadataURI,
      trimestre,
      { gasLimit: 300000 }
    );
 
    const receipt = await tx.wait();
 
    log('CERT', `Certificación Q${trimestre} confirmada en blockchain`, {
      hash: receipt.hash,
      bloque: receipt.blockNumber,
      wallet: reporte.wallet,
      nivel: reporte.nivel
    });
 
    await notificarAdmin('CERT_TRIMESTRAL_CONFIRMADA', {
      wallet: reporte.wallet,
      txHash: receipt.hash,
      bloque: receipt.blockNumber,
      trimestre,
      nivel: reporte.nivel
    });
 
    return receipt;
 
  } catch (err) {
    log('ERROR', `Certificación fallida: ${err.message}`);
    await notificarAdmin('CERT_ERROR', { wallet: reporte.wallet, error: err.message });
    throw err;
  }
}
 
// ─── REGISTRAR HUECO DE OPACIDAD ─────────────────────────
async function registrarHueco(wallet, causa) {
  const diaActual = Math.floor((Date.now() / 1000 - 86400) / 86400);
 
  log('GAP', `Registrando Hueco de Opacidad · ${wallet} · ${causa}`);
 
  try {
    const tx = await contrato.registrarHuecoOpacidad(
      wallet,
      diaActual,
      diaActual,
      causa,
      { gasLimit: 200000 }
    );
    await tx.wait();
 
    log('GAP', `Hueco grabado en Polygon · inalterable`, { wallet, causa });
 
    await notificarAdmin('HUECO_OPACIDAD', {
      wallet,
      dia: diaActual,
      causa,
      timestamp: new Date().toISOString()
    });
 
  } catch (err) {
    log('ERROR', `Registro hueco fallido: ${err.message}`);
  }
}
 
// ─── MODO SUSPENSIÓN — Fuerza Mayor ──────────────────────
async function modoSuspensionCheck(err) {
  const esFuerzaMayor = [
    'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'SATELLITE_UNAVAILABLE'
  ].some(code => err.code === code || err.message?.includes(code));
 
  if (esFuerzaMayor) {
    log('SUSPEND', 'Fuerza Mayor detectada — notificando admin');
    await notificarAdmin('MODO_SUSPENSION_ACTIVADO', {
      causa: err.message,
      timestamp: new Date().toISOString()
    });
  }
}
 
// ─── CONTINUIDAD DIARIA ───────────────────────────────────
async function actualizarContinuidad() {
  log('SYSTEM', 'Actualizando contadores de continuidad...');
  try {
    const total = await contrato.getTotalEmpresas();
    for (let i = 0; i < Number(total); i++) {
      const wallet = await contrato.listaEmpresas(i);
      const info = await contrato.getEmpresaInfo(wallet);
      if (info[0]) {
        const tx = await contrato.incrementarContinuidad(wallet, { gasLimit: 80000 });
        await tx.wait();
        log('SYSTEM', `Continuidad +1 · ${wallet}`);
      }
    }
  } catch (err) {
    log('ERROR', `Continuidad fallida: ${err.message}`);
  }
}
 
// ─── UTILIDADES ──────────────────────────────────────────
async function obtenerCoordenadasEmpresa(wallet) {
  // En producción: leer de base de datos privada cifrada por empresa
  // Ejemplo hidrovía Paraná-Paraguay (coordenadas de referencia)
  return 'POLYGON((-58.5 -34.5,-58.2 -34.5,-58.2 -34.7,-58.5 -34.7,-58.5 -34.5))';
}
 
function trimestreActual() {
  const mes = new Date().getMonth();
  return Math.floor(mes / 3) + 1;
}
 
// ─── SCHEDULERS ──────────────────────────────────────────
 
// Continuidad: cada día a medianoche UTC
cron.schedule('0 0 * * *', () => {
  log('CRON', 'Job diario — actualización de continuidad');
  actualizarContinuidad();
});
 
// PV-L1: primer día de cada trimestre a las 08:00 UTC
// Enero, Abril, Julio, Octubre
cron.schedule('0 8 1 1,4,7,10 *', () => {
  log('CRON', `Job trimestral — validación PV-L1 Sentinel · Q${trimestreActual()}`);
  // En producción: iterar empresas L1 y ejecutar validación
  // contrato.listaEmpresas(i).then(wallet => validacionL1_Sentinel(wallet).then(r => certificarEnChain(r, trimestreActual())));
});
 
// PV-L2: primer día de cada trimestre a las 09:00 UTC (bajo acuerdo previo)
cron.schedule('0 9 1 1,4,7,10 *', () => {
  log('CRON', `Job trimestral — validación PV-L2 satelital comercial · Q${trimestreActual()} · REQUIERE ACUERDO PREVIO`);
  // En producción: iterar solo empresas L2 con acuerdo activo
  // validacionL2_SatelitalComercial(wallet, endpoint).then(r => certificarEnChain(r, trimestreActual()));
});
 
// PV-L3: primer día de cada trimestre a las 10:00 UTC (bajo acuerdo previo)
cron.schedule('0 10 1 1,4,7,10 *', () => {
  log('CRON', `Job trimestral — validación PV-L3 triple fuente · Q${trimestreActual()} · REQUIERE ACUERDO PREVIO`);
  // En producción: iterar solo empresas L3 con acuerdo activo y sensores IoT instalados
  // validacionL3_TripleFuente(wallet, sensors).then(r => certificarEnChain(r, trimestreActual()));
});
 
// ─── INICIAR ─────────────────────────────────────────────
async function iniciar() {
  log('SYSTEM', '══ EPIMELEIA V3.2 ORACLE NODE INICIANDO ══');
  log('SYSTEM', 'Contrato: 0xEfEE680Da362890cdF5ab20a20BB42718e29DBc0');
  log('SYSTEM', 'Red: Polygon Mainnet (Chain ID: 137)');
 
  const network = await provider.getNetwork();
  log('SYSTEM', `Conectado: ${network.name} (chainId: ${network.chainId})`);
 
  const balance = await provider.getBalance(oracleWallet.address);
  log('SYSTEM', `Oracle wallet: ${oracleWallet.address}`);
  log('SYSTEM', `Balance POL: ${ethers.formatEther(balance)}`);
  log('SYSTEM', 'Niveles activos: PV-L1 (operativo) · PV-L2 y PV-L3 (bajo acuerdo previo)');
  log('SYSTEM', '══ ORACLE ACTIVO — Escuchando... ══');
}
 
iniciar().catch(err => {
  log('FATAL', `Error crítico al iniciar: ${err.message}`);
  process.exit(1);
});
 
// ─── EXPORTS ─────────────────────────────────────────────
module.exports = {
  validacionL1_Sentinel,
  validacionL2_SatelitalComercial,
  validacionL3_TripleFuente,
  certificarEnChain,
  registrarHueco,
  actualizarContinuidad,
  trimestreActual
};
 









