// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           EPIMELEIA V3.4 — EpimeleiaOracle                   ║
 * ║     Módulo de Gestión de Oráculos Autorizados                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Gestiona qué wallets pueden actuar como oráculos del protocolo.
 * Un oráculo es quien firma y graba las certificaciones satelitales.
 */

interface IEpimeleiaCoreForOracle {
    function founder() external view returns (address);
}

contract EpimeleiaOracle {

    IEpimeleiaCoreForOracle public core;

    // ═══════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════

    mapping(address => bool)   public oraculos;
    mapping(address => string) public descripcionOraculo; // nombre/descripción del oráculo
    address[] public listaOracles;

    // ═══════════════════════════════════════════════════
    // EVENTOS
    // ═══════════════════════════════════════════════════

    event OraculoAutorizado(
        address indexed oraculo,
        string  descripcion,
        uint256 timestamp
    );

    event OraculoRevocado(
        address indexed oraculo,
        uint256 timestamp
    );

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) {
        core = IEpimeleiaCoreForOracle(_core);
    }

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier soloFounder() {
        require(msg.sender == core.founder(),
            "EPIMELEIA: Solo el founder puede gestionar oraculos");
        _;
    }

    // ═══════════════════════════════════════════════════
    // GESTIÓN DE ORÁCULOS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Autoriza una wallet como oráculo del protocolo.
     * @param oraculo     Dirección del oráculo a autorizar.
     * @param descripcion Descripción del oráculo (ej: "Oracle PV-L1 Sentinel Mainnet").
     */
    function autorizarOraculo(address oraculo, string calldata descripcion)
        external soloFounder
    {
        require(oraculo != address(0), "EPIMELEIA: Direccion invalida");
        if (!oraculos[oraculo]) {
            listaOracles.push(oraculo);
        }
        oraculos[oraculo] = true;
        descripcionOraculo[oraculo] = descripcion;
        emit OraculoAutorizado(oraculo, descripcion, block.timestamp);
    }

    /**
     * @notice Revoca la autorización de un oráculo.
     */
    function revocarOraculo(address oraculo) external soloFounder {
        oraculos[oraculo] = false;
        emit OraculoRevocado(oraculo, block.timestamp);
    }

    /**
     * @notice Verifica si una dirección es un oráculo autorizado.
     * @dev Llamado por EpimeleiaCert antes de aceptar cualquier certificación.
     */
    function esOraculo(address addr) external view returns (bool) {
        return oraculos[addr];
    }

    /**
     * @notice Lista todos los oráculos activos.
     */
    function getOraculosActivos()
        external view
        returns (address[] memory activos, string[] memory descripciones)
    {
        uint256 count = 0;
        for (uint256 i = 0; i < listaOracles.length; i++) {
            if (oraculos[listaOracles[i]]) count++;
        }

        activos      = new address[](count);
        descripciones = new string[](count);
        uint256 j = 0;

        for (uint256 i = 0; i < listaOracles.length; i++) {
            if (oraculos[listaOracles[i]]) {
                activos[j]       = listaOracles[i];
                descripciones[j] = descripcionOraculo[listaOracles[i]];
                j++;
            }
        }
    }
}
