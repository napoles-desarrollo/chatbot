const { ESTADOS } = require('../config');
const { normalizar } = require('../utils/helpers');
const logger = require('../services/logger');

class FlujoCotizacion {
    constructor(client, estados, catalogo, sucursales, flowDefinition = null, llmClassifier = null) {
        this.client = client;
        this.estados = estados;
        this.catalogo = catalogo;
        this.sucursales = sucursales;
        this.flow = flowDefinition;
        this.llmClassifier = llmClassifier;
    }

    /**
     * Ultimo recurso cuando la tabla de alias, el LIKE de SQL y la busqueda difusa
     * fallaron con un termino. Devuelve el termino reescrito o null.
     */
    async normalizarTerminoConIa(termino) {
        const clf = this.llmClassifier;
        if (!clf?.disponible?.()) return null;

        let clasificacion = null;
        try {
            clasificacion = await clf.clasificarIntencion(termino);
        } catch (error) {
            logger.warn('COTIZACION', 'Fallo normalizando termino con IA', {
                termino,
                error: error.message
            });
            return null;
        }

        // Aqui el contexto ya dice que el usuario esta nombrando un estudio: exigir ademas que el
        // modelo acierte la intencion tiraba normalizaciones utiles etiquetadas como "desconocido".
        // Solo se descarta lo que claramente NO es una busqueda de catalogo.
        if (!clasificacion || ['asesor', 'sucursal'].includes(clasificacion.intent)) return null;

        const query = String(clasificacion.query || '').trim();
        // Si no cambia nada, repetir la consulta seria gastar otra ida a SQL para nada.
        if (query.length < 2 || normalizar(query) === normalizar(termino)) return null;

        if (!clf.decide?.()) {
            logger.info('COTIZACION', 'IA en modo sombra: habria reescrito el termino', {
                termino,
                query
            });
            return null;
        }

        logger.info('COTIZACION', 'Termino reescrito por la IA', { termino, query });
        return query;
    }

    /** Busca un termino y, si no hay nada, lo reintenta una sola vez con el termino reescrito. */
    async buscarEstudiosConRescate(estado, termino) {
        const comunes = {
            tipoServicio: estado.datos?.tipoServicio,
            sucursal: estado.datos?.sucursalAsignada
        };

        const estudios = await this.catalogo.buscarEstudios({ texto: termino, ...comunes });
        if (Array.isArray(estudios) && estudios.length > 0) {
            return { estudios, termino, rescatado: false };
        }

        const reescrito = await this.normalizarTerminoConIa(termino);
        if (!reescrito) return { estudios: estudios || [], termino, rescatado: false };

        const rescatados = await this.catalogo.buscarEstudios({ texto: reescrito, ...comunes });
        logger.info('COTIZACION', 'Reintento con termino reescrito', {
            termino,
            reescrito,
            encontrados: Array.isArray(rescatados) ? rescatados.length : 0
        });

        if (!Array.isArray(rescatados) || rescatados.length === 0) {
            return { estudios: [], termino, rescatado: false };
        }

        return { estudios: rescatados, termino: reescrito, rescatado: true };
    }

    async iniciar(accountId, conversationId) {
        const estado = this.estados.obtener(conversationId);
        let sucursal = estado.datos?.sucursalAsignada;
        logger.info('COTIZACION', 'Iniciando flujo de cotizacion', {
            accountId,
            conversationId,
            sucursal,
            catalogoDisponible: Boolean(this.catalogo)
        });

        if (this.catalogo && sucursal && !sucursal.lista_precio && this.sucursales?.actualizarSucursal) {
            try {
                logger.info('COTIZACION', 'Sucursal sin lista_precio, intentando refrescar catalogo', {
                    conversationId,
                    sucursal
                });
                const actualizada = await this.sucursales.actualizarSucursal(sucursal);
                if (actualizada) {
                    sucursal = actualizada;
                    this.estados.actualizar(conversationId, estado.estado, {
                        sucursalAsignada: actualizada
                    });
                    logger.info('COTIZACION', 'Sucursal refrescada para cotizacion', {
                        conversationId,
                        actualizada
                    });
                }
            } catch (error) {
                logger.error('COTIZACION', 'No se pudo actualizar sucursal antes de cotizar', {
                    conversationId,
                    error: error.stack || error.message || String(error)
                });
                console.error('No se pudo actualizar la sucursal antes de cotizar:', error.message);
            }
        }

        if (!this.catalogo || !sucursal?.lista_precio) {
            logger.warn('COTIZACION', 'Catalogo no disponible o sucursal sin lista_precio', {
                conversationId,
                sucursal,
                catalogoDisponible: Boolean(this.catalogo)
            });
            return this.mostrarCatalogoNoDisponible(accountId, conversationId);
        }

        this.estados.actualizar(conversationId, ESTADOS.COTIZACION_FORMA_BUSQUEDA, {
            estudiosDisponibles: [],
            tipoServicio: 'laboratorio'
        });

        return this.client.enviarListaDesplegable(
            accountId,
            conversationId,
            '¿Cómo deseas buscar el estudio que quieres cotizar?',
            'Buscar estudio',
            [
                { title: 'Buscar por nombre', value: 'buscar' },
                { title: 'Los 5 más solicitados', value: 'top5' },
                { title: 'Hablar con un asesor', value: 'asesor' }
            ]
        );
    }

    async manejarFormaBusqueda(accountId, conversationId, mensaje, transferirAAgente) {
        const opcion = normalizar(mensaje);
        logger.info('COTIZACION', 'Forma de busqueda recibida', {
            accountId,
            conversationId,
            mensaje,
            opcion
        });
        if (['1', 'buscar', 'buscar por nombre'].includes(opcion)) {
            this.estados.actualizar(conversationId, ESTADOS.COTIZACION_BUSCAR_ESTUDIO, {
                estudiosDisponibles: []
            });
            return this.client.enviarTexto(
                accountId,
                conversationId,
                this.textoFlujo(
                    '4.1.1.1',
                    'Escribe el nombre, abreviatura o forma comun del estudio. Puedes enviar uno o varios separados por coma o por linea. Ejemplos: BH, azucar, glucosa o EGO.'
                )
            );
        }

        if (['2', 'top5', 'los 5 mas solicitados', 'mas solicitados'].includes(opcion)) {
            logger.info('COTIZACION', 'Usuario eligio top 5', { conversationId });
            return this.mostrarMasSolicitados(accountId, conversationId);
        }

        if (['3', 'asesor', 'hablar con asesor'].includes(opcion)) {
            logger.info('COTIZACION', 'Usuario eligio asesor', { conversationId });
            return transferirAAgente();
        }

        // Si el paciente ya dijo lo que quiere ("cuanto cuesta la bh"), es absurdo
        // repetirle el menu: se toma su texto como la busqueda y listo.
        const texto = String(mensaje || '').trim();
        if (texto.length >= 3 && !/^\d+$/.test(texto)) {
            logger.info('COTIZACION', 'Texto libre en forma de busqueda, se busca directamente', {
                conversationId,
                texto
            });
            this.estados.actualizar(conversationId, ESTADOS.COTIZACION_BUSCAR_ESTUDIO, {
                estudiosDisponibles: []
            });
            return this.manejarBusquedaEstudio(accountId, conversationId, texto, {
                transferirAAgente: typeof transferirAAgente === 'function' ? transferirAAgente : undefined
            });
        }

        logger.warn('COTIZACION', 'Forma de busqueda invalida, reiniciando cotizacion', {
            conversationId,
            mensaje
        });
        return this.iniciar(accountId, conversationId);
    }

    /**
     * Cuando la busqueda no encuentra nada. El texto de 4.1.1.1 en chatbot-flow.json promete
     * canalizar con un asesor, asi que en el segundo intento se canaliza de verdad en vez de
     * repetir el mismo mensaje para siempre.
     */
    async manejarBusquedaSinResultados(accountId, conversationId, texto, acciones = {}) {
        const estado = this.estados.obtener(conversationId);
        const intentos = Number(estado.datos?.intentosBusqueda || 0) + 1;
        this.estados.actualizar(conversationId, estado.estado, { intentosBusqueda: intentos });

        logger.warn('COTIZACION', 'Busqueda sin resultados', {
            accountId,
            conversationId,
            texto,
            intentos
        });

        if (intentos < 2) {
            return this.client.enviarTexto(
                accountId,
                conversationId,
                `No encontré "${texto}" en la lista de precios de esta sucursal.\n\n` +
                'Intenta con otro nombre, escribe *asesor* para que te ayude una persona, o *menu* para volver.'
            );
        }

        // Solo prometemos un asesor si de verdad hay alguien. Fuera de horario, transferirAAgente
        // ya explica el horario y devuelve al menu: anunciarlo antes seria prometer y retractarse.
        const hayAsesores = typeof acciones.hayAsesores === 'function' ? acciones.hayAsesores() : true;

        await this.client.enviarTexto(
            accountId,
            conversationId,
            hayAsesores
                ? this.textoFallback(
                    '4.1.1.1',
                    'No pudimos identificar el estudio o servicio solicitado.\nTe canalizaremos con uno de nuestros asesores.'
                )
                : 'No pudimos identificar el estudio o servicio solicitado.'
        );

        this.estados.actualizar(conversationId, estado.estado, { intentosBusqueda: 0 });

        if (typeof acciones.transferirAAgente === 'function') {
            return acciones.transferirAAgente();
        }

        // Sin callback de transferencia no dejamos al usuario atrapado: se vuelve al menu.
        logger.warn('COTIZACION', 'Sin callback de transferencia, se regresa al menu', { conversationId });
        if (typeof acciones.mostrarMenu === 'function') return acciones.mostrarMenu();
        return this.iniciar(accountId, conversationId);
    }

    async manejarBusquedaEstudio(accountId, conversationId, mensaje, acciones = {}) {
        const texto = String(mensaje || '').trim();
        logger.info('COTIZACION', 'Busqueda de estudio recibida', {
            accountId,
            conversationId,
            texto
        });
        if (texto.length < 2) {
            logger.warn('COTIZACION', 'Busqueda demasiado corta', {
                conversationId,
                texto
            });
            return this.client.enviarTexto(accountId, conversationId, 'Escribe al menos 2 caracteres para buscar.');
        }

        const estado = this.estados.obtener(conversationId);
        const terminos = this.extraerTerminosBusqueda(texto);
        if (terminos.length > 1) {
            return this.manejarBusquedaMultipleEstudios(accountId, conversationId, texto, terminos, acciones);
        }

        try {
            const { estudios, termino: terminoUsado, rescatado } =
                await this.buscarEstudiosConRescate(estado, texto);
            logger.info('COTIZACION', 'Estudios encontrados', {
                conversationId,
                texto,
                terminoUsado,
                rescatado,
                total: estudios.length,
                estudios
            });

            if (estudios.length === 0) {
                return this.manejarBusquedaSinResultados(accountId, conversationId, texto, acciones);
            }

            this.estados.actualizar(conversationId, estado.estado, { intentosBusqueda: 0 });

            // Una sola coincidencia clara: dar el precio ya. Mostrar una lista de un
            // elemento y pedir que lo elija es un paso de mas para nada.
            const unico = this.coincidenciaInequivoca(estudios, terminoUsado);
            if (unico) {
                return this.cotizarEstudiosSeleccionados(accountId, conversationId, [unico], {
                    origen: 'coincidencia_unica',
                    mensaje: texto
                });
            }

            // Varias opciones: se pregunta, con la pregunta del diccionario si la hay.
            const pregunta = this.preguntaDelAlias(terminoUsado);
            if (pregunta) {
                return this.preguntarAmbiguo(accountId, conversationId, {
                    pendientes: [{ termino: texto, pregunta, opciones: estudios }],
                    resueltos: [],
                    noEncontrados: [],
                    textoOriginal: texto
                });
            }
            return this.mostrarEstudios(accountId, conversationId, estudios, 'Estas son las coincidencias encontradas:');
        } catch (error) {
            logger.error('COTIZACION', 'Error en busqueda de cotizacion', {
                conversationId,
                texto,
                error: error.stack || error.message || String(error)
            });
            console.error('Error en busqueda de cotizacion:', error.message);
            return this.mostrarErrorConsulta(accountId, conversationId);
        }
    }

    async mostrarMasSolicitados(accountId, conversationId) {
        const estado = this.estados.obtener(conversationId);
        try {
            logger.info('COTIZACION', 'Consultando top estudios', {
                accountId,
                conversationId,
                sucursal: estado.datos?.sucursalAsignada,
                tipoServicio: estado.datos?.tipoServicio
            });
            const estudios = await this.catalogo.obtenerMasSolicitados({
                tipoServicio: estado.datos?.tipoServicio,
                sucursal: estado.datos?.sucursalAsignada
            });
            logger.info('COTIZACION', 'Top estudios recibido', {
                conversationId,
                total: estudios.length,
                estudios
            });

            if (estudios.length === 0) {
                this.estados.actualizar(conversationId, ESTADOS.COTIZACION_FORMA_BUSQUEDA);
                return this.client.enviarTexto(
                    accountId,
                    conversationId,
                    'No hay estudios solicitados disponibles para esta lista de precios. Puedes buscar uno por nombre.'
                );
            }

            return this.mostrarEstudios(
                accountId,
                conversationId,
                estudios.slice(0, 5),
                'Los 5 estudios mas solicitados disponibles en tu sucursal son:'
            );
        } catch (error) {
            logger.error('COTIZACION', 'Error consultando top de estudios', {
                conversationId,
                error: error.stack || error.message || String(error)
            });
            console.error('Error consultando top de estudios:', error.message);
            return this.mostrarErrorConsulta(accountId, conversationId);
        }
    }

    async mostrarEstudios(accountId, conversationId, estudios, encabezado) {
        logger.info('COTIZACION', 'Mostrando estudios al usuario', {
            accountId,
            conversationId,
            encabezado,
            total: estudios.length,
            estudios
        });
        this.estados.actualizar(conversationId, ESTADOS.COTIZACION_CONFIRMAR_ESTUDIOS, {
            estudiosDisponibles: estudios
        });

        const prefijo = this.prefijoComun(estudios.map(e => e.nombre));
        return this.client.enviarListaDesplegable(
            accountId,
            conversationId,
            `${encabezado}\n\n${this.listarOpciones(estudios)}\n\nPuedes seleccionar uno o varios. Ejemplo: 1,2,3`,
            'Elegir estudio',
            estudios.map(estudio => ({
                title: this.tituloCortoOpcion(estudio, prefijo),
                value: `estudio:${estudio.id}`
            }))
        );
    }

    /**
     * Pregunta por el primer termino ambiguo que quede. Los ya resueltos se guardan
     * para cotizarlos todos juntos al final, para que el paciente reciba UNA cotizacion.
     */
    async preguntarAmbiguo(accountId, conversationId, contexto) {
        const [pendiente, ...resto] = contexto.pendientes;
        // Alfabeticamente "(32 ELEMENTOS)" va antes que "(4 ELEMENTOS)". Por precio se
        // entiende sola y ademas lo mas economico queda arriba.
        const actual = {
            ...pendiente,
            opciones: [...pendiente.opciones].sort((a, b) => {
                const pa = Number(a.precio), pb = Number(b.precio);
                if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
                return String(a.nombre).localeCompare(String(b.nombre));
            }).slice(0, 10)   // recortar DESPUES de ordenar, o se pierden las mas baratas
        };

        this.estados.actualizar(conversationId, ESTADOS.COTIZACION_CONFIRMAR_ESTUDIOS, {
            estudiosDisponibles: actual.opciones,
            desambiguacion: {
                terminoActual: actual.termino,
                pendientes: resto,
                resueltos: contexto.resueltos,
                noEncontrados: contexto.noEncontrados,
                textoOriginal: contexto.textoOriginal
            }
        });

        const yaResueltos = contexto.resueltos.length > 0
            ? `Ya tengo: ${contexto.resueltos.map(e => e.nombre).join(', ')}.\n\n`
            : '';
        const pregunta = actual.pregunta ||
            `Tenemos varias opciones de "${actual.termino}". ¿Cuál necesitas?`;

        logger.info('COTIZACION', 'Preguntando por termino ambiguo', {
            accountId,
            conversationId,
            termino: actual.termino,
            opciones: actual.opciones.length,
            pendientesRestantes: resto.length
        });

        const prefijo = this.prefijoComun(actual.opciones.map(e => e.nombre));
        return this.client.enviarListaDesplegable(
            accountId,
            conversationId,
            `${yaResueltos}${pregunta}\n\n${this.listarOpciones(actual.opciones)}`,
            'Elegir opción',
            actual.opciones.map(estudio => ({
                title: this.tituloCortoOpcion(estudio, prefijo),
                value: `estudio:${estudio.id}`
            }))
        );
    }

    async manejarSeleccionEstudio(accountId, conversationId, mensaje) {
        const estado = this.estados.obtener(conversationId);
        const disponibles = estado.datos?.estudiosDisponibles || [];
        const valor = String(mensaje || '').trim();
        const estudiosSeleccionados = this.resolverSeleccionEstudios(disponibles, valor);
        logger.info('COTIZACION', 'Seleccion de estudio recibida', {
            accountId,
            conversationId,
            mensaje,
            valor,
            disponibles,
            estudiosSeleccionados
        });

        if (estudiosSeleccionados.length === 0) {
            logger.warn('COTIZACION', 'Seleccion de estudio invalida', {
                conversationId,
                mensaje,
                valor
            });
            return this.mostrarEstudios(
                accountId,
                conversationId,
                disponibles,
                'Selecciona uno de los estudios de la lista:'
            );
        }

        const desambiguacion = estado.datos?.desambiguacion;
        if (desambiguacion) {
            const acumulados = [...(desambiguacion.resueltos || [])];
            const ids = new Set(acumulados.map(e => String(e.id)));
            for (const elegido of estudiosSeleccionados) {
                if (ids.has(String(elegido.id))) continue;
                acumulados.push(elegido);
                ids.add(String(elegido.id));
            }

            if ((desambiguacion.pendientes || []).length > 0) {
                return this.preguntarAmbiguo(accountId, conversationId, {
                    pendientes: desambiguacion.pendientes,
                    resueltos: acumulados,
                    noEncontrados: desambiguacion.noEncontrados || [],
                    textoOriginal: desambiguacion.textoOriginal
                });
            }

            this.estados.actualizar(conversationId, ESTADOS.COTIZACION_CONFIRMAR_ESTUDIOS, {
                desambiguacion: null
            });
            return this.cotizarEstudiosSeleccionados(accountId, conversationId, acumulados, {
                origen: 'desambiguacion',
                mensaje: desambiguacion.textoOriginal,
                noEncontrados: desambiguacion.noEncontrados || []
            });
        }

        return this.cotizarEstudiosSeleccionados(accountId, conversationId, estudiosSeleccionados, {
            origen: 'seleccion_lista',
            mensaje
        });
    }

    async manejarPostCotizacion(accountId, conversationId, mensaje, acciones) {
        const opcion = normalizar(mensaje);
        logger.info('COTIZACION', 'Accion post cotizacion recibida', {
            accountId,
            conversationId,
            mensaje,
            opcion
        });
        if (['1', 'cotizar_otro', 'cotizar otro estudio'].includes(opcion)) {
            return this.iniciar(accountId, conversationId);
        }
        if (['2', 'menu_principal', 'menu principal'].includes(opcion)) {
            return acciones.mostrarMenu();
        }
        if (['3', 'asesor', 'hablar con asesor'].includes(opcion)) {
            return acciones.transferirAAgente();
        }

        return acciones.mostrarMenu();
    }

    async manejarCotizacionFinal(accountId, conversationId, mensaje, iniciarRecordatorio) {
        await this.client.enviarTexto(
            accountId,
            conversationId,
            'Entendido. Un asesor revisara tu solicitud y te dara la informacion en breve.'
        );
        await this.client.crearNotaPrivada(accountId, conversationId, `SOLICITUD COTIZACION:\n"${mensaje}"`);
        this.estados.actualizar(conversationId, ESTADOS.AGENTE);
        iniciarRecordatorio(accountId, conversationId);
    }

    tituloEstudio(estudio) {
        const precio = Number(estudio.precio);
        const sufijo = Number.isFinite(precio) ? ` - $${precio.toFixed(2)}` : '';
        return `${estudio.nombre}${sufijo}`;
    }

    resolverTiempoEntrega(items) {
        const list = items || [];
        if (list.length === 0) {
            return 'Mismo día';
        }

        if (list.length === 1) {
            const t = String(list[0].tiempoEntrega || list[0].tiempo_entrega || list[0].entrega || '').trim();
            return t || 'Mismo día';
        }

        return '\n' + list.map(item => {
            const t = String(item.tiempoEntrega || item.tiempo_entrega || item.entrega || '').trim() || 'Mismo día';
            return `• *${item.nombre}*: ${t}`;
        }).join('\n');
    }

    formatearCotizacion(cotizacion, opciones = {}) {
        const rawSucursal = cotizacion.sucursal?.titulo || cotizacion.sucursal?.nombre || 'VILLAHERMOSA';
        const sucursal = String(rawSucursal)
            .replace(/^SUCURSAL\s+/i, '')
            .replace(/\s+MATRIZ$/i, '')
            .trim()
            .toUpperCase();

        const detalle = cotizacion.items.map(item => {
            const precio = Number(item.precio);
            return `El precio del estudio ${item.nombre} ${Number.isFinite(precio) ? `$${precio.toFixed(2)} pesos` : 'precio no disponible'}`;
        }).join('\n');

        const tiempoEntrega = this.resolverTiempoEntrega(cotizacion.items);

        const noEncontrados = opciones.noEncontrados || [];
        const avisoNoEncontrados = noEncontrados.length > 0
            ? '\n\n⚠️ No encontré precio activo para:\n' + noEncontrados.map(item => `- ${item}`).join('\n')
            : '';

        const preparacionesMap = new Map();
        for (const item of cotizacion.items) {
            const prep = String(item.preparacion || '').trim();
            if (!prep) continue;
            const key = prep.toLowerCase().replace(/\s+/g, ' ');
            if (!preparacionesMap.has(key)) {
                preparacionesMap.set(key, { texto: prep, nombres: [] });
            }
            preparacionesMap.get(key).nombres.push(item.nombre);
        }

        const indicacionesList = Array.from(preparacionesMap.values()).map(grupo => {
            const nombres = grupo.nombres.join(', ');
            return `• *${nombres}*:\n  ${grupo.texto}`;
        });

        const bloqueIndicaciones = indicacionesList.length > 0
            ? indicacionesList.join('\n\n')
            : 'Ninguna.';

        const fallbackDefault = [
            'COTIZACIÓN: ',
            '',
            `${detalle}${avisoNoEncontrados}`,
            '',
            'INDICACIONES: ',
            bloqueIndicaciones,
            '',
            `📍 Sucursal: ${sucursal}`,
            '',
            `🕒 Tiempo estimado de entrega: ${tiempoEntrega}`,
            '',
            '(Aplican restricciones según horario de toma de muestra y tipo de estudio.)',
            '',
            '⚡ Estudios urgentes pueden generar cargos adicionales.'
        ].join('\n');

        return this.textoFlujo('4.1.1.3', fallbackDefault, {
            detalle,
            sucursal,
            indicaciones: bloqueIndicaciones,
            tiempoEntrega,
            avisoNoEncontrados
        });
    }

    async manejarBusquedaMultipleEstudios(accountId, conversationId, textoOriginal, terminos, acciones = {}) {
        const estado = this.estados.obtener(conversationId);
        const seleccionados = [];
        const noEncontrados = [];
        const ids = new Set();

        logger.info('COTIZACION', 'Busqueda multiple de estudios recibida', {
            accountId,
            conversationId,
            textoOriginal,
            terminos
        });

        const ambiguos = [];

        for (const termino of terminos) {
            const { estudios, termino: terminoUsado } =
                await this.buscarEstudiosConRescate(estado, termino);

            if (!Array.isArray(estudios) || estudios.length === 0) {
                noEncontrados.push(termino);
                continue;
            }

            const elegido = this.coincidenciaInequivoca(estudios, terminoUsado);
            if (elegido) {
                if (!ids.has(String(elegido.id))) {
                    seleccionados.push(elegido);
                    ids.add(String(elegido.id));
                }
                continue;
            }

            // Varias opciones validas: no se adivina, se pregunta.
            ambiguos.push({
                termino,
                pregunta: this.preguntaDelAlias(terminoUsado),
                opciones: estudios
            });
        }

        logger.info('COTIZACION', 'Busqueda multiple resuelta', {
            conversationId,
            seleccionados,
            noEncontrados
        });

        if (seleccionados.length === 0) {
            const estudioDirecto = await this.catalogo.buscarEstudios({
                texto: textoOriginal,
                tipoServicio: estado.datos?.tipoServicio,
                sucursal: estado.datos?.sucursalAsignada
            });

            if (Array.isArray(estudioDirecto) && estudioDirecto.length > 0) {
                return this.mostrarEstudios(accountId, conversationId, estudioDirecto, 'Estas son las coincidencias encontradas:');
            }

            return this.manejarBusquedaSinResultados(accountId, conversationId, textoOriginal, acciones);
        }

        if (ambiguos.length > 0) {
            return this.preguntarAmbiguo(accountId, conversationId, {
                pendientes: ambiguos,
                resueltos: seleccionados,
                noEncontrados,
                textoOriginal
            });
        }

        return this.cotizarEstudiosSeleccionados(accountId, conversationId, seleccionados, {
            origen: 'busqueda_multiple',
            mensaje: textoOriginal,
            noEncontrados
        });
    }

    async cotizarEstudiosSeleccionados(accountId, conversationId, estudios, opciones = {}) {
        const estado = this.estados.obtener(conversationId);

        try {
            const cotizacion = await this.catalogo.cotizar({
                estudios,
                sucursal: estado.datos?.sucursalAsignada
            });
            logger.info('COTIZACION', 'Cotizacion generada', {
                conversationId,
                estudios,
                opciones,
                cotizacion
            });

            if (!cotizacion?.items?.length) {
                return this.client.enviarTexto(
                    accountId,
                    conversationId,
                    'Los estudios seleccionados no tienen precio activo para esta sucursal. Escribe menu para intentar con otro.'
                );
            }

            this.estados.actualizar(conversationId, ESTADOS.COTIZACION_POST_COTIZACION, {
                ultimaCotizacion: cotizacion
            });
            await this.client.enviarTexto(accountId, conversationId, this.formatearCotizacion(cotizacion, {
                noEncontrados: opciones.noEncontrados || []
            }));
            return this.client.enviarListaDesplegable(
                accountId,
                conversationId,
                '¿Cómo deseas continuar?',
                'Continuar',
                [
                    { title: '1️⃣ Cotizar otro estudio', value: 'cotizar_otro' },
                    { title: '2️⃣ Volver al menú', value: 'menu_principal' },
                    { title: '3️⃣ Hablar con asesor', value: 'asesor' }
                ]
            );
        } catch (error) {
            logger.error('COTIZACION', 'Error generando cotizacion', {
                conversationId,
                estudios,
                opciones,
                error: error.stack || error.message || String(error)
            });
            console.error('Error generando cotizacion:', error.message);
            return this.mostrarErrorConsulta(accountId, conversationId);
        }
    }

    extraerTerminosBusqueda(texto) {
        const original = String(texto || '');
        const protegido = original
            .replace(/\brx\s+(ap|pa)\s+y\s+(lateral|oblicua)\s+de\s+(.*?)(?=\s+y\s+|,|;|$)/gi, 'rx $3 $1, rx $3 $2')
            .replace(/\bradiografia\s+(ap|pa)\s+y\s+(lateral|oblicua)\s+de\s+(.*?)(?=\s+y\s+|,|;|$)/gi, 'rx $3 $1, rx $3 $2')
            .replace(/\bradiografia\s+de\s+(.*?)\s+(ap|pa)\s+y\s+(lateral|oblicua)(?=\s+y\s+|,|;|$)/gi, 'rx $1 $2, rx $1 $3')
            .replace(/\brx\s+de\s+(.*?)\s+(ap|pa)\s+y\s+(lateral|oblicua)(?=\s+y\s+|,|;|$)/gi, 'rx $1 $2, rx $1 $3')
            .replace(/\b(ap|pa|lateral|oblicua|1)\s+y\s+(lateral|oblicua|2|presuntiva)\b/gi, '$1_Y_$2');
        const limpiado = protegido
            .replace(/\r/g, '\n')
            .replace(/[•●◦▪▫]/g, '\n')
            .replace(/\b(cotizar|cotizacion|cotización|precio|precios|costo|costos|estudios?|servicios?|quiero|necesito|solicito|favor|por favor)\b/gi, ' ');
        const tieneSeparadores = /[\n,;|+]|\s+y\s+|\s+e\s+/i.test(limpiado);
        const partes = limpiado
            .split(/[\n,;|+]|\s+y\s+|\s+e\s+/i)
            .map(item => this.limpiarTerminoEstudio(item.replace(/_Y_/g, ' y ')))
            .filter(item => item.length >= 2)
            .filter((item, index, lista) => lista.findIndex(otro => normalizar(otro) === normalizar(item)) === index)
            .slice(0, 8);

        if (!tieneSeparadores || partes.length <= 1) return [this.limpiarTerminoEstudio(original)].filter(Boolean);
        return partes;
    }

    limpiarTerminoEstudio(texto) {
        return String(texto || '')
            .replace(/^\s*\d+[\).\-\s]+/, '')
            .replace(/^[^\wáéíóúñÁÉÍÓÚÑ]+/, '')
            .replace(/[^\wáéíóúñÁÉÍÓÚÑ\s().-]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Devuelve el estudio solo si la coincidencia es inequivoca. Si el termino da
     * varias opciones reales (una "quimica sanguinea" son 10 estudios distintos con
     * precios distintos), devuelve null para que se le pregunte al paciente en vez
     * de elegir por el.
     */
    /**
     * Chatwoot recorta el title de cada item de input_select a 24 caracteres
     * (chatwoot.js:45). Con nombres como "QUIMICA SANGUINEA (6 ELEMENTOS) (QSC) - $350.00"
     * al paciente le llegan diez filas identicas y sin precio. Estos dos metodos
     * reparten la informacion: lo distintivo en el title corto, el detalle completo
     * en el cuerpo del mensaje, que no se recorta en ningun canal.
     */
    prefijoComun(nombres) {
        if (nombres.length < 2) return '';
        const palabras = nombres.map(n => String(n).split(/\s+/));
        const salida = [];
        for (let i = 0; i < palabras[0].length; i += 1) {
            const palabra = palabras[0][i];
            if (!palabras.every(p => p[i] === palabra)) break;
            salida.push(palabra);
        }
        // Nunca consumir el nombre entero: algo tiene que quedar para distinguir.
        if (salida.length >= palabras[0].length) salida.pop();
        return salida.join(' ');
    }

    tituloCortoOpcion(estudio, prefijo) {
        const nombre = String(estudio.nombre || '').trim();
        let distintivo = prefijo && nombre.startsWith(prefijo)
            ? nombre.slice(prefijo.length).trim()
            : nombre;
        distintivo = distintivo.replace(/^[(\-–·:,\s]+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!distintivo) distintivo = nombre;

        const precio = Number(estudio.precio);
        const sufijo = Number.isFinite(precio) ? ` $${Math.round(precio)}` : '';
        const espacio = 24 - sufijo.length;
        if (distintivo.length > espacio) distintivo = distintivo.slice(0, espacio - 1).trim() + '…';
        return `${distintivo}${sufijo}`;
    }

    /** Lista numerada con nombre y precio completos, para el cuerpo del mensaje. */
    listarOpciones(estudios) {
        return estudios.map((e, i) => `${i + 1}. ${this.tituloEstudio(e)}`).join('\n');
    }

    coincidenciaInequivoca(estudios, termino) {
        if (!Array.isArray(estudios) || estudios.length === 0) return null;
        if (estudios.length === 1) return estudios[0];

        const buscado = normalizar(termino);
        const exactos = estudios.filter(e => normalizar(e.nombre).startsWith(`${buscado} (`) ||
            normalizar(e.nombre) === buscado);
        if (exactos.length === 1) return exactos[0];

        return null;
    }

    /** La pregunta que el diccionario define para un termino ambiguo, si la hay. */
    preguntaDelAlias(termino) {
        try {
            return this.catalogo?.resolverAlias?.(termino)?.pregunta || null;
        } catch (_error) {
            return null;
        }
    }

    elegirMejorEstudio(estudios, termino) {
        if (!Array.isArray(estudios) || estudios.length === 0) return null;
        const buscado = normalizar(termino);
        return estudios.find(estudio => normalizar(estudio.nombre) === buscado) ||
            estudios.find(estudio => normalizar(estudio.nombre).startsWith(buscado)) ||
            estudios[0];
    }

    resolverSeleccionEstudios(disponibles, mensaje) {
        if (!Array.isArray(disponibles) || disponibles.length === 0) return [];
        const texto = String(mensaje || '').trim();
        const textoNormalizado = normalizar(texto);

        if (['todo', 'todos', 'confirmar todos', 'todas'].includes(textoNormalizado)) {
            return disponibles;
        }

        const seleccionados = [];
        const ids = new Set();
        const agregar = estudio => {
            if (!estudio) return;
            const id = String(estudio.id);
            if (ids.has(id)) return;
            seleccionados.push(estudio);
            ids.add(id);
        };

        const idsExplicitos = [...texto.matchAll(/estudio:([^\s,;|]+)/gi)].map(match => match[1]);
        for (const id of idsExplicitos) {
            agregar(disponibles.find(item => String(item.id) === String(id)));
        }

        if (idsExplicitos.length === 0) {
            const numeros = [...texto.matchAll(/\b\d+\b/g)].map(match => Number(match[0]));
            for (const numero of numeros) {
                if (numero >= 1 && numero <= disponibles.length) {
                    agregar(disponibles[numero - 1]);
                } else {
                    agregar(disponibles.find(item => Number(item.id) === numero));
                }
            }
        }

        if (seleccionados.length === 0) {
            const porTexto = disponibles.find(item => {
                const nombre = normalizar(item.nombre || item.title || '');
                return nombre && (nombre.includes(textoNormalizado) || textoNormalizado.includes(nombre));
            });
            agregar(porTexto);
        }

        return seleccionados;
    }

    async mostrarCatalogoNoDisponible(accountId, conversationId) {
        logger.warn('COTIZACION', 'Mostrando catalogo no disponible', {
            accountId,
            conversationId
        });
        return this.client.enviarTexto(
            accountId,
            conversationId,
            this.textoFallback(
                '4.1',
                'Esta sucursal aun no tiene configurada una lista de precios. Escribe asesor para recibir ayuda.'
            )
        );
    }

    async mostrarErrorConsulta(accountId, conversationId) {
        logger.warn('COTIZACION', 'Mostrando error de consulta', {
            accountId,
            conversationId
        });
        this.estados.actualizar(conversationId, ESTADOS.COTIZACION_FORMA_BUSQUEDA);
        return this.client.enviarTexto(
            accountId,
            conversationId,
            this.textoFallback(
                '4.1.1.3',
                'No pude consultar los precios en este momento. Intenta nuevamente o escribe asesor.'
            )
        );
    }

    textoFlujo(stepId, fallback, variables = {}) {
        try {
            const texto = this.flow?.respuesta(stepId, variables);
            return texto || fallback;
        } catch (_error) {
            return fallback;
        }
    }

    textoFallback(stepId, fallback, variables = {}) {
        try {
            const texto = this.flow?.fallback(stepId, variables);
            return texto || fallback;
        } catch (_error) {
            return fallback;
        }
    }
}

module.exports = FlujoCotizacion;
