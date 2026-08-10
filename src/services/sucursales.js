const http = require('http');
const https = require('https');
const { normalizar } = require('../utils/helpers');
const logger = require('./logger');

function textoONull(valor) {
    if (valor === undefined || valor === null) return null;
    const texto = String(valor).trim();
    return texto || null;
}

function numeroONull(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
}

function extraerCoordenadasMapa(url) {
    if (!url) return null;

    const mapa = String(url);
    const mapaComun = mapa.match(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
    if (mapaComun) {
        return { latitud: Number(mapaComun[2]), longitud: Number(mapaComun[1]) };
    }

    const streetView = mapa.match(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/);
    if (streetView) {
        return { latitud: Number(streetView[1]), longitud: Number(streetView[2]) };
    }

    return null;
}

function esUrlMapaMovil(url) {
    if (!url) return false;
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'maps.app.goo.gl' ||
            hostname === 'maps.apple.com' ||
            hostname.endsWith('.waze.com') ||
            hostname === 'waze.com' ||
            hostname === 'goo.gl' ||
            hostname.includes('google.') && String(url).includes('/maps');
    } catch (_error) {
        return false;
    }
}

function descargarJson(url, timeoutMs = 10000, redirects = 3) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { headers: { 'User-Agent': 'chatbot-napoles' } }, res => {
            const location = res.headers.location;

            if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects > 0) {
                res.resume();
                const nextUrl = new URL(location, url).toString();
                descargarJson(nextUrl, timeoutMs, redirects - 1).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`JSON inválido: ${e.message}`));
                }
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Timeout descargando ${url}`));
        });
        req.on('error', reject);
    });
}

class SucursalesService {
    constructor(dataUrl, cacheTtl) {
        this.dataUrl = dataUrl;
        this.cacheTtl = cacheTtl || 1000 * 60 * 10;
        this.datos = null;
        this.ultimaCarga = 0;
    }

    async obtenerDatos({ forzar = false } = {}) {
        const ahora = Date.now();
        const cacheVigente = !forzar && this.datos && (ahora - this.ultimaCarga) < this.cacheTtl;

        if (cacheVigente) {
            logger.debug('SUCURSALES', 'Usando cache de sucursales', {
                dataUrl: this.dataUrl,
                edadMs: ahora - this.ultimaCarga,
                total: this.contarSucursales(this.datos)
            });
            return this.datos;
        }

        try {
            logger.info('SUCURSALES', 'Descargando catalogo remoto de sucursales', {
                dataUrl: this.dataUrl,
                forzar
            });
            const data = await descargarJson(this.dataUrl, 10000);
            this.datos = this.homologarDatos(data);
            this.ultimaCarga = Date.now();
            logger.info('SUCURSALES', 'Catalogo de sucursales cargado', {
                estados: this.obtenerEstados(this.datos),
                total: this.contarSucursales(this.datos)
            });
            return this.datos;
        } catch (e) {
            if (this.datos) {
                logger.warn('SUCURSALES', 'Error actualizando sucursales, usando cache en memoria', {
                    dataUrl: this.dataUrl,
                    error: e.message,
                    total: this.contarSucursales(this.datos)
                });
                console.error(`⚠️ Error actualizando sucursales, usando caché en memoria: ${e.message}`);
                return this.datos;
            }
            logger.error('SUCURSALES', 'No se pudieron cargar sucursales remotas', {
                dataUrl: this.dataUrl,
                error: e.message
            });
            throw new Error(`No se pudieron cargar las sucursales remotas: ${e.message}`);
        }
    }

    validarDatos(datos) {
        if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
            throw new Error('Formato inválido: se esperaba un objeto de estados');
        }

        const estados = Object.keys(datos);
        if (estados.length === 0) {
            throw new Error('Formato inválido: catálogo de sucursales vacío');
        }

        for (const estado of estados) {
            const municipios = datos[estado];
            if (!municipios || typeof municipios !== 'object' || Array.isArray(municipios)) {
                throw new Error(`Formato inválido para el estado ${estado}`);
            }

            for (const [municipio, sucursales] of Object.entries(municipios)) {
                if (!Array.isArray(sucursales)) {
                    throw new Error(`Formato inválido: ${estado}/${municipio} debe ser Sucursales[]`);
                }
            }
        }
    }

    homologarDatos(datos) {
        this.validarDatos(datos);
        const resultado = {};
        const ids = new Set();

        for (const [estado, municipios] of Object.entries(datos)) {
            resultado[estado] = {};

            for (const [municipio, sucursales] of Object.entries(municipios)) {
                resultado[estado][municipio] = sucursales.map((sucursal, indice) => {
                    const homologada = this.homologarSucursal(sucursal, estado, municipio, indice);
                    if (ids.has(homologada.id)) {
                        throw new Error(`IdSucursal duplicado: ${homologada.id}`);
                    }
                    ids.add(homologada.id);
                    return homologada;
                });
            }
        }

        return resultado;
    }

    homologarSucursal(sucursal, estado, municipio, indice) {
        if (!sucursal || typeof sucursal !== 'object' || Array.isArray(sucursal)) {
            throw new Error(`Sucursal inválida en ${estado}/${municipio}[${indice}]`);
        }

        const id = Number(sucursal.id ?? sucursal.IdSucursal ?? sucursal.idSucursal);
        const titulo = textoONull(sucursal.titulo ?? sucursal.nombre ?? sucursal.Sucursal);
        const urlIframeMapa = textoONull(sucursal.url_iframe_mapa ?? sucursal.mapa);
        let latitud = numeroONull(sucursal.latitud ?? sucursal.latitude ?? sucursal.lat);
        let longitud = numeroONull(sucursal.longitud ?? sucursal.longitude ?? sucursal.lng ?? sucursal.lon);

        if (latitud === null && longitud === null) {
            const coordenadasMapa = extraerCoordenadasMapa(urlIframeMapa);
            latitud = coordenadasMapa?.latitud ?? null;
            longitud = coordenadasMapa?.longitud ?? null;
        }

        if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`IdSucursal inválido en ${estado}/${municipio}[${indice}]`);
        }
        if (!titulo) {
            throw new Error(`Título de sucursal faltante para IdSucursal ${id}`);
        }
        if ((latitud === null) !== (longitud === null)) {
            throw new Error(`Coordenadas incompletas para IdSucursal ${id}`);
        }
        if (latitud !== null && (latitud < -90 || latitud > 90 || longitud < -180 || longitud > 180)) {
            throw new Error(`Coordenadas fuera de rango para IdSucursal ${id}`);
        }

        const serviciosOriginales = sucursal.servicios ?? sucursal.services;
        const servicios = Array.isArray(serviciosOriginales)
            ? serviciosOriginales.map(textoONull).filter(Boolean).join(', ')
            : textoONull(serviciosOriginales);
        const listaPrecioValor = sucursal.lista_precio ?? sucursal.IdListaPrecio ?? sucursal.idListaPrecio;
        const listaPrecio = numeroONull(listaPrecioValor);
        if (listaPrecio !== null && (!Number.isInteger(listaPrecio) || listaPrecio <= 0)) {
            throw new Error(`IdListaPrecio inválido para IdSucursal ${id}`);
        }
        const destinoMapa = latitud !== null
            ? encodeURIComponent(`${latitud},${longitud}`)
            : null;
        const mapaMovilOriginal = textoONull(sucursal.mapa_movil ?? sucursal.url_mapa ?? sucursal.urlMapa);
        const mapaMovil = (esUrlMapaMovil(mapaMovilOriginal) ? mapaMovilOriginal : null) ||
            (destinoMapa
                ? `https://www.google.com/maps/dir/?api=1&destination=${destinoMapa}&travelmode=driving`
                : null);

        return {
            id,
            titulo,
            direccion: textoONull(sucursal.direccion ?? sucursal.domicilio) || '',
            telefono: textoONull(sucursal.telefono ?? sucursal.phone),
            whatsapp: textoONull(sucursal.whatsapp ?? sucursal.wa),
            horario_general: textoONull(sucursal.horario_general ?? sucursal.horario),
            latitud,
            longitud,
            mapa_movil: mapaMovil,
            lista_precio: listaPrecio,
            url_mapa: mapaMovil,
            url_iframe_mapa: urlIframeMapa,
            img: textoONull(sucursal.img ?? sucursal.imagen),
            servicios,
            estado,
            municipio
        };
    }

    obtenerEstados(datos) {
        return Object.keys(datos || {});
    }

    obtenerMunicipios(datos, estadoInput) {
        const estadoKey = Object.keys(datos || {}).find(k => normalizar(k) === normalizar(estadoInput));

        if (!estadoKey) return null;

        return {
            estado: estadoKey,
            municipios: Object.keys(datos[estadoKey])
        };
    }

    buscarMunicipio(municipioInput, datos = this.datos) {
        const inputNorm = normalizar(municipioInput);
        if (!inputNorm || !datos) return null;

        // 1. Coincidencia exacta por nombre de municipio
        for (const estado in datos) {
            const municipios = datos[estado];
            for (const mun in municipios) {
                if (normalizar(mun) === inputNorm) {
                    return {
                        estado,
                        nombre: mun,
                        sedes: municipios[mun]
                    };
                }
            }
        }

        // 2. Coincidencia parcial: el input contiene el municipio o el municipio contiene el input
        for (const estado in datos) {
            const municipios = datos[estado];
            for (const mun in municipios) {
                const munNorm = normalizar(mun);
                if (munNorm.includes(inputNorm) || inputNorm.includes(munNorm)) {
                    return {
                        estado,
                        nombre: mun,
                        sedes: municipios[mun]
                    };
                }
            }
        }

        // 3. Buscar por nombre de sucursal (titulo) — ej. "Villahermosa" en "SUCURSAL VILLAHERMOSA"
        for (const estado in datos) {
            const municipios = datos[estado];
            for (const mun in municipios) {
                const sedesCoincidentes = municipios[mun].filter(sede => {
                    const tituloNorm = normalizar(sede.titulo || sede.nombre || '');
                    return tituloNorm.includes(inputNorm) || inputNorm.includes(tituloNorm);
                });
                if (sedesCoincidentes.length > 0) {
                    return {
                        estado,
                        nombre: mun,
                        sedes: sedesCoincidentes
                    };
                }
            }
        }

        return null;
    }

    async actualizarSucursal(sucursal) {
        if (!sucursal) return null;
        logger.debug('SUCURSALES', 'Actualizando sucursal desde catalogo remoto', {
            sucursal
        });
        const datos = await this.obtenerDatos({ forzar: true });

        for (const municipios of Object.values(datos)) {
            for (const sedes of Object.values(municipios)) {
                const encontrada = sedes.find(sede => Number(sede.id) === Number(sucursal.id));
                if (encontrada) {
                    logger.info('SUCURSALES', 'Sucursal actualizada encontrada', {
                        id: sucursal.id,
                        encontrada
                    });
                    return encontrada;
                }
            }
        }

        logger.warn('SUCURSALES', 'Sucursal no encontrada al actualizar', {
            sucursal
        });
        return null;
    }

    contarSucursales(datos) {
        let total = 0;
        for (const municipios of Object.values(datos || {})) {
            for (const sedes of Object.values(municipios || {})) {
                total += Array.isArray(sedes) ? sedes.length : 0;
            }
        }
        return total;
    }
}

module.exports = SucursalesService;
