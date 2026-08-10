const { CONFIG, ESTADOS } = require('../config');
const { normalizar } = require('../utils/helpers');
const logger = require('../services/logger');
const FlujoResultados = require('./flujoResultados');
const FlujoSucursales = require('./flujoSucursales');
const FlujoCotizacion = require('./flujoCotizacion');
const LLMClassifier = require('../services/llmClassifier');

function toTitleCase(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/(?:^|\s|[()-])[\wáéíóúñÁÉÍÓÚÑ]/g, match => match.toUpperCase());
}

class ManejadorComandos {
    constructor(client, cache, estados, db, geo, catalogo, flowDefinition = null, llmClassifier = null) {
        this.client = client;
        this.cache = cache;
        this.estados = estados;
        this.db = db;
        this.geo = geo;
        this.catalogo = catalogo;
        this.flow = flowDefinition;

        // Se puede inyectar para las pruebas; si no, se construye desde CONFIG.NLU.
        this.llmClassifier = llmClassifier || new LLMClassifier(CONFIG.NLU);

        // Inicializar los sub-flujos
        this.flujoResultados = new FlujoResultados(client, estados, db, flowDefinition);
        this.flujoSucursales = new FlujoSucursales(client, cache, estados, geo, flowDefinition);
        this.flujoCotizacion = new FlujoCotizacion(
            client, estados, catalogo, cache, flowDefinition, this.llmClassifier
        );
    }

    async procesarMensaje(accountId, conversationId, mensajeNormalizado, mensajeOriginal, labels = [], contexto = {}) {
        logger.info('BOT_IN', 'Mensaje recibido por orquestador', {
            accountId,
            conversationId,
            mensajeOriginal,
            mensajeNormalizado,
            labels,
            contexto: {
                ubicacion: contexto.ubicacion || null,
                telefono: contexto.telefono || null
            }
        });

        // 1. BLOQUEO POR ETIQUETA
        if (labels && labels.includes('esperando_paciente')) {
            this.logRuta(conversationId, 'silencio_por_etiqueta_esperando_paciente');
            console.log(`[BOT] 🤫 Silenciado en conversación ${conversationId} por etiqueta 'esperando_paciente'`);
            return "silence";
        }

        const estadoConv = this.estados.obtener(conversationId);
        logger.debug('BOT_STATE', 'Estado antes de procesar mensaje', {
            conversationId,
            estado: estadoConv.estado,
            datos: estadoConv.datos
        });

        // 2. Comandos globales (menú / inicio)
        if (this.esComandoMenuGlobal(mensajeNormalizado)) {
            this.logRuta(conversationId, 'comando_global_menu', { mensajeNormalizado });
            const estadoActual = this.estados.obtener(conversationId);

            // Si el usuario escribe exactamente "inicio" o "ir al inicio", o si estaba hablando con asesor (estado AGENTE)
            // reiniciamos por completo para volver a preguntar sucursal
            const comandoGlobal = this.limpiarComandoGlobal(mensajeNormalizado);
            if (['inicio', 'ir al inicio', 'volver al inicio'].includes(comandoGlobal) || estadoActual.estado === ESTADOS.AGENTE) {
                this.estados.reiniciar(conversationId);
                return this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
            }

            // Para otros comandos globales (como "menu"), si ya tiene sucursal, lo mandamos al menú
            if (estadoActual.datos?.sucursalAsignada) {
                this.estados.actualizar(conversationId, ESTADOS.MENU);
                return this.mostrarMenuPrincipal(accountId, conversationId);
            }

            this.estados.reiniciar(conversationId);
            return this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
        }

        // 3. Si un agente humano ya tomó la conversación
        if (estadoConv.estado === ESTADOS.AGENTE) {
            this.logRuta(conversationId, 'ignorado_por_estado_agente');
            return;
        }

        // 4. Ubicación compartida desde Chatwoot/WhatsApp.
        if (contexto.ubicacion) {
            this.logRuta(conversationId, 'ubicacion_compartida', contexto.ubicacion);
            return this.flujoSucursales.manejarUbicacionCompartida(accountId, conversationId, contexto.ubicacion);
        }

        // 5. PROTECCIÓN MULTIMEDIA
        if (!mensajeOriginal || mensajeOriginal.trim() === "") {
            this.logRuta(conversationId, 'multimedia_sin_texto');
            console.log(`[BOT] 📦 Multimedia detectado en conv ${conversationId}. Ignorando para permitir descarga.`);
            return "silence";
        }

        if (estadoConv.estado === ESTADOS.INICIO) {
            this.logRuta(conversationId, 'inicio_mostrar_bienvenida');
            await this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
            if (this.contieneCodigoPostal(mensajeOriginal)) {
                this.logRuta(conversationId, 'inicio_procesar_cp_en_primer_mensaje');
                return this.flujoSucursales.manejarEntradaUbicacion(accountId, conversationId, mensajeOriginal);
            }
            return;
        }

        if ([
            ESTADOS.ESPERANDO_UBICACION,
            ESTADOS.CONFIRMANDO_SUCURSAL,
            ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA
        ].includes(estadoConv.estado) && this.esSolicitudAsesor(
            mensajeNormalizado,
            estadoConv.estado !== ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA
        )) {
            this.logRuta(conversationId, 'solicitud_asesor_en_flujo_ubicacion', {
                estado: estadoConv.estado
            });
            return this.transferirAAgente(accountId, conversationId);
        }

        if ([
            ESTADOS.ESPERANDO_UBICACION,
            ESTADOS.CONFIRMANDO_SUCURSAL,
            ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA
        ].includes(estadoConv.estado)) {
            this.logRuta(conversationId, 'delegar_flujo_ubicacion', {
                estado: estadoConv.estado
            });
            switch (estadoConv.estado) {
                case ESTADOS.ESPERANDO_UBICACION:
                    return this.flujoSucursales.manejarEntradaUbicacion(accountId, conversationId, mensajeOriginal);
                case ESTADOS.CONFIRMANDO_SUCURSAL:
                    return this.flujoSucursales.manejarConfirmacionSucursal(accountId, conversationId, mensajeNormalizado);
                case ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA:
                    return this.flujoSucursales.manejarSeleccionSucursalCercana(accountId, conversationId, mensajeNormalizado);
            }
        }

        // 6. Detección de comandos de navegación
        // Los valores numericos dentro de cotizacion pertenecen al flujo activo,
        // no a las opciones globales del menu principal.
        this.logRuta(conversationId, 'evaluar_estado_activo', {
            estado: estadoConv.estado
        });
        switch (estadoConv.estado) {
            case ESTADOS.COTIZACION_FORMA_BUSQUEDA:
                this.logRuta(conversationId, 'cotizacion_forma_busqueda');
                return this.flujoCotizacion.manejarFormaBusqueda(
                    accountId,
                    conversationId,
                    mensajeOriginal,
                    this.transferirAAgente.bind(this, accountId, conversationId)
                );
            case ESTADOS.COTIZACION_BUSCAR_ESTUDIO:
                if (this.esSolicitudAsesor(mensajeNormalizado)) {
                    this.logRuta(conversationId, 'cotizacion_buscar_estudio_asesor');
                    return this.transferirAAgente(accountId, conversationId);
                }
                this.logRuta(conversationId, 'cotizacion_buscar_estudio');
                return this.flujoCotizacion.manejarBusquedaEstudio(
                    accountId, conversationId, mensajeOriginal, {
                        transferirAAgente: this.transferirAAgente.bind(this, accountId, conversationId),
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId),
                        hayAsesores: this.esHorarioAtencion.bind(this)
                    }
                );
            case ESTADOS.COTIZACION_CONFIRMAR_ESTUDIOS:
                if (this.esSolicitudAsesor(mensajeNormalizado)) {
                    this.logRuta(conversationId, 'cotizacion_confirmar_estudios_asesor');
                    return this.transferirAAgente(accountId, conversationId);
                }
                this.logRuta(conversationId, 'cotizacion_confirmar_estudios');
                return this.flujoCotizacion.manejarSeleccionEstudio(accountId, conversationId, mensajeOriginal);
            case ESTADOS.COTIZACION_POST_COTIZACION:
                this.logRuta(conversationId, 'cotizacion_post_cotizacion');
                return this.flujoCotizacion.manejarPostCotizacion(
                    accountId,
                    conversationId,
                    mensajeOriginal,
                    {
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId),
                        transferirAAgente: this.transferirAAgente.bind(this, accountId, conversationId)
                    }
                );
            case ESTADOS.PRECIOS_PASO_UNO:
                this.logRuta(conversationId, 'precios_paso_uno_buscar_estudio');
                return this.flujoCotizacion.manejarBusquedaEstudio(
                    accountId, conversationId, mensajeOriginal, {
                        transferirAAgente: this.transferirAAgente.bind(this, accountId, conversationId),
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId),
                        hayAsesores: this.esHorarioAtencion.bind(this)
                    }
                );
            case ESTADOS.RESULTADOS_METODO_BUSQUEDA:
                this.logRuta(conversationId, 'resultados_metodo_busqueda');
                return this.flujoResultados.manejarMetodoBusqueda(
                    accountId,
                    conversationId,
                    mensajeNormalizado,
                    this.transferirAAgente.bind(this, accountId, conversationId)
                );
            case ESTADOS.RESULTADOS_ESPERANDO_DATO:
                this.logRuta(conversationId, 'resultados_esperando_dato');
                return this.flujoResultados.manejarDatoBusqueda(accountId, conversationId, mensajeOriginal);
            case ESTADOS.RESULTADOS_ACCION:
                this.logRuta(conversationId, 'resultados_accion');
                return this.flujoResultados.manejarAccionResultados(
                    accountId,
                    conversationId,
                    mensajeNormalizado,
                    {
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId),
                        transferirAAgente: this.transferirAAgente.bind(this, accountId, conversationId)
                    }
                );
            case ESTADOS.SUCURSAL_DETALLES:
                this.logRuta(conversationId, 'sucursal_detalles');
                return this.flujoSucursales.manejarAccionDetalles(
                    accountId,
                    conversationId,
                    mensajeOriginal,
                    {
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId)
                    }
                );
        }

        if (this.esSolicitudDireccion(mensajeNormalizado)) {
            this.logRuta(conversationId, 'solicitud_direccion_natural');
            const respuestaDireccion = await this.manejarSolicitudDireccionNatural(
                accountId,
                conversationId,
                mensajeOriginal
            );
            if (respuestaDireccion !== null) return respuestaDireccion;
        }

        const comandoDetectado = this.detectarComandoNavegacion(mensajeNormalizado, mensajeOriginal);
        if (comandoDetectado) {
            this.logRuta(conversationId, 'comando_navegacion_detectado', {
                comandoDetectado
            });
            if (!estadoConv.datos?.sucursalAsignada) {
                this.logRuta(conversationId, 'comando_sin_sucursal_asignada');
                return this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
            }
            // Se pasa el mensaje original, no el comando ya resuelto: manejarMenu vuelve a
            // detectarlo y ademas conserva el dato (por ejemplo el folio que el paciente escribio).
            return this.manejarMenu(accountId, conversationId, mensajeOriginal);
        }

        // 7. Máquina de estados delegada
        this.logRuta(conversationId, 'maquina_estados_delegada', {
            estado: estadoConv.estado
        });
        switch (estadoConv.estado) {
            case ESTADOS.ESPERANDO_UBICACION:
                return this.flujoSucursales.manejarEntradaUbicacion(accountId, conversationId, mensajeOriginal);
            case ESTADOS.CONFIRMANDO_SUCURSAL:
                return this.flujoSucursales.manejarConfirmacionSucursal(accountId, conversationId, mensajeNormalizado);
            case ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA:
                return this.flujoSucursales.manejarSeleccionSucursalCercana(accountId, conversationId, mensajeNormalizado);
            case ESTADOS.MENU:
                return this.manejarMenu(accountId, conversationId, mensajeNormalizado);
            case ESTADOS.ESPERANDO_ESTADO:
                return this.flujoSucursales.manejarSeleccionEstado(accountId, conversationId, mensajeNormalizado);
            case ESTADOS.ESPERANDO_MUNICIPIO:
                return this.flujoSucursales.manejarSeleccionBusqueda(accountId, conversationId, mensajeOriginal);
            case ESTADOS.ESPERANDO_SUCURSAL:
                return this.flujoSucursales.manejarSeleccionSucursal(accountId, conversationId, mensajeOriginal);
            case ESTADOS.ESPERANDO_CONSULTA_ID:
                return this.flujoResultados.manejarConsultaResultados(accountId, conversationId, mensajeOriginal);
            case ESTADOS.RESULTADOS_METODO_BUSQUEDA:
                return this.flujoResultados.manejarMetodoBusqueda(
                    accountId,
                    conversationId,
                    mensajeNormalizado,
                    this.transferirAAgente.bind(this, accountId, conversationId)
                );
            case ESTADOS.RESULTADOS_ESPERANDO_DATO:
                return this.flujoResultados.manejarDatoBusqueda(accountId, conversationId, mensajeOriginal);
            case ESTADOS.RESULTADOS_ACCION:
                return this.flujoResultados.manejarAccionResultados(
                    accountId,
                    conversationId,
                    mensajeNormalizado,
                    {
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId),
                        transferirAAgente: this.transferirAAgente.bind(this, accountId, conversationId)
                    }
                );
            case ESTADOS.ESPERANDO_CONFIRMACION:
                return this.manejarConfirmacionAyuda(accountId, conversationId, mensajeNormalizado);
            default:
                this.logRuta(conversationId, 'fallback_mostrar_menu_principal', {
                    estado: estadoConv.estado
                });
                const rutaIA = await this.intentarRutaIA(accountId, conversationId, mensajeOriginal, 'fallback');
                if (rutaIA) return rutaIA.resultado;
                return this.mostrarMenuPrincipal(accountId, conversationId, 'No entendí tu mensaje. Puedes elegir una opción o escribirme directamente qué estudio necesitas.');
        }
    }

    /**
     * Consulta al clasificador SOLO cuando lo determinista ya falló.
     * Devuelve { resultado } si la IA se hizo cargo, o null para seguir con el flujo de siempre.
     * En modo sombra registra lo que habría hecho y devuelve null.
     */
    async intentarRutaIA(accountId, conversationId, mensajeOriginal, origen) {
        if (!this.llmClassifier?.disponible?.()) return null;

        let clasificacion = null;
        try {
            clasificacion = await this.llmClassifier.clasificarIntencion(mensajeOriginal);
        } catch (e) {
            logger.error('LLM_ERROR', 'Fallo al clasificar', { error: e.message });
            return null;
        }

        if (!clasificacion || clasificacion.intent === 'desconocido') return null;

        if (!this.llmClassifier.decide()) {
            this.logRuta(conversationId, 'llm_sombra', { origen, ...clasificacion });
            return null;
        }

        this.logRuta(conversationId, 'llm_redireccion', { origen, ...clasificacion });
        return { resultado: await this.ejecutarIntencionLLM(accountId, conversationId, clasificacion) };
    }

    async ejecutarIntencionLLM(accountId, conversationId, clasificacion) {
        if (clasificacion.intent === 'cotizacion' || clasificacion.intent === 'indicaciones') {
            const estadoActual = this.estados.obtener(conversationId);
            if (!estadoActual.datos?.sucursalAsignada) {
                return this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
            }
            // Sin termino de busqueda no hay nada que consultar: se abre el flujo normal.
            if (String(clasificacion.query || '').trim().length < 2) {
                return this.flujoCotizacion.iniciar(accountId, conversationId);
            }
            this.estados.actualizar(conversationId, ESTADOS.COTIZACION_BUSCAR_ESTUDIO, {
                tipoServicio: 'laboratorio',
                estudiosDisponibles: []
            });
            return this.flujoCotizacion.manejarBusquedaEstudio(
                accountId, conversationId, clasificacion.query, {
                        transferirAAgente: this.transferirAAgente.bind(this, accountId, conversationId),
                        mostrarMenu: this.mostrarMenuPrincipal.bind(this, accountId, conversationId),
                        hayAsesores: this.esHorarioAtencion.bind(this)
                    }
            );
        } else if (clasificacion.intent === 'sucursal') {
            const resp = await this.manejarSolicitudDireccionNatural(accountId, conversationId, clasificacion.query || '');
            if (resp !== null) return resp;
            // No se reconocio ninguna sucursal en el texto ("a que hora abren"). Si el
            // paciente YA eligio una, mostrarsela; reiniciar le borraria su seleccion.
            if (this.estados.obtener(conversationId).datos?.sucursalAsignada) {
                return this.flujoSucursales.mostrarSucursalAsignada(accountId, conversationId);
            }
            return this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
        } else if (clasificacion.intent === 'asesor') {
            return this.manejarMenu(accountId, conversationId, '4');
        }
        return this.mostrarMenuPrincipal(accountId, conversationId);
    }

    logRuta(conversationId, ruta, datos = {}) {
        logger.debug('ROUTE', ruta, {
            conversationId,
            ...datos
        });
    }

    detectarComandoNavegacion(mensajeNormalizado, mensajeOriginal) {
        if (!mensajeOriginal || typeof mensajeOriginal !== 'string') return null;
        if (['1', '2', '3', '4'].includes(mensajeNormalizado)) return mensajeNormalizado;
        // Un numero largo suelto solo puede ser un folio: el paciente quiere resultados.
        if (/^\s*\d{5,}\s*$/.test(mensajeOriginal)) return '2';
        const texto = mensajeOriginal.toLowerCase();
        if (texto.includes('cotizar') || texto.includes('precio') || texto.includes('costo') || texto.includes('estudio')) return '1';
        if (texto.includes('resultado') || texto.includes('folio')) return '2';
        if ((texto.includes('horario') || texto.includes('direccion') || texto.includes('dirección') || texto.includes('sucursal')) && !texto.includes('inicio')) return '3';
        if (texto.includes('asesor') || texto.includes('hablar')) return '4';
        return null;
    }

    esSolicitudDireccion(mensaje) {
        return mensaje.includes('direccion') ||
            mensaje.includes('dirección') ||
            mensaje.includes('horario') ||
            mensaje.includes('como llegar') ||
            mensaje.includes('ubicacion') ||
            mensaje.includes('ubicación');
    }

    async manejarSolicitudDireccionNatural(accountId, conversationId, mensajeOriginal) {
        if (!this.cache?.obtenerDatos) return null;

        const texto = normalizar(mensajeOriginal);
        if (!texto) return null;

        const datos = await this.cache.obtenerDatos();
        const coincidencia = this.buscarSucursalOMunicipioEnTexto(datos, texto);
        if (!coincidencia) return null;

        if (coincidencia.sedes.length === 1) {
            return this.flujoSucursales.enviarDetallesSucursal(
                accountId,
                conversationId,
                coincidencia.sedes[0]
            );
        }

        this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_SUCURSAL, {
            estadoSeleccionado: coincidencia.estado,
            municipios: [coincidencia.municipio],
            sedesDisponibles: coincidencia.sedes
        });

        return this.flujoSucursales.enviarPaginaSedes(accountId, conversationId, 0);
    }

    buscarSucursalOMunicipioEnTexto(datos, textoNormalizado) {
        for (const [estado, municipios] of Object.entries(datos || {})) {
            for (const [municipio, sedes] of Object.entries(municipios || {})) {
                if (textoNormalizado.includes(normalizar(municipio))) {
                    return { estado, municipio, sedes };
                }

                const sede = (sedes || []).find(item => {
                    const titulo = normalizar(item.titulo || item.nombre || '');
                    const tituloLimpio = normalizar(
                        String(item.titulo || item.nombre || '')
                            .replace('SUCURSAL ', '')
                            .replace(' MATRIZ', '')
                            .replace(/[()]/g, '')
                    );

                    return (titulo && textoNormalizado.includes(titulo)) ||
                        (tituloLimpio && textoNormalizado.includes(tituloLimpio));
                });

                if (sede) return { estado, municipio, sedes: [sede] };
            }
        }

        return null;
    }

    // Sin quitar la puntuacion, "Inicio." no casa y el usuario se queda sin escape.
    limpiarComandoGlobal(mensaje) {
        return String(mensaje || '')
            .replace(/[^\wáéíóúñ\s]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    esComandoMenuGlobal(mensaje) {
        return ['0', 'menu', 'inicio', 'volver', 'volver al inicio', 'ir al inicio']
            .includes(this.limpiarComandoGlobal(mensaje));
    }

    contieneCodigoPostal(mensaje) {
        return /\b\d{5}\b/.test(String(mensaje || ''));
    }

    esSolicitudAsesor(mensaje, permitirNumero = true) {
        return (permitirNumero && mensaje === '4') || mensaje.includes('asesor') || mensaje.includes('hablar');
    }

    async mostrarMenuPrincipal(accountId, conversationId, aviso = '') {
        const estadoActual = this.estados.obtener(conversationId);
        const sucursal = estadoActual.datos?.sucursalAsignada;

        logger.info('BOT_MENU', 'Mostrando menu principal', {
            accountId,
            conversationId,
            sucursal
        });

        if (!sucursal) {
            this.logRuta(conversationId, 'menu_sin_sucursal_regresa_ubicacion');
            return this.flujoSucursales.iniciarFlujoUbicacion(accountId, conversationId);
        }

        this.estados.actualizar(conversationId, ESTADOS.MENU);
        const pregunta = this.extraerPreguntaMenu('4', '¿En qué podemos ayudarte hoy?');
        return this.client.enviarListaDesplegable(
            accountId, conversationId,
            `${aviso ? aviso + '\n\n' : ''}${pregunta}\n\n📍 Sucursal ${this.nombreSucursal(sucursal)}:`,
            "Seleccionar",
            [
                { title: "1️⃣ Cotizar servicios", value: "1" },
                { title: "2️⃣ Consultar resultados", value: "2" },
                { title: "3️⃣ Dirección y horarios", value: "3" },
                { title: "4️⃣ Hablar con un asesor", value: "4" }
            ]
        );
    }

    async manejarMenu(accountId, conversationId, mensaje) {
        const opcion = this.detectarComandoNavegacion(mensaje, mensaje) || mensaje;
        logger.info('BOT_MENU', 'Opcion de menu recibida', {
            accountId,
            conversationId,
            mensaje,
            opcion
        });
        if (opcion === "1") {
            return this.flujoCotizacion.iniciar(accountId, conversationId);
        }
        if (opcion === "2") {
            // Si el propio mensaje YA era el folio, consultarlo en vez de volver a pedirlo.
            const folio = String(mensaje || '').trim();
            if (/^\d{5,}$/.test(folio)) {
                this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
                    metodoBusqueda: 'folio',
                    datoBusqueda: null,
                    resultadoConsulta: null,
                    intentos: 0
                });
                return this.flujoResultados.manejarDatoBusqueda(accountId, conversationId, folio);
            }
            return this.flujoResultados.iniciar(accountId, conversationId);
        }
        if (opcion === "3") {
            return this.flujoSucursales.mostrarSucursalAsignada(accountId, conversationId);
        }
        if (opcion === "4") {
            return this.transferirAAgente(accountId, conversationId);
        }

        // El usuario escribio algo en el menu que ningun patron reconocio: aqui si vale la pena la IA.
        const rutaIA = await this.intentarRutaIA(accountId, conversationId, mensaje, 'menu');
        if (rutaIA) return rutaIA.resultado;

        return this.mostrarMenuPrincipal(accountId, conversationId, 'No entendí tu mensaje. Puedes elegir una opción o escribirme directamente qué estudio necesitas.');
    }

    nombreSucursal(sucursal) {
        const nombreLimpio = String(sucursal.titulo || sucursal.nombre || 'Sucursal')
            .replace("SUCURSAL ", "")
            .replace(" MATRIZ", "")
            .replace(/[()]/g, '')
            .trim();
        return toTitleCase(nombreLimpio);
    }

    async manejarConfirmacionAyuda(accountId, conversationId, mensaje) {
        const msg = normalizar(mensaje);
        if (['si', 'sii', 'claro', 'asesor', 'ayuda'].some(w => msg.includes(w))) return this.transferirAAgente(accountId, conversationId);
        if (['no', 'gracias', 'nada', 'todo bien'].some(w => msg.includes(w))) {
            await this.client.enviarTexto(accountId, conversationId, "Muchas gracias por su preferencia💙\n¡Que tenga un excelente día!");
            this.estados.reiniciar(conversationId);
            return;
        }
        return this.mostrarMenuPrincipal(accountId, conversationId);
    }

    textoFlujo(stepId, fallback, variables = {}) {
        try {
            const texto = this.flow?.respuesta(stepId, variables);
            return texto || fallback;
        } catch (_error) {
            return fallback;
        }
    }

    extraerPreguntaMenu(stepId, fallback) {
        const texto = this.textoFlujo(stepId, fallback);
        const linea = texto
            .split('\n')
            .map(item => item.trim())
            .find(item => item && !/^\d/.test(item));

        return linea || fallback;
    }

    esHorarioAtencion() {
        const fechaMexico = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
        const dia = fechaMexico.getDay(), hora = fechaMexico.getHours(), minutos = fechaMexico.getMinutes();
        const esEntreSemana = (dia >= 1 && dia <= 5) && (hora >= 6 && hora < 19);
        const esSabado = (dia === 6) && (hora >= 6 && hora < 16);
        const esDomingo = (dia === 0) && ((hora > 6 && hora < 14) || (hora === 6 && minutos >= 30));
        return esEntreSemana || esSabado || esDomingo;
    }

    async transferirAAgente(accountId, conversationId) {
        logger.info('AGENTE', 'Transferencia a asesor solicitada', {
            accountId,
            conversationId,
            horarioAtencion: this.esHorarioAtencion()
        });
        if (!this.esHorarioAtencion()) {
            await this.client.enviarTexto(accountId, conversationId, "⚠️ Por el momento no hay asesores disponibles.\n\n🕒 Horario de atención:\n• L-V: 6am-7pm\n• S: 6am-4pm\n• D: 6:30am-2pm");
            return this.mostrarMenuPrincipal(accountId, conversationId);
        }
        await this.client.enviarTexto(accountId, conversationId, "Un asesor se pondrá en contacto contigo en breve.");
        await this.client.crearNotaPrivada(accountId, conversationId, "⚠️ USUARIO SOLICITA AGENTE. BOT PAUSADO.");

        // Devolver la conversacion a la cola humana de Chatwoot. Sin esto la nota privada
        // queda ahi y nadie recibe aviso: el paciente espera a un asesor que no sabe que existe.
        // wa-test.js no implementa este metodo, de ahi la guarda.
        if (typeof this.client.abrirParaHumano === 'function') {
            await this.client.abrirParaHumano(accountId, conversationId, {
                teamId: CONFIG.CHATWOOT_TEAM_ID,
                assigneeId: CONFIG.CHATWOOT_ASSIGNEE_ID
            });
        }

        this.estados.actualizar(conversationId, ESTADOS.AGENTE);
        this.iniciarRecordatorioEspera(accountId, conversationId);
    }

    iniciarRecordatorioEspera(accountId, conversationId) {
        // Un temporizador por transferencia: si el usuario pide asesor varias veces se apilaban.
        // Se guarda para poder cancelar el anterior.
        this.recordatorios = this.recordatorios || new Map();
        clearTimeout(this.recordatorios.get(conversationId));

        const temporizador = setTimeout(async () => {
            this.recordatorios.delete(conversationId);
            try {
                if (this.estados.obtener(conversationId).estado === ESTADOS.AGENTE) {
                    await this.client.enviarTexto(accountId, conversationId, "⏳ Seguimos atendiendo tu solicitud, por favor no te desconectes.");
                }
            } catch (error) {
                logger.warn('AGENTE', 'No se pudo enviar el recordatorio de espera', {
                    conversationId,
                    error: error.message
                });
            }
        }, 7 * 60 * 1000);

        // Sin unref, este temporizador mantiene vivo el proceso 7 minutos despues de terminar.
        if (typeof temporizador.unref === 'function') temporizador.unref();
        this.recordatorios.set(conversationId, temporizador);
    }

    async manejarDespedida(accountId, conversationId) {
        this.estados.reiniciar(conversationId);
        await this.mostrarMenuPrincipal(accountId, conversationId);
    }
}

module.exports = ManejadorComandos;
