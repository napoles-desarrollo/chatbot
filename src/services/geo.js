const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const LCC = {
    a: 6378137.0,
    invF: 298.257223563,
    standardParallel1: 17.5,
    standardParallel2: 29.5,
    latitudeOfOrigin: 12,
    centralMeridian: -102,
    falseEasting: 2500000,
    falseNorthing: 0
};

class GeoService {
    constructor(shapefileBasePath) {
        this.defaultShapefileBasePath = path.resolve(__dirname, '..', 'utils', 'CP_Tab', 'CP_Tab');
        this.shapefileBasePaths = this.normalizarBases(shapefileBasePath);
        this.shapefileBasePath = this.shapefileBasePaths[0];
        this.cpIndex = null;
        this.projection = this.crearProyeccion();
        logger.debug('GEO', 'GeoService inicializado', {
            shapefileBasePaths: this.shapefileBasePaths
        });
    }

    normalizarBases(entrada) {
        const valores = Array.isArray(entrada)
            ? entrada
            : String(entrada || '')
                .split(/[;,]/)
                .map(item => item.trim())
                .filter(Boolean);

        const bases = valores.length > 0 ? valores : [this.defaultShapefileBasePath];

        if (!bases.includes(this.defaultShapefileBasePath)) {
            bases.push(this.defaultShapefileBasePath);
        }

        return [...new Set(bases)];
    }

    convertirRutaWindowsAWsl(ruta) {
        if (process.platform === 'win32') return ruta;
        const match = String(ruta || '').match(/^([a-zA-Z]):[\\/](.*)$/);
        if (!match) return ruta;

        const drive = match[1].toLowerCase();
        const resto = match[2].replace(/\\/g, '/');
        return `/mnt/${drive}/${resto}`;
    }

    quitarExtensionShapefile(base) {
        const extension = path.extname(base).toLowerCase();
        if (['.dbf', '.shp', '.shx', '.prj'].includes(extension)) {
            return base.slice(0, -extension.length);
        }
        return base;
    }

    resolverBaseCandidata(base) {
        const candidatos = [
            base,
            this.convertirRutaWindowsAWsl(base)
        ].filter(Boolean);

        for (const candidato of [...new Set(candidatos)]) {
            const sinExtension = this.quitarExtensionShapefile(candidato);
            const comoDirectorio = this.resolverBaseDesdeDirectorio(sinExtension);
            const opciones = comoDirectorio ? [sinExtension, comoDirectorio] : [sinExtension];

            for (const opcion of opciones) {
                const dbfPath = `${opcion}.dbf`;
                const shpPath = `${opcion}.shp`;

                if (fs.existsSync(dbfPath) && fs.existsSync(shpPath)) {
                    return { base: opcion, dbfPath, shpPath };
                }
            }
        }

        return null;
    }

    resolverBaseDesdeDirectorio(base) {
        try {
            if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return null;
            const archivos = fs.readdirSync(base);
            const dbf = archivos.find(archivo => archivo.toLowerCase().endsWith('.dbf'));
            if (!dbf) return null;

            return path.join(base, dbf.slice(0, -4));
        } catch (_error) {
            return null;
        }
    }

    obtenerBasesDisponibles() {
        const disponibles = [];
        const revisadas = [];
        const basesAgregadas = new Set();

        for (const base of this.shapefileBasePaths) {
            const resuelta = this.resolverBaseCandidata(base);

            if (resuelta) {
                const llave = path.resolve(resuelta.base).toLowerCase();
                if (!basesAgregadas.has(llave)) {
                    disponibles.push(resuelta);
                    basesAgregadas.add(llave);
                }
            } else {
                revisadas.push(base);
                const convertida = this.convertirRutaWindowsAWsl(base);
                if (convertida !== base) revisadas.push(convertida);
            }
        }

        if (disponibles.length === 0) {
            logger.error('GEO', 'No se encontraron shapefiles disponibles', {
                rutasRevisadas: revisadas
            });
            throw new Error(
                `No se encontraron shapefiles de CP. Rutas revisadas: ${revisadas.join(', ')}. ` +
                `Configura CP_SHAPEFILE_BASE o CP_SHAPEFILE_BASES, o deja el paquete en ${this.defaultShapefileBasePath}.`
            );
        }

        logger.info('GEO', 'Shapefiles disponibles', {
            disponibles
        });
        return disponibles;
    }

    crearProyeccion() {
        const f = 1 / LCC.invF;
        const e = Math.sqrt(2 * f - f * f);
        const phi1 = this.rad(LCC.standardParallel1);
        const phi2 = this.rad(LCC.standardParallel2);
        const phi0 = this.rad(LCC.latitudeOfOrigin);

        const m = phi => Math.cos(phi) / Math.sqrt(1 - Math.pow(e * Math.sin(phi), 2));
        const t = phi => {
            const sinPhi = Math.sin(phi);
            return Math.tan(Math.PI / 4 - phi / 2) /
                Math.pow((1 - e * sinPhi) / (1 + e * sinPhi), e / 2);
        };

        const n = Math.log(m(phi1) / m(phi2)) / Math.log(t(phi1) / t(phi2));
        const F = m(phi1) / (n * Math.pow(t(phi1), n));
        const rho0 = LCC.a * F * Math.pow(t(phi0), n);

        return { e, n, F, rho0, t };
    }

    rad(grados) {
        return grados * Math.PI / 180;
    }

    deg(radianes) {
        return radianes * 180 / Math.PI;
    }

    proyectar(latitud, longitud) {
        const { n, F, rho0, t } = this.projection;
        const phi = this.rad(latitud);
        const lambda = this.rad(longitud);
        const lambda0 = this.rad(LCC.centralMeridian);
        const rho = LCC.a * F * Math.pow(t(phi), n);
        const theta = n * (lambda - lambda0);

        return {
            x: LCC.falseEasting + rho * Math.sin(theta),
            y: LCC.falseNorthing + rho0 - rho * Math.cos(theta)
        };
    }

    desproyectar(x, y) {
        const { e, n, F, rho0 } = this.projection;
        const lambda0 = this.rad(LCC.centralMeridian);
        const xp = x - LCC.falseEasting;
        const yp = rho0 - (y - LCC.falseNorthing);
        const rho = Math.sign(n) * Math.hypot(xp, yp);
        const theta = Math.atan2(xp, yp);
        const t = Math.pow(rho / (LCC.a * F), 1 / n);
        let phi = Math.PI / 2 - 2 * Math.atan(t);

        for (let i = 0; i < 15; i++) {
            const sinPhi = Math.sin(phi);
            const siguiente = Math.PI / 2 - 2 * Math.atan(
                t * Math.pow((1 - e * sinPhi) / (1 + e * sinPhi), e / 2)
            );
            if (Math.abs(siguiente - phi) < 1e-14) break;
            phi = siguiente;
        }

        return {
            latitud: this.deg(phi),
            longitud: this.deg(lambda0 + theta / n)
        };
    }

    cargarCpIndex() {
        if (this.cpIndex) {
            logger.debug('GEO', 'Usando indice CP en memoria', {
                total: this.cpIndex.length
            });
            return this.cpIndex;
        }

        const bases = this.obtenerBasesDisponibles();
        const index = [];

        bases.forEach(({ base, dbfPath, shpPath }) => {
            logger.info('GEO', 'Leyendo shapefile CP', {
                base,
                dbfPath,
                shpPath
            });
            const registros = this.leerDbf(dbfPath);
            const poligonos = this.leerShp(shpPath);
            logger.debug('GEO', 'Registros shapefile leidos', {
                base,
                registros: registros.length,
                poligonos: poligonos.length
            });

            registros.forEach((registro, indiceRegistro) => {
                const poligono = poligonos[indiceRegistro];
                if (!poligono) return;

                const centroide = this.calcularCentroide(poligono);
                const coordenadas = this.desproyectar(centroide.x, centroide.y);

                index.push({
                    cp: String(registro.d_cp || registro.cp || '').trim(),
                    fuente: base,
                    poligono,
                    centroide: {
                        x: centroide.x,
                        y: centroide.y,
                        latitud: coordenadas.latitud,
                        longitud: coordenadas.longitud
                    }
                });
            });
        });

        this.cpIndex = index.filter(item => item.cp && item.poligono);
        logger.info('GEO', 'Indice CP cargado', {
            total: this.cpIndex.length,
            fuentes: [...new Set(this.cpIndex.map(item => item.fuente))]
        });

        return this.cpIndex;
    }

    leerDbf(dbfPath) {
        const buffer = fs.readFileSync(dbfPath);
        const cantidad = buffer.readUInt32LE(4);
        const headerLength = buffer.readUInt16LE(8);
        const recordLength = buffer.readUInt16LE(10);
        const campos = [];
        let pos = 32;

        while (pos < headerLength && buffer[pos] !== 0x0D) {
            const rawName = buffer.subarray(pos, pos + 11);
            const nullIndex = rawName.indexOf(0);
            const name = rawName.subarray(0, nullIndex >= 0 ? nullIndex : rawName.length)
                .toString('ascii')
                .trim();
            campos.push({
                name,
                type: String.fromCharCode(buffer[pos + 11]),
                length: buffer[pos + 16]
            });
            pos += 32;
        }

        const registros = [];
        for (let i = 0; i < cantidad; i++) {
            const inicio = headerLength + i * recordLength;
            const record = buffer.subarray(inicio, inicio + recordLength);
            if (!record.length || record[0] === 0x2A) continue;

            let offset = 1;
            const obj = {};
            campos.forEach(campo => {
                const raw = record.subarray(offset, offset + campo.length).toString('latin1').trim();
                obj[campo.name] = raw;
                offset += campo.length;
            });
            registros.push(obj);
        }

        return registros;
    }

    leerShp(shpPath) {
        const buffer = fs.readFileSync(shpPath);
        const poligonos = [];
        let pos = 100;

        while (pos + 8 <= buffer.length) {
            pos += 4;
            const contentLength = buffer.readInt32BE(pos) * 2;
            pos += 4;
            const fin = pos + contentLength;
            const shapeType = buffer.readInt32LE(pos);
            pos += 4;

            if (shapeType !== 5) {
                poligonos.push(null);
                pos = fin;
                continue;
            }

            const bbox = [
                buffer.readDoubleLE(pos),
                buffer.readDoubleLE(pos + 8),
                buffer.readDoubleLE(pos + 16),
                buffer.readDoubleLE(pos + 24)
            ];
            pos += 32;

            const numParts = buffer.readInt32LE(pos);
            const numPoints = buffer.readInt32LE(pos + 4);
            pos += 8;

            const parts = [];
            for (let i = 0; i < numParts; i++) {
                parts.push(buffer.readInt32LE(pos));
                pos += 4;
            }

            const points = [];
            for (let i = 0; i < numPoints; i++) {
                points.push({
                    x: buffer.readDoubleLE(pos),
                    y: buffer.readDoubleLE(pos + 8)
                });
                pos += 16;
            }

            poligonos.push({ bbox, parts, points });
            pos = fin;
        }

        return poligonos;
    }

    calcularCentroide(poligono) {
        const limites = [...poligono.parts, poligono.points.length];
        let areaTotal = 0;
        let sumaX = 0;
        let sumaY = 0;

        for (let i = 0; i < limites.length - 1; i++) {
            const ring = poligono.points.slice(limites[i], limites[i + 1]);
            const parcial = this.centroideRing(ring);

            if (parcial) {
                areaTotal += parcial.area;
                sumaX += parcial.x * parcial.area;
                sumaY += parcial.y * parcial.area;
            }
        }

        if (Math.abs(areaTotal) > 1e-9) {
            return { x: sumaX / areaTotal, y: sumaY / areaTotal };
        }

        const [xmin, ymin, xmax, ymax] = poligono.bbox;
        return { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 };
    }

    centroideRing(points) {
        let area2 = 0;
        let cx6 = 0;
        let cy6 = 0;

        for (let i = 0; i < points.length; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % points.length];
            const cross = p1.x * p2.y - p2.x * p1.y;
            area2 += cross;
            cx6 += (p1.x + p2.x) * cross;
            cy6 += (p1.y + p2.y) * cross;
        }

        if (Math.abs(area2) < 1e-9) return null;

        return {
            area: area2 / 2,
            x: cx6 / (3 * area2),
            y: cy6 / (3 * area2)
        };
    }

    buscarCp(cp) {
        const index = this.cargarCpIndex();
        const encontrado = index.find(item => item.cp === String(cp).trim()) || null;
        logger.info('GEO', 'Busqueda de CP', {
            cp,
            encontrado: encontrado ? {
                cp: encontrado.cp,
                fuente: encontrado.fuente,
                centroide: encontrado.centroide
            } : null
        });
        return encontrado;
    }

    resolverCp(cp) {
        const item = this.buscarCp(cp);
        if (!item) {
            logger.warn('GEO', 'CP no encontrado', { cp });
            return null;
        }

        const resuelto = {
            tipo: 'cp',
            cp: item.cp,
            latitud: item.centroide.latitud,
            longitud: item.centroide.longitud
        };
        logger.info('GEO', 'CP resuelto a coordenadas', resuelto);
        return resuelto;
    }

    resolverCoordenadas(latitud, longitud) {
        logger.info('GEO', 'Resolviendo coordenadas GPS', {
            latitud,
            longitud
        });
        const punto = this.proyectar(latitud, longitud);
        const index = this.cargarCpIndex();
        const cp = index.find(item => this.contienePunto(item.poligono, punto.x, punto.y));

        const resuelto = {
            tipo: 'gps',
            cp: cp ? cp.cp : null,
            latitud,
            longitud
        };
        logger.info('GEO', 'Coordenadas resueltas', {
            ...resuelto,
            fuente: cp?.fuente || null
        });
        return resuelto;
    }

    contienePunto(poligono, x, y) {
        const [xmin, ymin, xmax, ymax] = poligono.bbox;
        if (x < xmin || x > xmax || y < ymin || y > ymax) return false;

        const limites = [...poligono.parts, poligono.points.length];
        let dentro = false;

        for (let i = 0; i < limites.length - 1; i++) {
            const ring = poligono.points.slice(limites[i], limites[i + 1]);
            if (this.puntoEnRing(x, y, ring)) dentro = !dentro;
        }

        return dentro;
    }

    puntoEnRing(x, y, ring) {
        let dentro = false;
        let j = ring.length - 1;

        for (let i = 0; i < ring.length; i++) {
            const pi = ring[i];
            const pj = ring[j];
            const cruza = (pi.y > y) !== (pj.y > y);
            if (cruza) {
                const xInterseccion = (pj.x - pi.x) * (y - pi.y) / ((pj.y - pi.y) || 1e-30) + pi.x;
                if (x < xInterseccion) dentro = !dentro;
            }
            j = i;
        }

        return dentro;
    }

    distanciaKm(origen, destino) {
        const radio = 6371;
        const lat1 = this.rad(origen.latitud);
        const lat2 = this.rad(destino.latitud);
        const dLat = this.rad(destino.latitud - origen.latitud);
        const dLng = this.rad(destino.longitud - origen.longitud);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

        return 2 * radio * Math.asin(Math.sqrt(a));
    }

    sucursalesCercanas(datos, origen, limite = 5) {
        const sucursales = [];

        Object.keys(datos || {}).forEach(estado => {
            Object.keys(datos[estado] || {}).forEach(municipio => {
                (datos[estado][municipio] || []).forEach(sucursal => {
                    if (
                        sucursal.latitud === null || sucursal.latitud === undefined || sucursal.latitud === '' ||
                        sucursal.longitud === null || sucursal.longitud === undefined || sucursal.longitud === ''
                    ) return;

                    const latitud = Number(sucursal.latitud);
                    const longitud = Number(sucursal.longitud);

                    if (!Number.isFinite(latitud) || !Number.isFinite(longitud)) return;

                    sucursales.push({
                        ...sucursal,
                        estado,
                        municipio,
                        distanciaKm: this.distanciaKm(origen, { latitud, longitud })
                    });
                });
            });
        });

        const cercanas = sucursales
            .sort((a, b) => a.distanciaKm - b.distanciaKm)
            .slice(0, limite);
        logger.info('GEO', 'Sucursales cercanas calculadas', {
            origen,
            limite,
            totalCandidatas: sucursales.length,
            cercanas: cercanas.map(sucursal => ({
                id: sucursal.id,
                titulo: sucursal.titulo,
                municipio: sucursal.municipio,
                distanciaKm: sucursal.distanciaKm
            }))
        });
        return cercanas;
    }
}

module.exports = GeoService;
