// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           EPIMELEIA V3.4 — EpimeleiaCore                     ║
 * ║     Notario Digital de Conducta Ambiental Corporativa        ║
 * ║     Red: Polygon Mainnet (Chain ID: 137)                     ║
 * ║     Primer certificado público: Hidrovía Paraná-Paraguay     ║
 * ║     Contacto: info@epimeleia.world                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ARQUITECTURA MODULAR V3.4 — 4 contratos independientes:
 *   EpimeleiaCore    — registro de activos, identidades, transferencias
 *   EpimeleiaCert    — certificaciones, huecos, Sello de Excelencia
 *   EpimeleiaBilling — saldos, fees, gracia, alertas
 *   EpimeleiaOracle  — gestión de oráculos autorizados
 *
 * AJUSTES V3.4 incorporados en este contrato:
 *   Ajuste 6  — VERSION on-chain
 *   Ajuste 9  — Arquitectura modular
 *   Ajuste 10 — Multi-activo y consultas completas
 *   Ajuste 11 — Control de acceso por rol
 *   Ajuste 12 — Badge público por activo
 *   Ajuste 15 — Modo Test vs Producción
 *   Ajuste 16 — Cláusulas legales on-chain
 *   Ajuste 17 — Multi-activo por wallet (ID único por activo)
 *   Ajuste 18 — Transferencia de activo con historial completo
 *   Ajuste 23 — Cláusula de mal uso on-chain
 */

contract EpimeleiaCore {

    // ═══════════════════════════════════════════════════
    // VERSIÓN Y CLÁUSULAS LEGALES ON-CHAIN
    // ═══════════════════════════════════════════════════

    string public constant VERSION = "3.4";

    string public constant CLAUSULA_PRECIOS =
        "Los precios de los servicios EPIMELEIA pueden modificarse sin previo aviso por decision del founder.";

    string public constant CLAUSULA_TECNOLOGIA =
        "EPIMELEIA se reserva el derecho de incorporar mejoras tecnologicas, nuevas fuentes satelitales y actualizaciones de protocolo en beneficio del servicio.";

    string public constant CLAUSULA_VERSION =
        "Este contrato es la version oficial vigente de EPIMELEIA a la fecha de su despliegue en Polygon Mainnet.";

    string public constant CLAUSULA_MAL_USO =
        "El uso fraudulento, la manipulacion de datos o el incumplimiento de los terminos de EPIMELEIA faculta al founder a dar de baja inmediata al causante, sin reembolso y con registro permanente on-chain del evento.";

    string public constant PRIMER_CERTIFICADO =
        "Primera certificacion publica EPIMELEIA: Hidrovia Parana-Paraguay. Arquitecto fundador del protocolo: EPIMELEIA Team.";

    // ═══════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════

    enum PVLevel { L1, L2, L3 }

    enum CertStatus { PENDIENTE, CERTIFICADO, HUECO_OPACIDAD }

    enum TipoActividad {
        MINERIA,      // 0 — expansión área excavada, sedimentos en agua
        FORESTAL,     // 1 — pérdida cobertura vegetal NDVI
        NAVAL,        // 2 — ruta, emisiones, área de operación portuaria
        INDUSTRIAL,   // 3 — temperatura superficial, emisiones
        DATA_CENTER,  // 4 — consumo energético, temperatura
        RESIDUOS,     // 5 — expansión área, presencia lixiviados
        HIDROVIA,     // 6 — nivel hídrico, calidad agua, sedimentos
        OTRO          // 7 — indicadores generales
    }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct Activo {
        bool activo;
        PVLevel nivel;
        TipoActividad tipoActividad;
        CertStatus estadoCert;
        uint256 fechaRegistro;
        uint256 ultimaCertQ;
        int256 latitud;         // multiplicado x1e6 para evitar decimales
        int256 longitud;        // multiplicado x1e6
        uint256 radioKm;
        bytes32 emailHash;
        string nombre;
        address owner;          // wallet actual del activo
        address ownerOriginal;  // wallet que registró originalmente
        bool selloExcelencia;   // true si ganó el sello
        uint256 consecutivosCertificados; // trimestres certificados consecutivos
    }

    // ═══════════════════════════════════════════════════
    // OWNER Y MÓDULOS
    // ═══════════════════════════════════════════════════

    address public founder;
    address public pendingFounder;

    // Direcciones de los contratos hermanos (se setean post-deploy)
    address public contratoCert;
    address public contratoBilling;
    address public contratoOracle;

    // ═══════════════════════════════════════════════════
    // MODO TEST vs PRODUCCIÓN — Ajuste 15
    // ═══════════════════════════════════════════════════

    bool public modoTest = true;

    // En modo test: fees simbólicos (1 wei), períodos comprimidos (60 seg)
    // En producción: fees reales en POL, períodos reales (90 días)
    uint256 public constant PERIODO_TEST    = 60;        // 60 segundos
    uint256 public constant PERIODO_REAL    = 90 days;
    uint256 public constant VENTANA_TEST    = 10;        // 10 segundos
    uint256 public constant VENTANA_REAL    = 15 days;

    function getPeriodoBilling() public view returns (uint256) {
        return modoTest ? PERIODO_TEST : PERIODO_REAL;
    }

    function getVentanaSatelital() public view returns (uint256) {
        return modoTest ? VENTANA_TEST : VENTANA_REAL;
    }

    // ═══════════════════════════════════════════════════
    // STORAGE — Multi-activo por wallet (Ajuste 17)
    // ═══════════════════════════════════════════════════

    // ID único global incremental por activo
    uint256 public nextActivoId = 1;

    // ID → Activo
    mapping(uint256 => Activo) public activos;

    // wallet → lista de IDs de activos que posee
    mapping(address => uint256[]) public activosPorWallet;

    // emailHash → bool verificado
    mapping(bytes32 => bool) public emailsVerificados;

    // código → wallet (verificación email)
    mapping(bytes32 => address) public codigosVerificacion;

    // Lista global de todos los IDs registrados (para iteración del oracle)
    uint256[] public listaActivoIds;

    // Registro de bajas por mal uso (Ajuste 23)
    mapping(uint256 => string) public registroBajaMalUso;

    // ═══════════════════════════════════════════════════
    // EVENTOS
    // ═══════════════════════════════════════════════════

    event ActivoRegistrado(
        uint256 indexed activoId,
        address indexed wallet,
        string nombre,
        TipoActividad tipo,
        PVLevel nivel,
        uint256 timestamp
    );

    event ActivoTransferido(
        uint256 indexed activoId,
        address indexed de,
        address indexed a,
        uint256 timestamp
    );

    event SelloExcelencia(
        uint256 indexed activoId,
        address indexed owner,
        string nombre,
        bytes32 selloHash,
        uint256 timestamp
    );

    event EmailVerificado(address indexed wallet, bytes32 emailHash);

    event SucesionIniciada(address indexed pendingFounder);
    event SucesionConfirmada(address indexed nuevoFounder);
    event ModeSuspension(bool activo, uint256 timestamp);
    event ModoTestCambiado(bool nuevoModo, uint256 timestamp);

    event BajaMALUSO(
        uint256 indexed activoId,
        address indexed wallet,
        string motivo,
        uint256 timestamp
    );

    event ModulosConectados(
        address cert,
        address billing,
        address oracle,
        uint256 timestamp
    );

    // ═══════════════════════════════════════════════════
    // SUSPENSIÓN
    // ═══════════════════════════════════════════════════

    bool public modeSuspension;

    // ═══════════════════════════════════════════════════
    // DESCRIPTIONS ON-CHAIN
    // ═══════════════════════════════════════════════════

    string public constant PV_L1_DESC =
        "PV-L1: Certificacion trimestral Sentinel/Copernicus. Gratuito. Operativo hoy sin acuerdo previo.";
    string public constant PV_L2_DESC =
        "PV-L2: Certificacion trimestral satelital comercial mas validacion cruzada. Bajo acuerdo previo.";
    string public constant PV_L3_DESC =
        "PV-L3: Certificacion trimestral triple fuente independiente. Satelital comercial premium mas IoT en sitio mas validacion cruzada. Bajo acuerdo previo.";

    // ═══════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════

    modifier soloFounder() {
        require(msg.sender == founder, "EPIMELEIA: Solo el founder puede ejecutar esta accion");
        _;
    }

    modifier soloModulos() {
        require(
            msg.sender == contratoCert ||
            msg.sender == contratoBilling ||
            msg.sender == contratoOracle ||
            msg.sender == founder,
            "EPIMELEIA: Solo contratos del protocolo"
        );
        _;
    }

    modifier activoExiste(uint256 activoId) {
        require(activos[activoId].activo, "EPIMELEIA: Activo no registrado o cancelado");
        _;
    }

    modifier soloOwnerActivo(uint256 activoId) {
        require(activos[activoId].owner == msg.sender, "EPIMELEIA: No sos el owner de este activo");
        _;
    }

    modifier noSuspension() {
        require(!modeSuspension, "EPIMELEIA: Sistema en Modo Suspension por fuerza mayor");
        _;
    }

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor() {
        founder = msg.sender;
    }

    // ═══════════════════════════════════════════════════
    // CONFIGURACIÓN POST-DEPLOY
    // ═══════════════════════════════════════════════════

    /**
     * @notice Conecta los 4 contratos del protocolo entre sí.
     * @dev Llamar después de desplegar los 4 contratos.
     */
    function conectarModulos(
        address _cert,
        address _billing,
        address _oracle
    ) external soloFounder {
        require(_cert != address(0) && _billing != address(0) && _oracle != address(0),
            "EPIMELEIA: Direcciones invalidas");
        contratoCert    = _cert;
        contratoBilling = _billing;
        contratoOracle  = _oracle;
        emit ModulosConectados(_cert, _billing, _oracle, block.timestamp);
    }

    /**
     * @notice Cambia entre modo test y producción.
     * @param _modoTest true = valores simbólicos para pruebas, false = valores reales.
     */
    function setModoTest(bool _modoTest) external soloFounder {
        modoTest = _modoTest;
        emit ModoTestCambiado(_modoTest, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO — VERIFICACIÓN EMAIL CORPORATIVO
    // ═══════════════════════════════════════════════════

    /**
     * @notice El founder carga un código de verificación para una wallet.
     * @dev El código llega por email corporativo fuera de la cadena.
     */
    function registrarCodigoVerificacion(bytes32 codigo, address wallet)
        external soloFounder
    {
        codigosVerificacion[codigo] = wallet;
    }

    /**
     * @notice La empresa verifica su email usando el código recibido.
     */
    function verificarEmail(bytes32 codigo, bytes32 emailHash) external {
        require(codigosVerificacion[codigo] == msg.sender,
            "EPIMELEIA: Codigo de verificacion invalido");
        emailsVerificados[emailHash] = true;
        delete codigosVerificacion[codigo];
        emit EmailVerificado(msg.sender, emailHash);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO — REGISTRO DE ACTIVOS (Multi-activo, Ajuste 17)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Registra un nuevo activo certificable.
     * @dev Una misma wallet puede registrar múltiples activos.
     *      Cada activo recibe un ID único global.
     * @param nombre        Nombre interno del sitio operativo.
     * @param tipoActividad Enum de tipo de actividad (0-7).
     * @param nivel         Nivel de validación PV-L1/L2/L3.
     * @param latitud       Latitud x1e6 (ej: -34603700 para -34.6037).
     * @param longitud      Longitud x1e6.
     * @param radioKm       Radio del área operativa en km (1-500).
     * @param emailHash     keccak256 del email corporativo previamente verificado.
     * @return activoId     ID único asignado al nuevo activo.
     */
    function registrarActivo(
        string calldata nombre,
        TipoActividad tipoActividad,
        PVLevel nivel,
        int256 latitud,
        int256 longitud,
        uint256 radioKm,
        bytes32 emailHash
    ) external payable noSuspension returns (uint256 activoId) {

        require(emailsVerificados[emailHash],
            "EPIMELEIA: El email corporativo no fue verificado");
        require(radioKm > 0 && radioKm <= 500,
            "EPIMELEIA: Radio invalido. Debe ser entre 1 y 500 km");
        require(bytes(nombre).length > 0 && bytes(nombre).length <= 100,
            "EPIMELEIA: Nombre invalido");

        // Verificar fee de registro (delegado a Billing)
        uint256 feeRequerido = IEpimeleiaBilling(contratoBilling).getRegistrationFee();
        require(msg.value >= feeRequerido,
            "EPIMELEIA: Fee de registro insuficiente");

        // Asignar ID único
        activoId = nextActivoId;
        nextActivoId++;

        // Crear activo
        Activo storage a = activos[activoId];
        a.activo                    = true;
        a.nombre                    = nombre;
        a.tipoActividad             = tipoActividad;
        a.nivel                     = nivel;
        a.latitud                   = latitud;
        a.longitud                  = longitud;
        a.radioKm                   = radioKm;
        a.emailHash                 = emailHash;
        a.fechaRegistro             = block.timestamp;
        a.estadoCert                = CertStatus.PENDIENTE;
        a.owner                     = msg.sender;
        a.ownerOriginal             = msg.sender;
        a.selloExcelencia           = false;
        a.consecutivosCertificados  = 0;

        // Registrar en mappings de acceso
        activosPorWallet[msg.sender].push(activoId);
        listaActivoIds.push(activoId);

        // Inicializar saldo y billing en contrato hermano
        uint256 saldoInicial = msg.value - feeRequerido;
        IEpimeleiaBilling(contratoBilling).inicializarActivo{value: msg.value}(
            activoId, nivel, saldoInicial
        );

        emit ActivoRegistrado(activoId, msg.sender, nombre, tipoActividad, nivel, block.timestamp);
        return activoId;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO — TRANSFERENCIA DE ACTIVO (Ajuste 18)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Transfiere un activo con su historial completo a otra wallet.
     * @dev El historial (certificaciones, huecos) permanece intacto en EpimeleiaCert.
     *      La nueva wallet pasa a ser la owner del activo.
     * @param activoId  ID del activo a transferir.
     * @param nuevaWallet Dirección que recibirá el activo.
     */
    function transferirActivo(uint256 activoId, address nuevaWallet)
        external
        activoExiste(activoId)
        soloOwnerActivo(activoId)
        noSuspension
    {
        require(nuevaWallet != address(0), "EPIMELEIA: Direccion destino invalida");
        require(nuevaWallet != msg.sender, "EPIMELEIA: El destino es la misma wallet");

        address ownerAnterior = activos[activoId].owner;
        activos[activoId].owner = nuevaWallet;

        // Registrar en el nuevo owner
        activosPorWallet[nuevaWallet].push(activoId);

        // Notificar al contrato de billing del cambio de owner
        IEpimeleiaBilling(contratoBilling).actualizarOwner(activoId, nuevaWallet);

        emit ActivoTransferido(activoId, ownerAnterior, nuevaWallet, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO — SELLO DE EXCELENCIA (Ajuste 19)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Llamado por EpimeleiaCert cuando se detectan 4 trimestres consecutivos certificados.
     * @dev Emite el evento SelloExcelencia con hash único. Solo contratos del protocolo pueden llamar.
     */
    function emitirSelloExcelencia(uint256 activoId)
        external
        soloModulos
        activoExiste(activoId)
    {
        Activo storage a = activos[activoId];

        // Generar hash único del sello
        bytes32 selloHash = keccak256(abi.encodePacked(
            activoId,
            a.owner,
            a.nombre,
            block.timestamp,
            "EPIMELEIA_SELLO_EXCELENCIA_V3.4"
        ));

        a.selloExcelencia = true;

        emit SelloExcelencia(activoId, a.owner, a.nombre, selloHash, block.timestamp);
    }

    /**
     * @notice Actualiza el contador de trimestres consecutivos certificados.
     * @dev Llamado por EpimeleiaCert después de cada certificación o hueco.
     */
    function actualizarConsecutivos(uint256 activoId, uint256 valor)
        external
        soloModulos
        activoExiste(activoId)
    {
        activos[activoId].consecutivosCertificados = valor;
    }

    /**
     * @notice Actualiza el estado de certificación del activo.
     * @dev Llamado por EpimeleiaCert.
     */
    function actualizarEstadoCert(uint256 activoId, CertStatus nuevoEstado)
        external
        soloModulos
        activoExiste(activoId)
    {
        activos[activoId].estadoCert = nuevoEstado;
        if (nuevoEstado == CertStatus.CERTIFICADO) {
            activos[activoId].ultimaCertQ = block.timestamp;
        }
    }

    /**
     * @notice Desactiva un activo (por cancelación o mal uso).
     * @dev Llamado por EpimeleiaBilling (cancelación por saldo) o por founder (mal uso).
     */
    function desactivarActivo(uint256 activoId)
        external
        soloModulos
    {
        activos[activoId].activo = false;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO — BAJA POR MAL USO (Ajuste 23)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Cancela un activo por mal uso del protocolo.
     * @dev Registro permanente on-chain del evento. Sin reembolso.
     * @param activoId ID del activo a cancelar.
     * @param motivo   Descripción del mal uso (grabado permanentemente).
     */
    function bajaPorMalUso(uint256 activoId, string calldata motivo)
        external
        soloFounder
        activoExiste(activoId)
    {
        address walletAfectada = activos[activoId].owner;
        activos[activoId].activo = false;

        // Graba el motivo permanentemente on-chain
        registroBajaMalUso[activoId] = motivo;

        // Notifica billing: sin reembolso en caso de mal uso
        IEpimeleiaBilling(contratoBilling).cancelarSinReembolso(activoId);

        emit BajaMALUSO(activoId, walletAfectada, motivo, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // SUCESIÓN DEL FOUNDER (2 pasos)
    // ═══════════════════════════════════════════════════

    function iniciarSucesion(address nuevoFounder) external soloFounder {
        require(nuevoFounder != address(0), "EPIMELEIA: Direccion invalida");
        pendingFounder = nuevoFounder;
        emit SucesionIniciada(nuevoFounder);
    }

    function confirmarSucesion() external {
        require(msg.sender == pendingFounder, "EPIMELEIA: Solo el pending founder puede confirmar");
        founder = pendingFounder;
        pendingFounder = address(0);
        emit SucesionConfirmada(founder);
    }

    // ═══════════════════════════════════════════════════
    // MODO SUSPENSIÓN — Fuerza Mayor
    // ═══════════════════════════════════════════════════

    function toggleSuspension(bool estado) external soloFounder {
        modeSuspension = estado;
        emit ModeSuspension(estado, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // VISTAS — Control de acceso por rol (Ajuste 11)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Devuelve todos los activos del caller.
     * @dev Cada empresa ve solo sus propios activos.
     */
    function getMisActivos() external view returns (uint256[] memory) {
        return activosPorWallet[msg.sender];
    }

    /**
     * @notice El founder puede ver los activos de cualquier wallet.
     */
    function getActivosDeWallet(address wallet)
        external view returns (uint256[] memory)
    {
        require(
            msg.sender == founder || msg.sender == wallet,
            "EPIMELEIA: Acceso denegado — solo founder o el propio owner"
        );
        return activosPorWallet[wallet];
    }

    /**
     * @notice Datos completos de un activo (founder o owner del activo).
     */
    function getActivo(uint256 activoId)
        external view
        returns (
            bool activo,
            PVLevel nivel,
            TipoActividad tipoActividad,
            CertStatus estadoCert,
            uint256 fechaRegistro,
            uint256 ultimaCertQ,
            int256 latitud,
            int256 longitud,
            uint256 radioKm,
            string memory nombre,
            address owner,
            address ownerOriginal,
            bool selloExcelencia,
            uint256 consecutivosCertificados
        )
    {
        require(
            msg.sender == founder ||
            msg.sender == activos[activoId].owner ||
            msg.sender == contratoCert ||
            msg.sender == contratoBilling ||
            msg.sender == contratoOracle,
            "EPIMELEIA: Acceso denegado"
        );
        Activo storage a = activos[activoId];
        return (
            a.activo, a.nivel, a.tipoActividad, a.estadoCert,
            a.fechaRegistro, a.ultimaCertQ,
            a.latitud, a.longitud, a.radioKm,
            a.nombre, a.owner, a.ownerOriginal,
            a.selloExcelencia, a.consecutivosCertificados
        );
    }

    /**
     * @notice Badge público del activo — Ajuste 12.
     * @dev Solo expone nombre, nivel PV y estado. Sin datos privados.
     * @return nombre               Nombre del activo.
     * @return nivelPV              Descripción del nivel de validación.
     * @return estadoCertificacion  Estado actual (0=PENDIENTE, 1=CERTIFICADO, 2=HUECO).
     * @return selloExcelencia      Si tiene el Sello de Excelencia ambiental.
     * @return continuidad          Índice de continuidad (calculado en Billing).
     */
    function getBadgePublico(uint256 activoId)
        external view
        returns (
            string memory nombre,
            string memory nivelPV,
            uint8 estadoCertificacion,
            bool selloExcelencia,
            uint256 continuidad
        )
    {
        Activo storage a = activos[activoId];
        require(a.fechaRegistro > 0, "EPIMELEIA: Activo no existe");

        string memory desc;
        if (a.nivel == PVLevel.L1) desc = PV_L1_DESC;
        else if (a.nivel == PVLevel.L2) desc = PV_L2_DESC;
        else desc = PV_L3_DESC;

        uint256 cont = IEpimeleiaBilling(contratoBilling).getIndiceContinuidad(activoId);

        return (
            a.nombre,
            desc,
            uint8(a.estadoCert),
            a.selloExcelencia,
            cont
        );
    }

    /**
     * @notice Fecha de vencimiento del próximo billing y próxima ventana satelital — Ajuste 13.
     */
    function getProximosVencimientos(uint256 activoId)
        external view
        returns (
            uint256 diasHastaBilling,
            uint256 diasHastaVentana
        )
    {
        return IEpimeleiaBilling(contratoBilling).getProximosVencimientos(activoId);
    }

    /**
     * @notice Total de activos registrados en el protocolo.
     */
    function getTotalActivos() external view returns (uint256) {
        return listaActivoIds.length;
    }

    /**
     * @notice Lista completa de IDs de activos (para el oracle).
     */
    function getListaActivoIds() external view returns (uint256[] memory) {
        return listaActivoIds;
    }

    /**
     * @notice Datos mínimos de un activo necesarios para el oracle.
     * @dev Acceso público para que el oracle.js pueda operar.
     */
    function getDatosOracle(uint256 activoId)
        external view
        returns (
            bool activo,
            PVLevel nivel,
            TipoActividad tipoActividad,
            int256 latitud,
            int256 longitud,
            uint256 radioKm,
            address owner
        )
    {
        Activo storage a = activos[activoId];
        return (a.activo, a.nivel, a.tipoActividad, a.latitud, a.longitud, a.radioKm, a.owner);
    }

    /**
     * @notice Descripción del nivel de validación de un activo.
     */
    function getNivelDesc(uint256 activoId) external view returns (string memory) {
        PVLevel nivel = activos[activoId].nivel;
        if (nivel == PVLevel.L1) return PV_L1_DESC;
        if (nivel == PVLevel.L2) return PV_L2_DESC;
        return PV_L3_DESC;
    }
}

// ═══════════════════════════════════════════════════════
// INTERFACES — para comunicación entre contratos
// ═══════════════════════════════════════════════════════

interface IEpimeleiaBilling {
    function getRegistrationFee() external view returns (uint256);
    function inicializarActivo(uint256 activoId, EpimeleiaCore.PVLevel nivel, uint256 saldoInicial) external payable;
    function actualizarOwner(uint256 activoId, address nuevoOwner) external;
    function cancelarSinReembolso(uint256 activoId) external;
    function getIndiceContinuidad(uint256 activoId) external view returns (uint256);
    function getProximosVencimientos(uint256 activoId) external view returns (uint256, uint256);
}
