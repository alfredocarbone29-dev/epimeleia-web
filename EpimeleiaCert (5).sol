// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/*
 * EPIMELEIA V3.4 — EpimeleiaCert
 * Modulo de Certificaciones, Huecos y Sello de Excelencia
 */

interface IEpimeleiaCore {
    enum PVLevel { L1, L2, L3 }
    enum CertStatus { PENDIENTE, CERTIFICADO, HUECO_OPACIDAD }
    enum TipoActividad {
        MINERIA, FORESTAL, NAVAL, INDUSTRIAL,
        DATA_CENTER, RESIDUOS, HIDROVIA, OTRO
    }
    function founder() external view returns (address);
    function contratoBilling() external view returns (address);
    function contratoOracle() external view returns (address);
    function activos(uint256) external view returns (
        bool, IEpimeleiaCore.PVLevel, IEpimeleiaCore.TipoActividad,
        IEpimeleiaCore.CertStatus, uint256, uint256,
        int256, int256, uint256, string memory,
        address, address, bool, uint256
    );
    function actualizarEstadoCert(uint256 activoId, IEpimeleiaCore.CertStatus nuevoEstado) external;
    function actualizarConsecutivos(uint256 activoId, uint256 valor) external;
    function emitirSelloExcelencia(uint256 activoId) external;
    function getDatosOracle(uint256 activoId) external view returns (
        bool, IEpimeleiaCore.PVLevel, IEpimeleiaCore.TipoActividad,
        int256, int256, uint256, address
    );
    function modoTest() external view returns (bool);
}

interface IEpimeleiaOracle {
    function esOraculo(address addr) external view returns (bool);
}

contract EpimeleiaCert {

    IEpimeleiaCore public core;

    constructor(address _core) {
        core = IEpimeleiaCore(_core);
    }

    struct CertificacionQ {
        uint256 timestamp;
        uint256 trimestre;
        bytes32 hashEvidencia;
        address oraculo;
        uint8   nivel;
        uint8   tipoActividad;
        string  metadataURI;
        bool    valida;
        string  satelite;
        string  bandaEspectral;
        uint16  nubosidadPct;
        string  urlDescargaDatos;
        string  uuid;
    }

    struct HuecoOpacidad {
        uint256 diaInicio;
        uint256 diaFin;
        uint256 timestamp;
        string  causa;
        bool    esCausaClimatica;
    }

    struct EvidenciaVentana {
        uint256 timestamp;
        bytes32 hashEvidencia;
        address oraculo;
        string  satelite;
        uint16  nubosidadPct;
        string  urlDescargaDatos;
    }

    mapping(uint256 => CertificacionQ[]) public certificaciones;
    mapping(uint256 => HuecoOpacidad[]) public huecos;
    mapping(uint256 => mapping(uint256 => EvidenciaVentana[])) public evidenciasVentana;
    mapping(uint256 => uint256) public trimestresCertificados;
    mapping(uint256 => uint256) public trimestresConHueco;

    event CertificacionRealizada(uint256 indexed activoId, bytes32 hashEvidencia, uint256 trimestre, string satelite, uint16 nubosidadPct, uint256 timestamp);
    event HuecoOpacidadRegistrado(uint256 indexed activoId, string causa, bool esCausaClimatica, uint256 timestamp);
    event EvidenciaVentanaRegistrada(uint256 indexed activoId, uint256 trimestre, uint256 totalEvidencias, uint256 timestamp);

    modifier soloOraculo() {
        address oracleAddr = core.contratoOracle();
        require(IEpimeleiaOracle(oracleAddr).esOraculo(msg.sender), "EPIMELEIA: Solo oraculo autorizado");
        _;
    }

    modifier soloFounderOModulos() {
        require(
            msg.sender == core.founder() ||
            msg.sender == core.contratoBilling() ||
            msg.sender == core.contratoOracle() ||
            msg.sender == address(core),
            "EPIMELEIA: Acceso no autorizado"
        );
        _;
    }

    modifier activoActivo(uint256 activoId) {
        (bool activo,,,,,,,,,,,,, ) = core.activos(activoId);
        require(activo, "EPIMELEIA: Activo no registrado o cancelado");
        _;
    }

    function certificarQ(
        uint256 activoId,
        bytes32 hashEvidencia,
        string calldata metadataURI,
        uint256 trimestre,
        string calldata satelite,
        string calldata bandaEspectral,
        uint16  nubosidadPct,
        string calldata urlDescarga,
        string calldata uuid
    ) external soloOraculo activoActivo(activoId) {

        if (nubosidadPct > 70) {
            _registrarHueco(
                activoId, 0, 0,
                string(abi.encodePacked("CLIMA: Nubosidad ", _uint16ToString(nubosidadPct), "% sobre el area.")),
                true
            );
            return;
        }

        (,uint8 nivel, uint8 tipo,,,,,,,,,, ) = _getDatosBasicos(activoId);

        certificaciones[activoId].push(CertificacionQ({
            timestamp:        block.timestamp,
            trimestre:        trimestre,
            hashEvidencia:    hashEvidencia,
            oraculo:          msg.sender,
            nivel:            nivel,
            tipoActividad:    tipo,
            metadataURI:      metadataURI,
            valida:           true,
            satelite:         satelite,
            bandaEspectral:   bandaEspectral,
            nubosidadPct:     nubosidadPct,
            urlDescargaDatos: urlDescarga,
            uuid:             uuid
        }));

        trimestresCertificados[activoId]++;

        uint256 consecutivos = _getConsecutivos(activoId) + 1;
        core.actualizarConsecutivos(activoId, consecutivos);

        if (consecutivos >= 4) {
            core.emitirSelloExcelencia(activoId);
        }

        core.actualizarEstadoCert(activoId, IEpimeleiaCore.CertStatus.CERTIFICADO);

        emit CertificacionRealizada(activoId, hashEvidencia, trimestre, satelite, nubosidadPct, block.timestamp);
    }

    function registrarEvidenciaVentana(
        uint256 activoId,
        uint256 trimestre,
        bytes32 hashEvidencia,
        string calldata satelite,
        uint16  nubosidadPct,
        string calldata urlDescarga
    ) external soloOraculo activoActivo(activoId) {
        EvidenciaVentana[] storage ev = evidenciasVentana[activoId][trimestre];
        require(ev.length < 6, "EPIMELEIA: Maximo 6 evidencias por trimestre");
        ev.push(EvidenciaVentana({
            timestamp:        block.timestamp,
            hashEvidencia:    hashEvidencia,
            oraculo:          msg.sender,
            satelite:         satelite,
            nubosidadPct:     nubosidadPct,
            urlDescargaDatos: urlDescarga
        }));
        emit EvidenciaVentanaRegistrada(activoId, trimestre, ev.length, block.timestamp);
    }

    function registrarHuecoOpacidad(
        uint256 activoId,
        uint256 diaInicio,
        uint256 diaFin,
        string calldata causa,
        bool esCausaClimatica
    ) external soloFounderOModulos activoActivo(activoId) {
        _registrarHueco(activoId, diaInicio, diaFin, causa, esCausaClimatica);
    }

    function _registrarHueco(uint256 activoId, uint256 diaInicio, uint256 diaFin, string memory causa, bool esCausaClimatica) internal {
        huecos[activoId].push(HuecoOpacidad({
            diaInicio: diaInicio, diaFin: diaFin,
            timestamp: block.timestamp, causa: causa,
            esCausaClimatica: esCausaClimatica
        }));
        trimestresConHueco[activoId]++;
        core.actualizarConsecutivos(activoId, 0);
        core.actualizarEstadoCert(activoId, IEpimeleiaCore.CertStatus.HUECO_OPACIDAD);
        emit HuecoOpacidadRegistrado(activoId, causa, esCausaClimatica, block.timestamp);
    }

    function getCertificaciones(uint256 activoId) external view returns (CertificacionQ[] memory) {
        _verificarAcceso(activoId);
        return certificaciones[activoId];
    }

    function getHuecos(uint256 activoId) external view returns (HuecoOpacidad[] memory) {
        _verificarAcceso(activoId);
        return huecos[activoId];
    }

    function getEvidenciasVentana(uint256 activoId, uint256 trimestre) external view returns (EvidenciaVentana[] memory) {
        _verificarAcceso(activoId);
        return evidenciasVentana[activoId][trimestre];
    }

    function getIndiceContinuidad(uint256 activoId) external view returns (uint256 pct) {
        uint256 cert  = trimestresCertificados[activoId];
        uint256 huecoCount = trimestresConHueco[activoId];
        uint256 total = cert + huecoCount;
        if (total == 0) return 0;
        return (cert * 100) / total;
    }

    function getTotalCertificaciones(uint256 activoId) external view returns (uint256) {
        return certificaciones[activoId].length;
    }

    function getDatosDescarga(uint256 activoId, uint256 indice) external view returns (
        string memory satelite, string memory bandaEspectral, uint16 nubosidadPct,
        string memory urlDescargaDatos, string memory uuid, uint256 timestamp
    ) {
        _verificarAcceso(activoId);
        require(indice < certificaciones[activoId].length, "EPIMELEIA: Indice fuera de rango");
        CertificacionQ storage c = certificaciones[activoId][indice];
        return (c.satelite, c.bandaEspectral, c.nubosidadPct, c.urlDescargaDatos, c.uuid, c.timestamp);
    }

    function _getDatosBasicos(uint256 activoId) internal view returns (
        bool activo, uint8 nivel, uint8 tipo,
        uint256 fechaRegistro, uint256 ultimaCertQ,
        int256 latitud, int256 longitud, uint256 radioKm,
        string memory nombre, address owner, address ownerOriginal,
        bool sello, uint256 consecutivos
    ) {
        (
            bool _activo, IEpimeleiaCore.PVLevel _nivel, IEpimeleiaCore.TipoActividad _tipo,
            IEpimeleiaCore.CertStatus _estadoCert,
            uint256 _fechaRegistro, uint256 _ultimaCertQ,
            int256 _lat, int256 _lng, uint256 _radio,
            string memory _nombre, address _owner, address _ownerOrig,
            bool _sello, uint256 _consec
        ) = core.activos(activoId);
        return (_activo, uint8(_nivel), uint8(_tipo), _fechaRegistro, _ultimaCertQ,
                _lat, _lng, _radio, _nombre, _owner, _ownerOrig, _sello, _consec);
    }

    function _getConsecutivos(uint256 activoId) internal view returns (uint256) {
        (,,,,,,,,,,,,, uint256 consec) = core.activos(activoId);
        return consec;
    }

    function _verificarAcceso(uint256 activoId) internal view {
        (,,,,,,,,,, address owner,,,) = core.activos(activoId);
        require(
            msg.sender == core.founder() || msg.sender == owner ||
            msg.sender == address(core) || msg.sender == core.contratoBilling() ||
            msg.sender == core.contratoOracle(),
            "EPIMELEIA: Acceso denegado"
        );
    }

    function _uint16ToString(uint16 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint16 temp = v; uint16 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (v != 0) { digits--; buffer[digits] = bytes1(uint8(48 + uint16(v % 10))); v /= 10; }
        return string(buffer);
    }
}
