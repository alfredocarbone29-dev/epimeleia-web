// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           EPIMELEIA V3.4 — EpimeleiaBilling                  ║
 * ║     Módulo de Saldos, Fees, Gracia y Alertas                 ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * AJUSTES V3.4 incorporados:
 *   Ajuste 2  — Falta de saldo = Hueco de Opacidad (no cancelación)
 *   Ajuste 3  — Índice de continuidad
 *   Ajuste 4  — Ventana de gracia 7 días antes de marcar opacidad
 *   Ajuste 5  — Alerta automática de saldo bajo
 *   Ajuste 8  — Operación completamente autónoma vía Chainlink Automation
 *   Ajuste 13 — Fecha de vencimiento visible en días
 *   Ajuste 15 — Modo Test: fees simbólicos y períodos comprimidos
 *   Ajuste 21 — Trigger de reporte trimestral por email al cierre de Q
 */

interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata) external view returns (bool, bytes memory);
    function performUpkeep(bytes calldata) external;
}

interface IEpimeleiaCoreForBilling {
    enum PVLevel { L1, L2, L3 }
    function founder() external view returns (address);
    function contratoCert() external view returns (address);
    function contratoOracle() external view returns (address);
    function modoTest() external view returns (bool);
    function getPeriodoBilling() external view returns (uint256);
    function getVentanaSatelital() external view returns (uint256);
    function desactivarActivo(uint256 activoId) external;
}

interface IEpimeleiaCertForBilling {
    function registrarHuecoOpacidad(
        uint256 activoId,
        uint256 diaInicio,
        uint256 diaFin,
        string calldata causa,
        bool esCausaClimatica
    ) external;
    function getIndiceContinuidad(uint256 activoId) external view returns (uint256);
}

contract EpimeleiaBilling is AutomationCompatibleInterface {

    // ═══════════════════════════════════════════════════
    // REFERENCIA AL CORE
    // ═══════════════════════════════════════════════════

    IEpimeleiaCoreForBilling public core;

    constructor(address _core) {
        core = IEpimeleiaCoreForBilling(_core);
    }

    // ═══════════════════════════════════════════════════
    // FEES — Modo Test: valores simbólicos (1 wei)
    // ═══════════════════════════════════════════════════

    // MODO TEST: 1 wei para todo (probamos sin riesgo)
    uint256 public registrationFee_TEST  = 1;
    uint256 public trimestralFee_L1_TEST = 1;
    uint256 public trimestralFee_L2_TEST = 1;
    uint256 public trimestralFee_L3_TEST = 1;

    // MODO PRODUCCIÓN: valores reales en POL (se setean antes de ir a producción)
    // USD 1,500 registro · USD 450 trimestral L1 (convertidos a POL al momento de ajuste)
    uint256 public registrationFee_PROD  = 0;  // founder setea el valor en POL equivalente
    uint256 public trimestralFee_L1_PROD = 0;
    uint256 public trimestralFee_L2_PROD = 0;
    uint256 public trimestralFee_L3_PROD = 0;

    // ─── Getters de fees según modo activo ───────────

    function getRegistrationFee() public view returns (uint256) {
        return core.modoTest() ? registrationFee_TEST : registrationFee_PROD;
    }

    function getTrimestralFee(uint8 nivel) public view returns (uint256) {
        if (core.modoTest()) return 1;
        if (nivel == 0) return trimestralFee_L1_PROD;
        if (nivel == 1) return trimestralFee_L2_PROD;
        return trimestralFee_L3_PROD;
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct EstadoBilling {
        uint256 saldo;
        uint256 ultimoBilling;
        uint256 proximoBilling;
        uint8   nivel;              // PVLevel como uint8
        address owner;
        bool    enGracia;           // Ajuste 4: está en ventana de gracia
        uint256 inicioGracia;       // timestamp inicio de gracia
        bool    alertaEnviada;      // Ajuste 5: ya se notificó saldo bajo
    }

    // ═══════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════

    // activoId → estado de billing
    mapping(uint256 => EstadoBilling) public estadoBilling;

    // Lista de IDs activos para iterar en Automation
    uint256[] public idsActivos;

    // ═══════════════════════════════════════════════════
    // EVENTOS
    // ═══════════════════════════════════════════════════

    event BillingEjecutado(
        uint256 indexed activoId,
        uint256 monto,
        uint256 nuevoSaldo,
        uint256 timestamp
    );

    event ActivoCancelado(
        uint256 indexed activoId,
        address indexed owner,
        uint256 reembolso,
        uint256 timestamp
    );

    event AlertaSaldoBajo(
        uint256 indexed activoId,
        address indexed owner,
        uint256 saldoActual,
        uint256 feeRequerido,
        uint256 diasRestantes,
        uint256 timestamp
    );

    event GraciaIniciada(
        uint256 indexed activoId,
        address indexed owner,
        uint256 finGracia,
        uint256 timestamp
    );

    event ReporteTrimestralTrigger(
        uint256 indexed activoId,
        address indexed owner,
        uint256 trimestre,
        uint256 timestamp
    );

    event FeesActualizados(uint256 timestamp);

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier soloFounder() {
        require(msg.sender == core.founder(),
            "EPIMELEIA: Solo founder");
        _;
    }

    modifier soloCore() {
        require(
            msg.sender == address(core) ||
            msg.sender == core.founder(),
            "EPIMELEIA: Solo core o founder"
        );
        _;
    }

    // ═══════════════════════════════════════════════════
    // INICIALIZACIÓN DE ACTIVO (llamado desde Core al registrar)
    // ═══════════════════════════════════════════════════

    function inicializarActivo(
        uint256 activoId,
        IEpimeleiaCoreForBilling.PVLevel nivel,
        uint256 saldoInicial
    ) external payable soloCore {
        uint256 fee = getRegistrationFee();

        estadoBilling[activoId] = EstadoBilling({
            saldo:          saldoInicial,
            ultimoBilling:  block.timestamp,
            proximoBilling: block.timestamp + core.getPeriodoBilling(),
            nivel:          uint8(nivel),
            owner:          tx.origin,
            enGracia:       false,
            inicioGracia:   0,
            alertaEnviada:  false
        });

        idsActivos.push(activoId);

        // Fee de registro va al founder
        _transferirFounder(fee);
    }

    /**
     * @notice La empresa carga saldo prepagado en su activo.
     */
    function cargarSaldo(uint256 activoId) external payable {
        require(estadoBilling[activoId].proximoBilling > 0,
            "EPIMELEIA: Activo no inicializado");
        require(msg.value > 0, "EPIMELEIA: Monto debe ser mayor a 0");

        estadoBilling[activoId].saldo += msg.value;

        // Si estaba en gracia y ahora tiene saldo suficiente, salir de gracia
        if (estadoBilling[activoId].enGracia) {
            uint8 nivel = estadoBilling[activoId].nivel;
            uint256 fee = getTrimestralFee(nivel);
            if (estadoBilling[activoId].saldo >= fee) {
                estadoBilling[activoId].enGracia = false;
                estadoBilling[activoId].alertaEnviada = false;
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // CHAINLINK AUTOMATION — Ajuste 8
    // ═══════════════════════════════════════════════════

    /**
     * @notice Chainlink llama esto para verificar si hay trabajo pendiente.
     * @dev Itera todos los activos y verifica vencimientos o estados de gracia.
     */
    function checkUpkeep(bytes calldata)
        external view override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 periodo = core.getPeriodoBilling();
        uint256 gracia  = core.modoTest() ? 30 : 7 days; // 30 segundos en test

        for (uint256 i = 0; i < idsActivos.length; i++) {
            uint256 id = idsActivos[i];
            EstadoBilling storage b = estadoBilling[id];

            if (b.proximoBilling == 0) continue;

            // Verificar si venció el período de billing
            if (block.timestamp >= b.ultimoBilling + periodo) {
                upkeepNeeded = true;
                performData  = abi.encode(id);
                return (true, performData);
            }

            // Verificar si venció el período de gracia — Ajuste 4
            if (b.enGracia && block.timestamp >= b.inicioGracia + gracia) {
                upkeepNeeded = true;
                performData  = abi.encode(id);
                return (true, performData);
            }

            // Verificar alerta de saldo bajo — Ajuste 5
            if (!b.alertaEnviada) {
                uint256 fee = getTrimestralFee(b.nivel);
                if (b.saldo < fee && b.saldo > 0) {
                    upkeepNeeded = true;
                    performData  = abi.encode(id);
                    return (true, performData);
                }
            }
        }

        return (false, "");
    }

    /**
     * @notice Chainlink ejecuta el upkeep. Corre el billing o la gracia según corresponda.
     */
    function performUpkeep(bytes calldata performData) external override {
        uint256 activoId = abi.decode(performData, (uint256));
        _procesarActivo(activoId);
    }

    // ═══════════════════════════════════════════════════
    // LÓGICA DE BILLING
    // ═══════════════════════════════════════════════════

    function _procesarActivo(uint256 activoId) internal {
        EstadoBilling storage b = estadoBilling[activoId];
        if (b.proximoBilling == 0) return;

        uint256 periodo = core.getPeriodoBilling();
        uint256 gracia  = core.modoTest() ? 30 : 7 days;

        // ── Caso 1: Venció gracia sin recargar → Hueco de Opacidad — Ajuste 2
        if (b.enGracia && block.timestamp >= b.inicioGracia + gracia) {
            b.enGracia     = false;
            b.ultimoBilling = block.timestamp;
            b.proximoBilling = block.timestamp + periodo;

            address cert = core.contratoCert();
            IEpimeleiaCertForBilling(cert).registrarHuecoOpacidad(
                activoId, 0, 0,
                "SALDO_INSUFICIENTE: El activo no recargo saldo dentro del periodo de gracia de 7 dias.",
                false
            );
            return;
        }

        // ── Caso 2: Vence el período de billing
        if (block.timestamp >= b.ultimoBilling + periodo) {
            uint256 fee = getTrimestralFee(b.nivel);

            // Alerta de saldo bajo — Ajuste 5
            if (!b.alertaEnviada && b.saldo < fee) {
                b.alertaEnviada = true;
                emit AlertaSaldoBajo(
                    activoId, b.owner, b.saldo, fee,
                    (periodo / 1 days),
                    block.timestamp
                );
            }

            if (b.saldo >= fee) {
                // Saldo suficiente: ejecutar billing normal
                b.saldo         -= fee;
                b.ultimoBilling  = block.timestamp;
                b.proximoBilling = block.timestamp + periodo;
                b.alertaEnviada  = false;

                _transferirFounder(fee);

                emit BillingEjecutado(activoId, fee, b.saldo, block.timestamp);

                // Trigger de reporte trimestral — Ajuste 21
                uint256 trimestre = _trimestreActual();
                emit ReporteTrimestralTrigger(activoId, b.owner, trimestre, block.timestamp);

            } else {
                // Saldo insuficiente: iniciar gracia de 7 días — Ajuste 4
                if (!b.enGracia) {
                    b.enGracia     = true;
                    b.inicioGracia = block.timestamp;
                    emit GraciaIniciada(
                        activoId, b.owner,
                        block.timestamp + gracia,
                        block.timestamp
                    );
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════
    // CANCELACIÓN — desde Core o founder
    // ═══════════════════════════════════════════════════

    /**
     * @notice Cancela con reembolso del saldo disponible.
     */
    function cancelarConReembolso(uint256 activoId) external soloCore {
        EstadoBilling storage b = estadoBilling[activoId];
        uint256 reembolso = b.saldo;
        address owner = b.owner;

        b.saldo = 0;
        b.proximoBilling = 0;

        core.desactivarActivo(activoId);

        if (reembolso > 0) {
            (bool ok,) = payable(owner).call{value: reembolso}("");
            require(ok, "EPIMELEIA: Reembolso fallido");
        }

        emit ActivoCancelado(activoId, owner, reembolso, block.timestamp);
    }

    /**
     * @notice Cancela sin reembolso (mal uso del protocolo) — Ajuste 23.
     */
    function cancelarSinReembolso(uint256 activoId) external soloCore {
        EstadoBilling storage b = estadoBilling[activoId];
        b.saldo = 0;
        b.proximoBilling = 0;
        // El founder retiene el saldo como penalización
    }

    /**
     * @notice Actualiza el owner en billing cuando se transfiere un activo — Ajuste 18.
     */
    function actualizarOwner(uint256 activoId, address nuevoOwner) external soloCore {
        estadoBilling[activoId].owner = nuevoOwner;
    }

    // ═══════════════════════════════════════════════════
    // AJUSTE DE FEES DE PRODUCCIÓN
    // ═══════════════════════════════════════════════════

    /**
     * @notice Setea los fees de producción en POL antes de salir del modo test.
     * @dev Los valores se expresan en wei. USD → POL según precio al momento de ajuste.
     */
    function setFeesProd(
        uint256 _reg,
        uint256 _l1,
        uint256 _l2,
        uint256 _l3
    ) external soloFounder {
        registrationFee_PROD  = _reg;
        trimestralFee_L1_PROD = _l1;
        trimestralFee_L2_PROD = _l2;
        trimestralFee_L3_PROD = _l3;
        emit FeesActualizados(block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // VISTAS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Índice de continuidad del activo — Ajuste 3.
     * @dev Delega al contrato EpimeleiaCert.
     */
    function getIndiceContinuidad(uint256 activoId) external view returns (uint256) {
        address cert = core.contratoCert();
        return IEpimeleiaCertForBilling(cert).getIndiceContinuidad(activoId);
    }

    /**
     * @notice Días hasta el próximo billing y próxima ventana satelital — Ajuste 13.
     * @return diasHastaBilling   Días hasta el próximo débito trimestral.
     * @return diasHastaVentana   Días hasta la próxima ventana de observación satelital.
     */
    function getProximosVencimientos(uint256 activoId)
        external view
        returns (uint256 diasHastaBilling, uint256 diasHastaVentana)
    {
        EstadoBilling storage b = estadoBilling[activoId];
        uint256 ahora = block.timestamp;

        if (b.proximoBilling > ahora) {
            diasHastaBilling = (b.proximoBilling - ahora) / 1 days;
        } else {
            diasHastaBilling = 0;
        }

        uint256 ventana = core.getVentanaSatelital();
        uint256 proximaVentana = b.ultimoBilling + ventana;
        if (proximaVentana > ahora) {
            diasHastaVentana = (proximaVentana - ahora) / 1 days;
        } else {
            diasHastaVentana = 0;
        }
    }

    /**
     * @notice Saldo actual del activo.
     */
    function getSaldo(uint256 activoId) external view returns (uint256) {
        return estadoBilling[activoId].saldo;
    }

    /**
     * @notice Estado completo de billing de un activo.
     */
    function getEstadoBilling(uint256 activoId)
        external view
        returns (
            uint256 saldo,
            uint256 ultimoBilling,
            uint256 proximoBilling,
            bool    enGracia,
            uint256 feeProximo,
            bool    alertaActiva
        )
    {
        EstadoBilling storage b = estadoBilling[activoId];
        return (
            b.saldo,
            b.ultimoBilling,
            b.proximoBilling,
            b.enGracia,
            getTrimestralFee(b.nivel),
            b.alertaEnviada
        );
    }

    // ═══════════════════════════════════════════════════
    // INTERNAL UTILS
    // ═══════════════════════════════════════════════════

    function _transferirFounder(uint256 monto) internal {
        if (monto == 0) return;
        address founder = core.founder();
        (bool ok,) = payable(founder).call{value: monto}("");
        require(ok, "EPIMELEIA: Transferencia al founder fallida");
    }

    function _trimestreActual() internal view returns (uint256) {
        // Retorna año * 10 + trimestre, ej: 20241, 20242, 20243, 20244
        uint256 año = 1970 + (block.timestamp / 365 days);
        uint256 mes = ((block.timestamp % 365 days) / 30 days) + 1;
        uint256 q = ((mes - 1) / 3) + 1;
        return año * 10 + q;
    }

    receive() external payable {
        // Acepta POL directo (para cargas de saldo sin especificar activo)
    }
}
