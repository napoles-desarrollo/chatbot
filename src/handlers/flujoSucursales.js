const { ESTADOS } = require('../config');
const { normalizar } = require('../utils/helpers');
const logger = require('../services/logger');

function toTitleCase(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/(?:^|\s|[()-])[\wáéíóúñÁÉÍÓÚÑ]/g, match => match.toUpperCase());
}

class FlujoSucursales {
    constructor(client, cache, estados, geo, flowDefinition = null) {
        this.client = client;
        this.cache = cache;
        this.estados = estados;
        this.geo = geo;
        this.flow = flowDefinition;
    }

    async iniciarFlujoUbicacion(accountId, conversationId) {
        logger.info('SUCURSALES_FLOW', 'Iniciando flujo de ubicacion', {
            accountId,
            conversationId
        });
        this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_UBICACION, {
            sucursalAsignada: null,
            sucursalesCercanas: null,
            origenUbicacion: null
        });

        return this.client.enviarTexto(
            accountId,
            conversationId,
            this.textoFlujo(
                '1',
                "💙Bienvenido a Laboratorios Napoles.\n\nSoy Napolito, tu asistente virtual y estoy aquí para ayudarte.🤖\n\nPor favor, compártenos tu ubicación o escribe tu ciudad/código postal."
            )
        );
    }

    async manejarEntradaUbicacion(accountId, conversationId, mensaje) {
        const cp = this.extraerCodigoPostal(mensaje);
        logger.info('SUCURSALES_FLOW', 'Entrada de ubicacion recibida', {
            accountId,
            conversationId,
            mensaje,
            cp
        });
        if (cp) return this.manejarCodigoPostal(accountId, conversationId, cp);

        const inputUsuario = normalizar(mensaje);
        const datos = await this.cache.obtenerDatos();
        const estadoDetectado = this.cache.obtenerEstados(datos).find(e => normalizar(e) === inputUsuario);

        if (estadoDetectado) {
            logger.info('SUCURSALES_FLOW', 'Estado detectado por texto', {
                conversationId,
                inputUsuario,
                estadoDetectado
            });
            return this.manejarSeleccionEstado(accountId, conversationId, `estado_${normalizar(estadoDetectado)}`);
        }

        const municipio = this.cache.buscarMunicipio(inputUsuario, datos);
        if (municipio?.sedes?.length) {
            logger.info('SUCURSALES_FLOW', 'Municipio detectado por texto', {
                conversationId,
                inputUsuario,
                municipio: {
                    estado: municipio.estado,
                    nombre: municipio.nombre,
                    totalSedes: municipio.sedes.length,
                    sedes: municipio.sedes
                }
            });
            this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_SUCURSAL, {
                estadoSeleccionado: municipio.estado,
                municipios: [municipio.nombre],
                sedesDisponibles: municipio.sedes
            });

            if (municipio.sedes.length === 1) {
                return this.asignarSucursal(accountId, conversationId, municipio.sedes[0], {
                    tipo: 'municipio',
                    texto: mensaje
                });
            }

            return this.enviarPaginaSedes(accountId, conversationId, 0);
        }

        // Ultimo intento: el paciente escribio una frase ("estoy en villahermosa").
        // buscarMunicipio compara nombre<->entrada, pero no cubre "la frase CONTIENE el nombre".
        const enFrase = this.buscarUbicacionEnFrase(datos, inputUsuario);
        if (enFrase) {
            logger.info('SUCURSALES_FLOW', 'Ubicacion detectada dentro de una frase', {
                conversationId,
                inputUsuario,
                encontrado: enFrase.sedes.map(s => s.titulo)
            });
            this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_SUCURSAL, {
                estadoSeleccionado: enFrase.estado,
                municipios: [enFrase.municipio],
                sedesDisponibles: enFrase.sedes
            });
            if (enFrase.sedes.length === 1) {
                return this.asignarSucursal(accountId, conversationId, enFrase.sedes[0], {
                    tipo: 'texto_en_frase',
                    texto: mensaje
                });
            }
            return this.enviarPaginaSedes(accountId, conversationId, 0);
        }

        logger.warn('SUCURSALES_FLOW', 'No se pudo identificar ubicacion por texto', {
            conversationId,
            mensaje,
            inputUsuario
        });
        return this.client.enviarBotones(
            accountId,
            conversationId,
            this.textoFallback(
                '3',
                "⚠️ No pudimos identificar tu ubicación.\n\nPor favor comparte tu ubicación desde WhatsApp o escribe un código postal de 5 dígitos."
            ),
            [
                { title: "Escribir CP", value: "inicio" },
                { title: "Hablar con un asesor", value: "5" }
            ]
        );
    }

    async manejarCodigoPostal(accountId, conversationId, cp) {
        logger.info('SUCURSALES_FLOW', 'Manejando codigo postal', {
            accountId,
            conversationId,
            cp
        });
        if (!this.geo) {
            return this.client.enviarTexto(accountId, conversationId, "⚠️ La búsqueda por código postal aún no está configurada.");
        }

        const origen = this.geo.resolverCp(cp);
        if (!origen) {
            logger.warn('SUCURSALES_FLOW', 'Codigo postal no resuelto', {
                conversationId,
                cp
            });
            return this.client.enviarTexto(accountId, conversationId, `No encontré el código postal ${cp} en nuestra cobertura.\n\nPuedes compartir tu ubicación o escribir otro código postal.`);
        }

        return this.enviarSucursalesCercanas(accountId, conversationId, origen);
    }

    async manejarUbicacionCompartida(accountId, conversationId, ubicacion) {
        logger.info('SUCURSALES_FLOW', 'Manejando ubicacion compartida', {
            accountId,
            conversationId,
            ubicacion
        });
        if (!this.geo) {
            return this.client.enviarTexto(accountId, conversationId, "⚠️ La búsqueda por ubicación aún no está configurada.");
        }

        const origen = this.geo.resolverCoordenadas(ubicacion.latitud, ubicacion.longitud);
        return this.enviarSucursalesCercanas(accountId, conversationId, origen);
    }

    async enviarSucursalesCercanas(accountId, conversationId, origen) {
        logger.info('SUCURSALES_FLOW', 'Preparando sucursales cercanas', {
            accountId,
            conversationId,
            origen
        });
        const datos = await this.cache.obtenerDatos();
        const cercanas = this.geo.sucursalesCercanas(datos, origen, 5);

        if (cercanas.length === 0) {
            logger.warn('SUCURSALES_FLOW', 'No hay sucursales cercanas con coordenadas', {
                conversationId,
                origen
            });
            return this.client.enviarTexto(accountId, conversationId, "⚠️ No encontramos sucursales con coordenadas disponibles.");
        }
        logger.info('SUCURSALES_FLOW', 'Sucursales cercanas listas', {
            conversationId,
            origen,
            cercanas
        });

        this.estados.actualizar(conversationId, ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA, {
            origenUbicacion: origen,
            sucursalesCercanas: cercanas
        });

        const origenTexto = origen.cp
            ? `Ubico tu zona en el C.P ${origen.cp}`
            : "Recibimos tu ubicación.";

        const maxSucursalesVisibles = Math.min(5, cercanas.length);
        const sucursales = cercanas.slice(0, maxSucursalesVisibles);

        const opciones = sucursales.map((sede, index) => ({
            title: `${index + 1} ${this.nombreCortoSucursal(sede)}`.substring(0, 24),
            value: `cercana_${index}`
        }));

        opciones.push({ title: "Editar ubicación", value: "editar_ubicacion" });
        opciones.push({ title: "Hablar con un asesor", value: "asesor" });

        const maxVisibles = Math.min(5, sucursales.length);
        const resumen = sucursales.slice(0, maxVisibles)
            .map((sede, index) => `${index + 1}️⃣ ${this.nombreCortoSucursal(sede)} — ${this.formatearDistancia(sede.distanciaKm)}`)
            .join('\n');

        const opcionEditar = `${maxVisibles + 1}️⃣ Editar ubicación`;
        const opcionAsesor = `${maxVisibles + 2}️⃣ Hablar con un asesor`;

        return this.client.enviarListaDesplegable(
            accountId,
            conversationId,
            `${origenTexto}\n\nEstas son las sucursales más cercanas:\n\n${resumen}\n${opcionEditar}\n${opcionAsesor}`,
            "Elegir sucursal",
            opciones
        );
    }

    async manejarSeleccionSucursalCercana(accountId, conversationId, mensaje) {
        const estadoActual = this.estados.obtener(conversationId);
        const cercanas = estadoActual.datos?.sucursalesCercanas || [];
        const msg = normalizar(mensaje);
        const maxSucursalesVisibles = Math.min(5, cercanas.length);
        const numero = this.numeroDesdeTexto(msg);
        logger.info('SUCURSALES_FLOW', 'Seleccion de sucursal cercana recibida', {
            accountId,
            conversationId,
            mensaje,
            msg,
            numero,
            maxSucursalesVisibles,
            cercanas
        });

        if (msg === 'editar_ubicacion' || msg === 'editar' || msg === 'ubicacion' || numero === maxSucursalesVisibles + 1) {
            logger.info('SUCURSALES_FLOW', 'Usuario eligio editar ubicacion', {
                conversationId
            });
            return this.iniciarFlujoUbicacion(accountId, conversationId);
        }

        if (msg === 'asesor' || msg.includes('asesor') || numero === maxSucursalesVisibles + 2) {
            logger.info('SUCURSALES_FLOW', 'Usuario eligio asesor desde sucursales cercanas', {
                conversationId
            });
            this.estados.actualizar(conversationId, ESTADOS.MENU);
            return this.client.enviarTexto(accountId, conversationId, "Escribe *asesor* y te canalizaremos con nuestro equipo de atención.");
        }

        let index = -1;
        if (/^cercana_\d+$/.test(msg)) index = parseInt(msg.replace('cercana_', ''), 10);
        if (numero !== null && numero >= 1 && numero <= maxSucursalesVisibles) index = numero - 1;

        const sede = cercanas[index] || this.buscarSedeEnLista(cercanas.slice(0, maxSucursalesVisibles), msg);
        if (!sede) {
            logger.warn('SUCURSALES_FLOW', 'Seleccion de sucursal cercana invalida', {
                conversationId,
                mensaje,
                msg,
                index
            });
            return this.client.enviarTexto(accountId, conversationId, "Opción no válida. Por favor selecciona una sucursal de la lista.");
        }

        return this.asignarSucursal(accountId, conversationId, sede, estadoActual.datos?.origenUbicacion);
    }

    async manejarConfirmacionSucursal(accountId, conversationId, mensaje) {
        const msg = normalizar(mensaje);
        const estadoActual = this.estados.obtener(conversationId);
        const sede = estadoActual.datos?.sucursalSugerida;
        logger.info('SUCURSALES_FLOW', 'Confirmacion de sucursal recibida', {
            accountId,
            conversationId,
            mensaje,
            msg,
            sede
        });

        if (['si', 'sí', '1', 'correcto', 'ok'].includes(msg) && sede) {
            return this.asignarSucursal(accountId, conversationId, sede, estadoActual.datos?.origenUbicacion);
        }

        return this.iniciarFlujoUbicacion(accountId, conversationId);
    }

    async asignarSucursal(accountId, conversationId, sede, origen = null) {
        logger.info('SUCURSALES_FLOW', 'Asignando sucursal', {
            accountId,
            conversationId,
            sede,
            origen
        });
        this.estados.actualizar(conversationId, ESTADOS.MENU, {
            sucursalAsignada: sede,
            origenUbicacion: origen
        });

        await this.client.enviarTexto(
            accountId,
            conversationId,
            `📍 Sucursal ${this.nombreCortoSucursal(sede)}:\n\n${sede.direccion || ''}`.trim()
        );

        return this.enviarMenuPrincipal(accountId, conversationId);
    }

    async enviarMenuPrincipal(accountId, conversationId) {
        const estadoActual = this.estados.obtener(conversationId);
        const sucursal = estadoActual.datos?.sucursalAsignada;
        const nombre = sucursal ? this.nombreCortoSucursal(sucursal) : 'pendiente';
        logger.info('SUCURSALES_FLOW', 'Enviando menu principal desde flujo sucursales', {
            accountId,
            conversationId,
            sucursal,
            nombre
        });

        this.estados.actualizar(conversationId, ESTADOS.MENU);
        return this.client.enviarListaDesplegable(
            accountId,
            conversationId,
            `¿En qué podemos ayudarte hoy?\n\n📍 Sucursal ${nombre}:`,
            "Seleccionar",
            [
                { title: "1️⃣ Cotizar servicios", value: "1" },
                { title: "2️⃣ Consultar resultados", value: "2" },
                { title: "3️⃣ Dirección y horarios", value: "3" },
                { title: "4️⃣ Hablar con un asesor", value: "4" }
            ]
        );
    }

    async mostrarSucursalAsignada(accountId, conversationId) {
        const estadoActual = this.estados.obtener(conversationId);
        const sede = estadoActual.datos?.sucursalAsignada;
        logger.info('SUCURSALES_FLOW', 'Mostrando sucursal asignada', {
            accountId,
            conversationId,
            sede
        });

        if (!sede) return this.iniciarFlujoUbicacion(accountId, conversationId);

        this.estados.actualizar(conversationId, ESTADOS.SUCURSAL_DETALLES);
        return this.enviarDetallesSucursal(accountId, conversationId, sede);
    }

    async manejarAccionDetalles(accountId, conversationId, mensaje, callbacks = {}) {
        const msg = normalizar(mensaje);
        logger.info('SUCURSALES_FLOW', 'Manejando accion de detalles de sucursal', {
            accountId,
            conversationId,
            mensaje,
            msg
        });

        const esCambiarUbicacion = [
            '2', 'inicio', 'cambiar', 'cambiar ubicacion', 'cambiar sucursal', 'editar ubicacion', 'editar sucursal'
        ].includes(msg) || msg.includes('cambiar') || msg.includes('editar') || msg.includes('ubicacion');

        if (esCambiarUbicacion) {
            return this.iniciarFlujoUbicacion(accountId, conversationId);
        }

        const esMenu = ['1', 'menu', 'menu principal', 'volver'].includes(msg) || msg.includes('menu');
        if (esMenu) {
            if (typeof callbacks.mostrarMenu === 'function') {
                return callbacks.mostrarMenu();
            }
            return this.enviarMenuPrincipal(accountId, conversationId);
        }

        if (this.extraerCodigoPostal(mensaje)) {
            await this.iniciarFlujoUbicacion(accountId, conversationId);
            return this.manejarEntradaUbicacion(accountId, conversationId, mensaje);
        }

        if (typeof callbacks.mostrarMenu === 'function') {
            return callbacks.mostrarMenu();
        }
        return this.enviarMenuPrincipal(accountId, conversationId);
    }

    async enviarDetallesSucursal(accountId, conversationId, sede) {
        logger.info('SUCURSALES_FLOW', 'Enviando detalles de sucursal', {
            accountId,
            conversationId,
            sede
        });
        let resp = `*${this.nombreCortoSucursal(sede)}*\n\n${sede.direccion || ''}\n\n`;
        if (sede.horario_general) resp += `🕒 Horario: ${sede.horario_general}\n\n`;
        if (sede.whatsapp) resp += `📱 WA: ${sede.whatsapp}\n`;
        if (sede.telefono) resp += `📞 Tel: ${sede.telefono}\n`;
        const urlMapa = sede.mapa_movil || sede.url_mapa || sede.url_iframe_mapa;
        if (urlMapa && urlMapa !== "null") resp += `🧭 Cómo llegar: ${urlMapa}\n`;

        return this.client.enviarBotones(accountId, conversationId, resp, [
            { title: "Menú", value: "menu" },
            { title: "Cambiar ubicación", value: "inicio" }
        ]);
    }

    // Nombre de sede sin adornos, apto para comparar por contencion.
    nombreParaBuscar(titulo) {
        return normalizar(String(titulo || ''))
            .replace(/[^\w\s]/g, ' ')
            .replace(/\b(sucursal|laboratorio|lab|matriz|toma)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Busca un municipio o una sucursal MENCIONADOS dentro de una frase mas larga.
    buscarUbicacionEnFrase(datos, textoNormalizado) {
        if (!textoNormalizado || textoNormalizado.length < 4) return null;
        let mejor = null;

        for (const [estado, municipios] of Object.entries(datos || {})) {
            for (const [municipio, sedes] of Object.entries(municipios || {})) {
                const sedesCoincidentes = (sedes || []).filter(sede => {
                    // OJO: expandirTextoBusqueda() anade "villa hermosa hermosa mosa" al final,
                    // asi que no sirve para un includes(). Aqui hace falta el nombre pelado.
                    const limpio = this.nombreParaBuscar(sede.titulo);
                    return limpio.length >= 4 && textoNormalizado.includes(limpio);
                });
                if (sedesCoincidentes.length > 0) {
                    const largo = Math.max(...sedesCoincidentes.map(s => this.nombreParaBuscar(s.titulo).length));
                    if (!mejor || largo > mejor.largo) {
                        mejor = { estado, municipio, sedes: sedesCoincidentes, largo };
                    }
                    continue;
                }
                const muni = normalizar(municipio);
                if (muni.length >= 4 && textoNormalizado.includes(muni)) {
                    if (!mejor || muni.length > mejor.largo) {
                        mejor = { estado, municipio, sedes, largo: muni.length };
                    }
                }
            }
        }

        return mejor;
    }

    extraerCodigoPostal(texto) {
        const match = String(texto || '').match(/\b\d{5}\b/);
        return match ? match[0] : null;
    }

    nombreCortoSucursal(sede) {
        const nombreLimpio = String(sede.titulo || sede.nombre || 'Sucursal')
            .replace("SUCURSAL ", "")
            .replace(" MATRIZ", "")
            .replace(/[()]/g, '')
            .trim();
        return toTitleCase(nombreLimpio);
    }

    formatearDistancia(km) {
        if (!Number.isFinite(km)) return '';
        if (km < 1) return `${Math.round(km * 1000)} m`;
        return `${km.toFixed(1)} km`;
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

    async iniciarFlujoSucursales(accountId, conversationId) {
        try {
            logger.info('SUCURSALES_FLOW', 'Iniciando catalogo manual de sucursales', {
                accountId,
                conversationId
            });
            const datos = await this.cache.obtenerDatos();
            if (!datos) throw new Error("Datos vacíos");
            const estados = this.cache.obtenerEstados(datos);
            logger.info('SUCURSALES_FLOW', 'Estados disponibles para sucursales', {
                conversationId,
                estados
            });
            this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_ESTADO);
            if (estados.length <= 3) {
                 return this.client.enviarBotones(
                    accountId, conversationId,
                    "¿En qué estado estás?",
                    estados.map(e => ({ title: e, value: `estado_${normalizar(e)}` }))
                );
            }
            return this.client.enviarListaDesplegable(accountId, conversationId, "¿En qué estado estás?", "Elegir Estado", estados.map(e => ({ title: e, value: `estado_${normalizar(e)}` })));
        } catch (e) {
            logger.error('SUCURSALES_FLOW', 'Error cargando sucursales manuales', {
                conversationId,
                error: e.stack || e.message || String(e)
            });
            console.error(e);
            return this.client.enviarTexto(accountId, conversationId, "⚠️ Error técnico cargando sucursales.");
        }
    }

    async manejarSeleccionEstado(accountId, conversationId, mensaje) {
        const estadoBuscado = mensaje.replace("estado_", "");
        logger.info('SUCURSALES_FLOW', 'Seleccion de estado recibida', {
            accountId,
            conversationId,
            mensaje,
            estadoBuscado
        });
        try {
            const datos = await this.cache.obtenerDatos();
            const res = this.cache.obtenerMunicipios(datos, estadoBuscado);
            if (!res) {
                logger.warn('SUCURSALES_FLOW', 'Estado no valido', {
                    conversationId,
                    estadoBuscado
                });
                return this.client.enviarTexto(accountId, conversationId, "Estado no válido.");
            }

            let todasLasSedes = [];
            if (res.municipios && res.municipios.length > 0) {
                for (const muni of res.municipios) {
                    const datosMuni = this.cache.buscarMunicipio(muni);
                    if (datosMuni && datosMuni.sedes) {
                        todasLasSedes = todasLasSedes.concat(datosMuni.sedes);
                    }
                }
            }

            todasLasSedes.sort((a, b) => {
                const nombreA = a.titulo.replace("SUCURSAL ", "").replace(" MATRIZ", "").trim();
                const nombreB = b.titulo.replace("SUCURSAL ", "").replace(" MATRIZ", "").trim();
                return nombreA.localeCompare(nombreB);
            });

            this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_MUNICIPIO, {
                estadoSeleccionado: res.estado,
                municipios: res.municipios,
                sedesDisponibles: todasLasSedes
            });
            logger.info('SUCURSALES_FLOW', 'Estado seleccionado y sedes preparadas', {
                conversationId,
                estado: res.estado,
                municipios: res.municipios,
                totalSedes: todasLasSedes.length
            });

            return this.enviarPaginaSedes(accountId, conversationId, 0);
        } catch (e) {
            logger.error('SUCURSALES_FLOW', 'Error seleccionando estado', {
                conversationId,
                mensaje,
                error: e.stack || e.message || String(e)
            });
            console.error(e);
            this.estados.reiniciar(conversationId);
        }
    }

    async enviarPaginaSedes(accountId, conversationId, pagina) {
        const estadoActual = this.estados.obtener(conversationId);
        const { sedesDisponibles, estadoSeleccionado } = estadoActual.datos;
        const TAMANO_PAGINA = 9;
        const inicio = pagina * TAMANO_PAGINA;
        const fin = inicio + TAMANO_PAGINA;
        const sedesPagina = sedesDisponibles.slice(inicio, fin);
        const hayMas = sedesDisponibles.length > fin;
        logger.info('SUCURSALES_FLOW', 'Enviando pagina de sedes', {
            accountId,
            conversationId,
            pagina,
            estadoSeleccionado,
            totalSedes: sedesDisponibles.length,
            sedesPagina
        });

        const opciones = sedesPagina.map((sede) => {
            const indexGlobal = sedesDisponibles.indexOf(sede);
            let nombre = sede.titulo.replace("SUCURSAL ", "").replace(" MATRIZ", "").replace(/[()]/g, '').trim();
            if (nombre.length > 24) nombre = nombre.substring(0, 24).trim();
            return { title: nombre, value: `sucursal_${indexGlobal}` };
        });

        if (hayMas) opciones.push({ title: "➡️ Ver más...", value: `pagina_${pagina + 1}` });

        this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_SUCURSAL, {
            ...estadoActual.datos,
            paginaActual: pagina
        });

        return this.client.enviarListaDesplegable(
            accountId, conversationId,
            `Sucursales en ${estadoSeleccionado || 'el Estado'}:\nSelecciona una opción o escribe el nombre:`,
            "Ver Sucursales",
            opciones
        );
    }

    async manejarSeleccionBusqueda(accountId, conversationId, mensaje) {
        logger.info('SUCURSALES_FLOW', 'Seleccion/busqueda manual de sucursal recibida', {
            accountId,
            conversationId,
            mensaje
        });
        if (mensaje.includes("Ver más") || mensaje.includes("pagina_")) {
             return this.manejarSeleccionSucursal(accountId, conversationId, mensaje);
        }
        const inputUsuario = normalizar(mensaje);
        try {
            const datos = await this.cache.obtenerDatos();
            const listaEstados = this.cache.obtenerEstados(datos);
            const estadoDetectado = listaEstados.find(e => normalizar(e) === inputUsuario);

            if (estadoDetectado) {
                logger.info('SUCURSALES_FLOW', 'Busqueda manual detecto estado', {
                    conversationId,
                    estadoDetectado
                });
                return this.manejarSeleccionEstado(accountId, conversationId, `estado_${normalizar(estadoDetectado)}`);
            }

            let estadoActual = this.estados.obtener(conversationId);
            let sedesDisponibles = estadoActual.datos?.sedesDisponibles || [];
            let sedeEncontrada = this.buscarSedeEnLista(sedesDisponibles, inputUsuario);

            if (!sedeEncontrada) {
                for (const keyEstado in datos) {
                    const municipios = Object.keys(datos[keyEstado] || {});
                    for (const nombreMuni of municipios) {
                        const infoMuni = this.cache.buscarMunicipio(nombreMuni);
                        if (normalizar(nombreMuni) === inputUsuario) {
                             if (infoMuni && infoMuni.sedes) {
                                sedeEncontrada = infoMuni.sedes[0];
                                this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_MUNICIPIO, {
                                    estadoSeleccionado: keyEstado, municipios: municipios, sedesDisponibles: infoMuni.sedes
                                });
                                if (infoMuni.sedes.length > 1) return this.enviarPaginaSedes(accountId, conversationId, 0);
                                break;
                             }
                        }
                        if (infoMuni && infoMuni.sedes) {
                            const posibleSede = this.buscarSedeEnLista(infoMuni.sedes, inputUsuario);
                            if (posibleSede) {
                                sedeEncontrada = posibleSede;
                                this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_MUNICIPIO, {
                                    estadoSeleccionado: keyEstado, municipios: municipios, sedesDisponibles: infoMuni.sedes
                                });
                                break;
                            }
                        }
                    }
                    if (sedeEncontrada) break;
                }
            }

            if (sedeEncontrada) {
                logger.info('SUCURSALES_FLOW', 'Sede encontrada por busqueda manual', {
                    conversationId,
                    mensaje,
                    sedeEncontrada
                });
                return this.asignarSucursal(accountId, conversationId, sedeEncontrada, {
                    tipo: 'texto',
                    texto: mensaje
                });
            }
            logger.warn('SUCURSALES_FLOW', 'No se encontro sucursal por busqueda manual', {
                conversationId,
                mensaje,
                inputUsuario
            });
            await this.client.enviarTexto(accountId, conversationId, `No encontré ninguna sucursal llamada "${mensaje}".\n\nPor favor verifica el nombre.`);
        } catch (e) {
            logger.error('SUCURSALES_FLOW', 'Error buscando informacion de sucursal', {
                conversationId,
                mensaje,
                error: e.stack || e.message || String(e)
            });
            console.error(e);
            return this.client.enviarTexto(accountId, conversationId, "⚠️ Ocurrió un error buscando la información.");
        }
    }

    buscarSedeEnLista(lista, input) {
        if (!lista || lista.length === 0) return null;
        const entrada = this.expandirTextoBusqueda(input);
        if (!entrada) return null;
        const tokensEntrada = entrada
            .split(/\s+/)
            .filter(token => token.length >= 4 && !['villa', 'sucursal', 'laboratorio'].includes(token));

        return lista.find(s => {
            const tituloOriginal = this.expandirTextoBusqueda(s.titulo);
            const tituloLimpio = this.expandirTextoBusqueda(
                String(s.titulo || '')
                    .replace("SUCURSAL ", "")
                    .replace(" MATRIZ", "")
                    .replace(/[()]/g, '')
            );
            const tokensTitulo = new Set(`${tituloOriginal} ${tituloLimpio}`.split(/\s+/));
            const coincideToken = tokensEntrada.some(token => tokensTitulo.has(token));

            return tituloOriginal.includes(entrada) ||
                tituloLimpio.includes(entrada) ||
                entrada.includes(tituloLimpio) ||
                coincideToken;
        });
    }

    expandirTextoBusqueda(texto) {
        let limpio = normalizar(String(texto || ''))
            .replace(/[^\w\s]/g, ' ')
            .replace(/\b(sucursal|laboratorio|lab|matriz)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (limpio.includes('villahermosa') || limpio.includes('villa hermosa')) {
            limpio = `${limpio} villa hermosa hermosa mosa`;
        }

        return limpio;
    }

    numeroDesdeTexto(texto) {
        const msg = normalizar(texto);
        const numero = msg.match(/\b([1-9])\b/);
        if (numero) return Number(numero[1]);

        const palabras = new Map([
            ['uno', 1], ['una', 1], ['primer', 1], ['primero', 1], ['primera', 1],
            ['dos', 2], ['segundo', 2], ['segunda', 2],
            ['tres', 3], ['tercer', 3], ['tercero', 3], ['tercera', 3],
            ['cuatro', 4], ['cuarto', 4], ['cuarta', 4],
            ['cinco', 5], ['quinto', 5], ['quinta', 5]
        ]);

        for (const [palabra, valor] of palabras.entries()) {
            if (new RegExp(`\\b${palabra}\\b`).test(msg)) return valor;
        }

        return null;
    }

    async manejarSeleccionSucursal(accountId, conversationId, mensaje) {
        const estadoActual = this.estados.obtener(conversationId);
        logger.info('SUCURSALES_FLOW', 'Seleccion de sucursal manual recibida', {
            accountId,
            conversationId,
            mensaje,
            estado: estadoActual.estado,
            datos: estadoActual.datos
        });
        if (mensaje.startsWith("pagina_")) {
            return this.enviarPaginaSedes(accountId, conversationId, parseInt(mensaje.replace("pagina_", "")));
        }
        if (mensaje.includes("Ver más")) {
            return this.enviarPaginaSedes(accountId, conversationId, (estadoActual.datos?.paginaActual || 0) + 1);
        }
        const { sedesDisponibles } = estadoActual.datos || {};
        if (!sedesDisponibles) return this.manejarSeleccionBusqueda(accountId, conversationId, mensaje);

        if (mensaje.startsWith("sucursal_")) {
            const sede = sedesDisponibles[parseInt(mensaje.replace("sucursal_", ""))];
            if (sede) return this.asignarSucursal(accountId, conversationId, sede, {
                tipo: 'seleccion_manual'
            });
        } else {
            return this.manejarSeleccionBusqueda(accountId, conversationId, mensaje);
        }
        logger.warn('SUCURSALES_FLOW', 'Opcion manual de sucursal invalida', {
            conversationId,
            mensaje
        });
        return this.client.enviarTexto(accountId, conversationId, "Opción no válida.");
    }

    async enviarDetallesSede(accountId, conversationId, sede) {
        logger.info('SUCURSALES_FLOW', 'Enviando detalles de sede manual', {
            accountId,
            conversationId,
            sede
        });
        const tituloBonito = sede.titulo.replace(" MATRIZ", "").replace(/[()]/g, '').trim();
        let resp = `*${tituloBonito}*\n\n${sede.direccion}\n\n`;
        if (sede.horario_general) resp += `🕒 Horario: ${sede.horario_general}\n\n`;
        if (sede.whatsapp) resp += `📱 WA: ${sede.whatsapp}\n`;
        if (sede.telefono) resp += `📞 Tel: ${sede.telefono}\n`;
        const urlMapa = sede.mapa_movil || sede.url_mapa || sede.url_iframe_mapa;
        if (urlMapa && urlMapa !== "null") resp += `🧭 Cómo llegar: ${urlMapa}\n`;

        const estadoActual = this.estados.obtener(conversationId);
        this.estados.actualizar(conversationId, ESTADOS.ESPERANDO_MUNICIPIO, estadoActual.datos);
        return this.client.enviarBotones(accountId, conversationId, resp, [{ title: "Volver al Inicio", value: "inicio" }]);
    }
}

module.exports = FlujoSucursales;
