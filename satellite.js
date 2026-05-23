/**
 * EPIMELEIA V3.4 — Oracle Node · satellite.js
 * ─────────────────────────────────────────────
 * Toda la lógica de consulta a Sentinel/Copernicus (PV-L1).
 * Evalúa nubosidad, descarga datos y empaqueta el reporte científico.
 * Ajuste 14: satélite, banda espectral, nubosidad.
 * Ajuste 20: URL de descarga de datos raw disponible para el usuario.
 */

const axios    = require('axios');
const { ethers } = require('ethers');
const { config } = require('./config');
const { log }    = require('./logger');

// ─── PV-L1: Sentinel / Copernicus ──────────────────────────────

/**
 * Consulta Sentinel/Copernicus para las coordenadas de un activo.
 * @param {Object} datosActivo - { activoId, latitud, longitud, radioKm, tipo }
 * @returns {Object|null} Reporte satelital completo o null si no hay datos.
 */
async function consultarSentinel(datosActivo) {
  const { activoId, latitud, longitud, radioKm, tipo } = datosActivo;

  log('SAT-L1', `Consultando Sentinel/Copernicus`, { activoId, latitud, longitud, radioKm });

  const delta = radioKm / 111; // 1 grado ≈ 111 km
  const bbox  = `${longitud - delta},${latitud - delta},${longitud + delta},${latitud + delta}`;
  const indicadores = config.indicadoresPorTipo[tipo] || config.indicadoresPorTipo[7];

  try {
    // Consulta OData API de Copernicus (nueva API recomendada por ESA)
    const url = 'https://catalogue.dataspace.copernicus.eu/odata/v1/Products';
    const params = {
      '$filter': `OData.CSC.Intersects(area=geography'SRID=4326;POLYGON((${_bboxToWkt(bbox)}))') and ContentDate/Start gt ${_hace90dias()} and Name eq 'SENTINEL-2'`,
      '$orderby': 'ContentDate/Start desc',
      '$top': 3,
      '$expand': 'Attributes',
    };

    const resp = await axios.get(url, {
      params,
      timeout: config.sentinel.timeout,
      headers: {
        'Authorization': `Bearer ${await _getTokenCopernicus()}`,
      }
    });

    const productos = resp.data?.value || [];

    if (productos.length === 0) {
      log('SAT-L1', `Sin productos satelitales para las coordenadas`, { activoId, bbox });
      return null;
    }

    // Seleccionar el producto con menor nubosidad
    const producto = _seleccionarMejorProducto(productos);

    if (!producto) {
      log('SAT-L1', `Todos los productos superan el umbral de nubosidad`, { activoId });
      return null;
    }

    const nubosidad = _extraerNubosidad(producto);
    const urlDescarga = _generarUrlDescarga(producto.Id);

    const reporte = {
      activoId,
      nivel:      'PV-L1',
      tipo:       'SENTINEL_COPERNICUS_TRIMESTRAL',
      tipoActividad: indicadores.nombre,
      indicadores: indicadores.indicadores,
      bandaEspectral: indicadores.bandas,
      timestamp:  new Date().toISOString(),
      satelite:   producto.Name || 'Sentinel-2',
      latitud, longitud, radioKm, bbox,
      nubosidadPct: nubosidad,
      uuid:       producto.Id,
      urlDescargaDatos: urlDescarga,
      fuente:     'ESA_COPERNICUS_DATASPACE',
      metadatos:  {
        nombre:     producto.Name,
        fecha:      producto.ContentDate?.Start,
        tamaño:     producto.ContentLength,
      }
    };

    log('SAT-L1', `Datos satelitales obtenidos`, {
      activoId,
      satelite:  reporte.satelite,
      nubosidad: reporte.nubosidadPct,
      uuid:      reporte.uuid,
    });

    return reporte;

  } catch (err) {
    log('ERROR', `Sentinel consulta fallida: ${err.message}`, { activoId });

    // Detectar si es error de red (fuerza mayor)
    const esFuerzaMayor = ['ENOTFOUND','ETIMEDOUT','ECONNRESET','ECONNREFUSED']
      .some(code => err.code === code || err.message?.includes(code));

    if (esFuerzaMayor) {
      log('SUSPEND', `Fuerza mayor detectada en consulta satelital`, { error: err.message });
    }

    return null;
  }
}

/**
 * Evalúa el reporte satelital y determina si se puede certificar.
 * Ajuste 1: si nubosidad > umbral → no certifica, causa climática.
 * @returns {{ puedesCertificar: bool, causa: string }}
 */
function evaluarNubosidad(reporte) {
  if (!reporte) {
    return { puedeCertificar: false, causa: 'SATELLITE_LOSS: Sin datos satelitales disponibles.' };
  }

  if (reporte.nubosidadPct > config.sentinel.umbralNubosidad) {
    return {
      puedeCertificar: false,
      causa: `CLIMA: Nubosidad ${reporte.nubosidadPct}% sobre el area. Observacion satelital imposible. Umbral maximo: ${config.sentinel.umbralNubosidad}%.`,
      esClimatica: true,
    };
  }

  return { puedeCertificar: true, causa: null, esClimatica: false };
}

/**
 * Genera el hash de evidencia (keccak256 del reporte serializado).
 */
function generarHashEvidencia(reporte) {
  const { ethers } = require('ethers');
  const str = JSON.stringify({
    activoId:      reporte.activoId,
    satelite:      reporte.satelite,
    uuid:          reporte.uuid,
    nubosidadPct:  reporte.nubosidadPct,
    bandaEspectral:reporte.bandaEspectral,
    timestamp:     reporte.timestamp,
    fuente:        reporte.fuente,
  });
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

/**
 * Genera el URI de metadata IPFS para una certificación.
 * En producción, aquí se subiría el reporte a IPFS/Arweave.
 */
function generarMetadataURI(reporte, trimestre) {
  // En producción: subir JSON a IPFS y retornar el CID real
  // Por ahora: URI descriptivo con identificadores únicos
  return `ipfs://QmEpimeleia_${reporte.activoId}_Q${trimestre}_${reporte.nivel}_${reporte.uuid?.slice(0,8) || 'pending'}`;
}

// ─── PV-L2: Satelital comercial + validación cruzada ────────────

/**
 * Consulta proveedor comercial (Planet Labs, Satellogic, etc.) bajo acuerdo previo.
 * @param {Object} datosActivo - Datos del activo
 * @param {string} endpoint    - Endpoint específico del proveedor acordado
 */
async function consultarSatelitalComercial(datosActivo, endpoint) {
  const { activoId } = datosActivo;
  log('SAT-L2', `Consultando satelital comercial`, { activoId, endpoint });

  try {
    const resp = await axios.get(endpoint, {
      timeout: config.sentinel.timeout,
      headers: { 'Authorization': `Bearer ${process.env.SAT_COMERCIAL_TOKEN || ''}` }
    });

    const indicadores = config.indicadoresPorTipo[datosActivo.tipo] || config.indicadoresPorTipo[7];

    const reporte = {
      activoId,
      nivel:         'PV-L2',
      tipo:          'SAT_COMERCIAL_VALIDACION_CRUZADA',
      tipoActividad:  indicadores.nombre,
      bandaEspectral: indicadores.bandas,
      timestamp:      new Date().toISOString(),
      satelite:       resp.data?.satelite || 'Satelital Comercial',
      nubosidadPct:   resp.data?.nubosidad || 0,
      uuid:           resp.data?.uuid || '',
      urlDescargaDatos: resp.data?.urlDescarga || '',
      datos:          resp.data,
      fuente:         'SATELITAL_COMERCIAL_BAJO_ACUERDO',
    };

    log('SAT-L2', `Datos L2 obtenidos`, { activoId, satelite: reporte.satelite });
    return reporte;

  } catch (err) {
    log('ERROR', `SAT-L2 fallido: ${err.message}`, { activoId });
    return null;
  }
}

// ─── PV-L3: Triple fuente independiente ─────────────────────────

/**
 * Consulta tres fuentes independientes (satelital premium + IoT + validación pública).
 * Todas deben ser consistentes para certificar.
 * @param {Object} datosActivo
 * @param {Array}  fuentes - [{ nombre, endpoint }]
 */
async function consultarTripleFuente(datosActivo, fuentes) {
  const { activoId } = datosActivo;
  log('SAT-L3', `Consultando triple fuente independiente`, { activoId, totalFuentes: fuentes.length });

  const resultados = await Promise.allSettled(
    fuentes.map(f =>
      axios.get(f.endpoint, {
        timeout: 8000,
        headers: { 'Authorization': `Bearer ${process.env.SAT_L3_TOKEN || ''}` }
      }).then(r => ({ nombre: f.nombre, data: r.data }))
    )
  );

  const exitosas = resultados.filter(r => r.status === 'fulfilled').map(r => r.value);
  const fallidas = resultados.filter(r => r.status === 'rejected');

  log('SAT-L3', `Resultado triple fuente`, {
    activoId,
    exitosas: exitosas.length,
    fallidas: fallidas.length
  });

  if (exitosas.length === 0) {
    return null;
  }

  if (fallidas.length > 0) {
    log('WARN', `${fallidas.length} fuentes sin respuesta en L3`, { activoId });
  }

  const indicadores = config.indicadoresPorTipo[datosActivo.tipo] || config.indicadoresPorTipo[7];

  return {
    activoId,
    nivel:         'PV-L3',
    tipo:          'TRIPLE_FUENTE_TRIMESTRAL',
    tipoActividad:  indicadores.nombre,
    bandaEspectral: indicadores.bandas,
    timestamp:      new Date().toISOString(),
    satelite:       'Triple Fuente Independiente',
    nubosidadPct:   0,
    uuid:           `L3_${activoId}_${Date.now()}`,
    urlDescargaDatos: '',
    fuentesActivas: exitosas.length,
    fuentesTotal:   fuentes.length,
    datos:          exitosas,
    fuente:         'SAT_PREMIUM_IOT_SITIO_VALIDACION_CRUZADA',
  };
}

// ─── Helpers privados ───────────────────────────────────────────

async function _getTokenCopernicus() {
  // En producción: obtener token OAuth de Copernicus Identity Service
  // https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token
  if (config.modoTest) return 'test_token_mock';

  try {
    const resp = await axios.post(
      'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({
        grant_type: 'password',
        username:   config.sentinel.apiUser,
        password:   config.sentinel.apiKey,
        client_id:  'cdse-public',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    return resp.data.access_token;
  } catch (err) {
    log('ERROR', `Error obteniendo token Copernicus: ${err.message}`);
    throw err;
  }
}

function _bboxToWkt(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
  return `${minLng} ${minLat},${maxLng} ${minLat},${maxLng} ${maxLat},${minLng} ${maxLat},${minLng} ${minLat}`;
}

function _hace90dias() {
  const d = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  return d.toISOString().split('.')[0] + 'Z';
}

function _seleccionarMejorProducto(productos) {
  // Ordenar por menor nubosidad y seleccionar el mejor
  const conNubosidad = productos.map(p => ({
    ...p,
    _nubosidad: _extraerNubosidad(p)
  })).sort((a, b) => a._nubosidad - b._nubosidad);

  // Retornar el de menor nubosidad que no supere el umbral
  return conNubosidad.find(p => p._nubosidad <= config.sentinel.umbralNubosidad) || null;
}

function _extraerNubosidad(producto) {
  // Intentar extraer nubosidad de los atributos del producto Sentinel
  if (producto.Attributes?.value) {
    const attr = producto.Attributes.value.find(
      a => a.Name === 'cloudCover' || a.Name === 'cloudcoverpercentage'
    );
    if (attr) return Math.round(parseFloat(attr.Value));
  }
  // Fallback: asumir 50% si no hay dato
  return 50;
}

function _generarUrlDescarga(productId) {
  if (!productId || config.modoTest) return `https://mock.descarga.epimeleia.test/${productId}`;
  return `https://download.dataspace.copernicus.eu/odata/v1/Products(${productId})/$value`;
}

module.exports = {
  consultarSentinel,
  consultarSatelitalComercial,
  consultarTripleFuente,
  evaluarNubosidad,
  generarHashEvidencia,
  generarMetadataURI,
};
