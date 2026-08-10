const { normalizar, calcularSimilitud } = require('../utils/helpers');
const AliasEstudiosService = require('./aliasesEstudios');
const logger = require('./logger');

class CatalogoService {
    constructor(apiClient = null, aliases = new AliasEstudiosService(), db = null, opciones = {}) {
        this.api = apiClient;
        this.aliases = aliases;
        this.db = db;
        this.fechaTopDesde = opciones.fechaTopDesde || '2026-01-01';
        this.limiteTop = opciones.limiteTop || 5;
        this.cacheTodosEstudios = new Map();
    }

    obtenerTiposServicio() {
        return [
            { id: 'laboratorio', nombre: 'Laboratorio clínico' },
            { id: 'usg', nombre: 'Ultrasonido' },
            { id: 'rayos_x', nombre: 'Rayos X' }
        ];
    }

    async buscarEstudios({ texto, tipoServicio, sucursal }) {
        const alias = this.resolverAlias(texto);
        const candidatosAlias = alias?.candidatos || [];
        const consulta = alias && !alias.requiereConfirmacion && candidatosAlias.length === 1
            ? candidatosAlias[0].nombre
            : texto;
        const listaPrecioId = this.obtenerListaPrecioId(sucursal);

        logger.info('CATALOGO', 'Buscando estudios', {
            texto,
            tipoServicio,
            sucursal,
            listaPrecioId,
            alias,
            consulta
        });

        let data;
        if (this.db?.buscarEstudios) {
            data = await this.db.buscarEstudios({
                texto: consulta,
                tipoServicio,
                listaPrecioId,
                estudioIds: candidatosAlias.map(candidato => candidato.id),
                // Con ids del alias el TOP no debe recortar: si el diccionario ofrece 10
                // opciones y solo llegan 8, al paciente le falta justo la que buscaba.
                limite: candidatosAlias.length > 0 ? Math.max(8, candidatosAlias.length) : undefined
            });

            if ((!data || data.length === 0) && this.db?.obtenerTodosLosEstudios && listaPrecioId) {
                if (!this.cacheTodosEstudios.has(listaPrecioId)) {
                    const todos = await this.db.obtenerTodosLosEstudios({ listaPrecioId });
                    this.cacheTodosEstudios.set(listaPrecioId, todos);
                }
                const todosLosEstudios = this.cacheTodosEstudios.get(listaPrecioId);
                
                const coincidenciasFuzzy = todosLosEstudios
                    .map(estudio => {
                        const similitudNombre = calcularSimilitud(consulta, estudio.Nombre);
                        return { ...estudio, similitud: similitudNombre };
                    })
                    // 0.75 daba falsos positivos graves ("prueba de alergias" -> PRUEBA DE
                    // PATERNIDAD, que comparten el prefijo). Ahora que SQL busca por tokens
                    // este rescate solo debe actuar ante erratas, no ante frases distintas.
                    .filter(estudio => estudio.similitud >= 0.86)
                    .sort((a, b) => b.similitud - a.similitud)
                    .slice(0, 5);

                if (coincidenciasFuzzy.length > 0) {
                    data = coincidenciasFuzzy;
                }
            }
        } else if (this.api?.disponible()) {
            data = await this.api.get('/catalogo/estudios', {
                query: consulta,
                tipo: tipoServicio,
                listaPrecioId,
                estudioIds: candidatosAlias.length
                    ? candidatosAlias.map(candidato => candidato.id).join(',')
                    : undefined
            });
        } else {
            logger.warn('CATALOGO', 'Sin DB/API disponible para buscar estudios', {
                texto,
                tipoServicio
            });
            return [];
        }

        const normalizada = this.normalizarLista(data);
        logger.info('CATALOGO', 'Busqueda de estudios normalizada', {
            texto,
            consulta,
            total: normalizada.length,
            resultados: normalizada
        });
        return normalizada;
    }

    async obtenerMasSolicitados({ tipoServicio, sucursal }) {
        const listaPrecioId = this.obtenerListaPrecioId(sucursal);
        logger.info('CATALOGO', 'Obteniendo estudios mas solicitados', {
            tipoServicio,
            sucursal,
            listaPrecioId,
            fechaTopDesde: this.fechaTopDesde,
            limiteTop: this.limiteTop
        });

        let data;
        if (this.db?.obtenerEstudiosMasSolicitados) {
            data = await this.db.obtenerEstudiosMasSolicitados({
                tipoServicio,
                listaPrecioId,
                fechaDesde: this.fechaTopDesde,
                limite: this.limiteTop
            });
        } else if (this.api?.disponible()) {
            data = await this.api.get('/catalogo/mas-solicitados', {
                tipo: tipoServicio,
                listaPrecioId
            });
        } else {
            logger.warn('CATALOGO', 'Sin DB/API disponible para mas solicitados', {
                tipoServicio
            });
            return [];
        }

        const normalizada = this.normalizarLista(data);
        logger.info('CATALOGO', 'Mas solicitados normalizados', {
            total: normalizada.length,
            resultados: normalizada
        });
        return normalizada;
    }

    async cotizar({ estudios, sucursal }) {
        const listaPrecioId = this.obtenerListaPrecioId(sucursal);
        logger.info('CATALOGO', 'Cotizando desde catalogo', {
            sucursal,
            listaPrecioId,
            estudios
        });

        let data;
        if (this.db?.cotizarEstudios) {
            data = await this.db.cotizarEstudios({
                listaPrecioId,
                estudios
            });
        } else if (this.api?.disponible()) {
            data = await this.api.post('/catalogo/cotizar', {
                listaPrecioId,
                estudios: estudios.map(estudio => ({
                    id: estudio.id,
                    nombre: estudio.nombre
                }))
            });
        } else {
            logger.warn('CATALOGO', 'Sin DB/API disponible para cotizar', {
                estudios,
                sucursal
            });
            return null;
        }

        const cotizacion = this.normalizarCotizacion(data, estudios, sucursal);
        logger.info('CATALOGO', 'Cotizacion normalizada', cotizacion);
        return cotizacion;
    }

    async registrarCotizacion(payload) {
        logger.info('CATALOGO', 'Registrando cotizacion', payload);
        if (!this.api?.disponible()) {
            logger.warn('CATALOGO', 'API no disponible para registrar cotizacion');
            return null;
        }
        const respuesta = await this.api.post('/consultas/cotizacion', payload);
        logger.info('CATALOGO', 'Cotizacion registrada', respuesta);
        return respuesta;
    }

    normalizarLista(data) {
        const lista = Array.isArray(data) ? data : (data?.items || data?.resultados || data?.estudios || []);
        return lista.map(item => ({
            id: item.id || item.IdEstudio || item.idEstudio || item.codigo || item.nombre,
            nombre: item.nombre || item.Nombre || item.estudio || item.Estudio || item.descripcion || '',
            precio: this.numero(item.precio ?? item.Precio),
            preparacion: item.preparacion || item.indicaciones || item.preparación || item.CondicionPaciente || '',
            tiempoEntrega: item.tiempoEntrega || item.tiempo_entrega || item.entrega || '',
            tipoServicio: item.tipoServicio || item.tipo || null,
            cantidad: this.numero(item.cantidad ?? item.Cantidad),
            score: item.score || item.confidence || null
        })).filter(item => item.nombre);
    }

    normalizarCotizacion(data, estudios, sucursal) {
        if (!data) return null;

        const origenItems = Array.isArray(data)
            ? data
            : (data.items || data.estudios || data.detalle || estudios);
        const items = this.normalizarLista(origenItems);
        const totalCalculado = items.reduce((total, item) => total + (Number(item.precio) || 0), 0);

        return {
            sucursal,
            items,
            total: this.numero(data.total ?? data.Total) ?? totalCalculado,
            moneda: data.moneda || 'MXN',
            notas: data.notas || data.observaciones || '',
            vigenteHasta: data.vigenteHasta || data.vigente_hasta || null
        };
    }

    obtenerListaPrecioId(sucursal) {
        return sucursal?.lista_precio || sucursal?.IdListaPrecio || sucursal?.idListaPrecio || null;
    }

    resolverAlias(texto) {
        return this.aliases?.resolver(texto) || null;
    }

    numero(valor) {
        if (valor === undefined || valor === null || valor === '') return null;
        const n = Number(valor);
        return Number.isFinite(n) ? n : null;
    }

    coincideTexto(estudio, texto) {
        return normalizar(estudio.nombre).includes(normalizar(texto));
    }
}

module.exports = CatalogoService;
