const sql = require('mssql');
const logger = require('./logger');

const ESTUDIOS_EXCLUIDOS_RESULTADOS = `
    199,200,201,224,236,237,238,239,240,241,242,243,244,245,246,247,248,249,
    250,251,252,253,254,255,256,257,258,259,260,261,262,263,
    293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308,309,310,
    311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,
    329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,
    347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,
    365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,
    383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,
    401,402,403,404,405,406,407,408,409,410,423,424,
    546,548,555,556,557,562,563,564,565,566,
    718,722,723,725,726,731,732,733,734,
    1739,1744,
    3734,3735,3736,3740,
    4750,4753,4754,4755,4768,4775,4776,4784,4785,4809,4823,
    4847,4848,4849,4850,4851,4852,4853,4854,4855,4864,4876,4887,
    4901,4902,4951,4953,4954,4955,4956,4968,4980,4981,4988,4998,
    5001,5004,5005,5007,5009,5010,
    5018,5019,5020,5021,5022,5023,5024,5025,5026,5027,5028,5029,5030,5031,
    5032,5033,5034,5035,5036,5037,5038,5039,5040,5041,5042,5043,5044,5045,
    5046,5047,5048,5049,5050,5051,5052,5053,5054,5055,5056,5057,5058,5059,
    5060,5061,5062,5063,5064,5065,5066,5067,5068,5069,5070,5071,5072,5073,
    5074,5075,5076,5077,5078,5079,5080,5081,5082,5083,5084,5085,5086,5087,
    5088,5089,5090,5091,5092,5093,5094,5095,5096,5097,5098,5099,5100,5101,
    5102,5103,5104,5105,5106,5107,5108,5109,5110,5111,5112,5113,5114,5115,
    5116,5117,5118,5119,5120,5121,5122,5123,5124,5125,5126,5127,5128,5129,
    5130,5131,5132,5133,5134,5135,5136,5137,5138,5139,5140,5141,5142,5143,
    5144,5145,5147,5152,5156,5157,5158,5163,5164,5165,5168,
    5262,5297,5300,5301,5314,5316,5344,5346,5361,5362,5367,5368,5369,
    5377,5378,5379,5380,5381,5382,5383,5384,5385,5387,
    5425,5451,5454,5460,5462,5486,5490,5497,5498,5504,5507,5510,5511,
    5519,5523,5527,5528,5539,5554
`;

class GestorBaseDatos {
    constructor(config, driver = sql) {
        this.config = config;
        this.sql = driver;
    }

    async obtenerLinkResultados(folio) {
        return this.conConexion(async pool => {
            logger.info('SQL', 'Consultando link de resultados', { folio });
            console.log('SQL Folio:', folio);
            const result = await pool.request()
                .input('folioInput', this.sql.VarChar, folio)
                .query(`
                    SELECT TOP 1
                        r.IdRecepcion,
                        (
                            SELECT COUNT(*)
                            FROM LAB.SeguimientoEstatusEstudio s
                            WHERE s.IdRecepcion = r.IdRecepcion
                              AND s.Activo = 1
                              AND (s.IdEstatus < 5 OR s.IdEstatus > 9)
                              AND s.IdEstudio NOT IN (${ESTUDIOS_EXCLUIDOS_RESULTADOS})
                        ) AS Pendientes,
                        CONCAT(
                            'https://www.sisclin.mx:8087/Resultados/CreaPDFResultadoMembreteDescarga2?_IdRecepcion=',
                            r.IdRecepcion,
                            '&_IdUsuario=',
                            r.IdUsuario
                        ) AS LinkDescarga
                    FROM LAB.Recepcion r
                    WHERE r.Folio = @folioInput
                    ORDER BY r.FechaCreacion DESC;
                `);

            const row = result.recordset[0];
            logger.info('SQL', 'Resultado consulta de folio', {
                folio,
                filas: result.recordset.length,
                row
            });
            if (!row) return null;

            return {
                link: row.LinkDescarga,
                estatus: Number(row.Pendientes) > 0 ? 1 : 7
            };
        }, 'consultando resultados');
    }

    async buscarEstudios({ texto, listaPrecioId, estudioIds = [], limite = 8 }) {
        this.validarListaPrecio(listaPrecioId);

        const consulta = String(texto || '').trim();
        const ids = [...new Set(estudioIds.map(Number).filter(Number.isInteger))];
        if (!consulta && ids.length === 0) return [];

        const consultaSinonimo = consulta.replace(/\b(VIH|HIV)\b/gi, match => (
            match.toUpperCase() === 'VIH' ? 'HIV' : 'VIH'
        ));

        return this.conConexion(async pool => {
            logger.info('SQL', 'Buscando estudios', {
                texto: consulta,
                consultaSinonimo,
                listaPrecioId,
                estudioIds: ids,
                limite
            });
            const request = pool.request()
                .input('listaPrecioId', this.sql.Int, Number(listaPrecioId))
                .input('limite', this.sql.Int, this.limitar(limite, 1, 20, 8))
                .input('texto', this.sql.NVarChar(200), `%${consulta}%`)
                .input('textoSinonimo', this.sql.NVarChar(200), `%${consultaSinonimo}%`)
                .input('textoExacto', this.sql.NVarChar(200), consulta)
                .input('textoInicio', this.sql.NVarChar(200), `${consulta}%`);

            const tokensCrudos = this.tokenizarBusqueda(consulta);
            const primero = tokensCrudos[0];
            request.input(
                'tokenInicio',
                this.sql.NVarChar(100),
                `${primero ? (primero.sinonimo || primero.token) : consulta}%`
            );

            // El LIKE de frase completa exige que el texto aparezca contiguo, asi que
            // "rx torax" no encuentra "RX. TORAX AP" (sobra el punto). Se anade una
            // alternativa por tokens: todas las palabras deben aparecer, en cualquier orden.
            const tokens = tokensCrudos;
            let filtroTokens = '';
            if (tokens.length >= 1) {
                const condiciones = tokens.map(({ token, sinonimo }, index) => {
                    const nombre = `tok${index}`;
                    request.input(nombre, this.sql.NVarChar(100), `%${token}%`);
                    if (!sinonimo) return `(E.Nombre LIKE @${nombre} OR E.Clave LIKE @${nombre})`;
                    const alterno = `tokAlt${index}`;
                    request.input(alterno, this.sql.NVarChar(100), `%${sinonimo}%`);
                    return `(E.Nombre LIKE @${nombre} OR E.Clave LIKE @${nombre}` +
                        ` OR E.Nombre LIKE @${alterno} OR E.Clave LIKE @${alterno})`;
                });
                filtroTokens = ` OR (${condiciones.join(' AND ')})`;
            }

            let filtroIds = '';
            let filtroTexto = `AND (@textoExacto = '' OR E.Nombre LIKE @texto OR E.Clave LIKE @texto OR E.Nombre LIKE @textoSinonimo OR E.Clave LIKE @textoSinonimo${filtroTokens})`;

            if (ids.length > 0) {
                const parametros = ids.map((id, index) => {
                    const nombre = `estudioId${index}`;
                    request.input(nombre, this.sql.Int, id);
                    return `@${nombre}`;
                });
                filtroIds = `AND E.IdEstudio IN (${parametros.join(', ')})`;
                filtroTexto = ''; // Ignoramos el LIKE del texto original porque ya tenemos los IDs exactos del alias
            }

            const result = await request.query(`
                SELECT TOP (@limite)
                    E.IdEstudio,
                    LTRIM(RTRIM(E.Nombre)) + ' (' + LTRIM(RTRIM(E.Clave)) + ')' AS Estudio,
                    LPE.Precio,
                    E.CondicionPaciente,
                    E.Observaciones
                FROM LAB.ListaDePrecioEstudio LPE
                INNER JOIN LAB.Estudios E ON E.IdEstudio = LPE.IdEstudio
                WHERE LPE.IdListaPrecio = @listaPrecioId
                  AND LPE.Activo = 1
                  ${filtroIds}
                  ${filtroTexto}
                ORDER BY
                    -- El servicio a domicilio cuesta mas del doble: nunca debe salir
                    -- por delante del estudio normal salvo que lo pidan explicitamente.
                    CASE WHEN E.Nombre LIKE '%DOMICILIO%' AND @texto NOT LIKE '%DOMICILIO%' THEN 1 ELSE 0 END,
                    -- El catalogo mezcla estudios veterinarios con los humanos.
                    CASE WHEN (E.Nombre LIKE '%CANIN%' OR E.Nombre LIKE '%BOVINO%')
                          AND @texto NOT LIKE '%CANIN%' AND @texto NOT LIKE '%BOVINO%'
                          AND @texto NOT LIKE '%PERR%' AND @texto NOT LIKE '%VETERIN%'
                         THEN 1 ELSE 0 END,
                    CASE WHEN LTRIM(E.Nombre) LIKE @tokenInicio OR LTRIM(E.Clave) LIKE @tokenInicio THEN 0 ELSE 1 END,
                    CASE
                        WHEN LTRIM(RTRIM(E.Nombre)) = @textoExacto OR LTRIM(RTRIM(E.Clave)) = @textoExacto THEN 0
                        WHEN LTRIM(E.Nombre) LIKE @textoInicio OR LTRIM(E.Clave) LIKE @textoInicio THEN 1
                        WHEN E.Nombre LIKE @texto OR E.Clave LIKE @texto THEN 2
                        ELSE 3
                    END,
                    LTRIM(E.Nombre) ASC;
            `);

            logger.info('SQL', 'Busqueda de estudios terminada', {
                texto: consulta,
                listaPrecioId,
                filas: result.recordset.length,
                resultados: result.recordset
            });

            return result.recordset;
        }, 'buscando estudios');
    }

    async obtenerTodosLosEstudios({ listaPrecioId }) {
        this.validarListaPrecio(listaPrecioId);

        return this.conConexion(async pool => {
            logger.info('SQL', 'Obteniendo todos los estudios para Fuzzy Search', {
                listaPrecioId
            });
            const request = pool.request()
                .input('listaPrecioId', this.sql.Int, Number(listaPrecioId));

            const result = await request.query(`
                SELECT
                    E.IdEstudio,
                    E.Nombre + ' (' + E.Clave + ')' AS Estudio,
                    LPE.Precio,
                    E.CondicionPaciente,
                    E.Observaciones,
                    E.Nombre
                FROM LAB.ListaDePrecioEstudio LPE
                INNER JOIN LAB.Estudios E ON E.IdEstudio = LPE.IdEstudio
                WHERE LPE.IdListaPrecio = @listaPrecioId
                  AND LPE.Activo = 1
            `);

            logger.info('SQL', 'Obtencion de todos los estudios terminada', {
                listaPrecioId,
                filas: result.recordset.length
            });

            return result.recordset;
        }, 'obteniendo todos los estudios');
    }

    async obtenerEstudiosMasSolicitados({ listaPrecioId, fechaDesde = '2026-01-01', limite = 5 }) {
        this.validarListaPrecio(listaPrecioId);
        const fecha = this.validarFecha(fechaDesde);

        return this.conConexion(async pool => {
            logger.info('SQL', 'Consultando estudios mas solicitados', {
                listaPrecioId,
                fechaDesde: fecha,
                limite
            });
            const result = await pool.request()
                .input('listaPrecioId', this.sql.Int, Number(listaPrecioId))
                .input('limite', this.sql.Int, this.limitar(limite, 1, 10, 5))
                .input('fechaDesde', this.sql.Date, fecha)
                .query(`
                    SELECT TOP (@limite)
    RE.IdEstudio,
    E.Nombre + ' (' + E.Clave + ')' AS Estudio,
    COUNT(*) AS Cantidad,
    MAX(LPE.Precio) AS Precio,
    MAX(E.CondicionPaciente) AS CondicionPaciente,
    MAX(E.Observaciones) AS Observaciones
FROM LAB.RecepcionEstudio RE
INNER JOIN LAB.Estudios E ON E.IdEstudio = RE.IdEstudio
INNER JOIN LAB.ListaDePrecioEstudio LPE
    ON LPE.IdEstudio = RE.IdEstudio
    AND LPE.IdListaPrecio = @listaPrecioId
    AND LPE.Activo = 1
WHERE RE.FechaCreacion >= @fechaDesde
    AND RE.FechaCreacion < DATEADD(DAY, 1, CONVERT(date, GETDATE()))
    AND RE.Activo = 1
    -- Excluimos cualquier registro cuyo nombre contenga "urgencia" (o "urgencias")
    AND E.Nombre NOT LIKE '%urgencia%'
GROUP BY RE.IdEstudio, E.Nombre, E.Clave
ORDER BY Cantidad DESC, E.Nombre ASC;
                `);

            logger.info('SQL', 'Top estudios terminado', {
                listaPrecioId,
                filas: result.recordset.length,
                resultados: result.recordset
            });

            return result.recordset;
        }, 'obteniendo estudios mas solicitados');
    }

    async cotizarEstudios({ listaPrecioId, estudios }) {
        this.validarListaPrecio(listaPrecioId);
        const ids = [...new Set((estudios || []).map(estudio => Number(estudio.id)).filter(Number.isInteger))];
        if (ids.length === 0) return [];

        return this.conConexion(async pool => {
            logger.info('SQL', 'Cotizando estudios', {
                listaPrecioId,
                estudios,
                ids
            });
            const request = pool.request()
                .input('listaPrecioId', this.sql.Int, Number(listaPrecioId));
            const parametros = ids.map((id, index) => {
                const nombre = `estudioId${index}`;
                request.input(nombre, this.sql.Int, id);
                return `@${nombre}`;
            });

            const result = await request.query(`
                SELECT
                    E.IdEstudio,
                    E.Nombre + ' (' + E.Clave + ')' AS Estudio,
                    LPE.Precio,
                    E.CondicionPaciente,
                    E.Observaciones
                FROM LAB.ListaDePrecioEstudio LPE
                INNER JOIN LAB.Estudios E ON E.IdEstudio = LPE.IdEstudio
                WHERE LPE.IdListaPrecio = @listaPrecioId
                  AND LPE.Activo = 1
                  AND E.IdEstudio IN (${parametros.join(', ')})
                ORDER BY E.Nombre ASC;
            `);

            logger.info('SQL', 'Cotizacion terminada', {
                listaPrecioId,
                filas: result.recordset.length,
                resultados: result.recordset
            });

            return result.recordset;
        }, 'cotizando estudios');
    }

    async conConexion(operacion, contexto) {
        let pool;
        try {
            logger.debug('SQL', 'Abriendo conexion SQL', {
                contexto,
                server: this.config?.server,
                database: this.config?.database,
                user: this.config?.user,
                port: this.config?.port
            });
            pool = await new this.sql.ConnectionPool(this.config).connect();
            const resultado = await operacion(pool);
            logger.debug('SQL', 'Operacion SQL completada', { contexto });
            return resultado;
        } catch (err) {
            logger.error('SQL', 'Error SQL', {
                contexto,
                error: err.stack || err.message || String(err)
            });
            console.error(`Error SQL ${contexto}:`, err.message);
            throw err;
        } finally {
            if (pool) {
                await pool.close();
                logger.debug('SQL', 'Conexion SQL cerrada', { contexto });
            }
        }
    }

    validarListaPrecio(valor) {
        const id = Number(valor);
        if (!Number.isInteger(id) || id <= 0) {
            throw new Error('La sucursal no tiene un IdListaPrecio valido');
        }
    }

    validarFecha(valor) {
        const texto = String(valor || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
            throw new Error('TOP_STUDIES_FROM debe usar formato YYYY-MM-DD');
        }

        const fecha = new Date(`${texto}T00:00:00`);
        if (Number.isNaN(fecha.getTime())) {
            throw new Error('TOP_STUDIES_FROM no contiene una fecha valida');
        }
        return fecha;
    }

    // Palabras vacias que no aportan a la busqueda del catalogo.
    static PALABRAS_VACIAS = new Set([
        'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'o', 'u', 'en', 'para',
        'con', 'un', 'una', 'unos', 'unas', 'mi', 'me', 'por', 'al', 'a', 'que',
        // Muletillas del paciente que el catalogo nunca usa. Sin quitarlas,
        // "prueba de covid" exige la palabra "prueba" y no encuentra nada.
        'prueba', 'pruebas', 'examen', 'examenes', 'estudio', 'estudios',
        'analisis', 'análisis', 'test', 'chequeo', 'checar', 'funcion', 'función',
        'quiero', 'necesito', 'cuesta', 'cuanto', 'precio', 'costo', 'hacer',
        'hacerme', 'sacar', 'saber', 'tengo', 'mis', 'sus', 'su', 'como', 'valor'
    ]);

    // Como lo dice el paciente -> como lo escribe el catalogo. Resuelve familias
    // enteras de estudios sin necesidad de un alias por cada uno.
    static SINONIMOS_TOKEN = new Map([
        ['radiografia', 'rx'], ['radiografía', 'rx'], ['radiografias', 'rx'],
        ['rayosx', 'rx'], ['rayos', 'rx'], ['placa', 'rx'], ['placas', 'rx'],
        ['ultrasonido', 'usg'], ['ultrasonidos', 'usg'], ['ecografia', 'usg'],
        ['ecografía', 'usg'], ['eco', 'usg'], ['sonograma', 'usg'],
        ['citometria', 'biometria'], ['citometría', 'biometria'],
        ['hematica', 'hematica'], ['hemática', 'hematica'],
        ['electro', 'electrocardiograma'],
        ['ego', 'orina'],
        ['papanicolau', 'papanicolaou'], ['papanicolao', 'papanicolaou'],
        // Como lo nombra el paciente vs la forma que usa el catalogo.
        ['prostata', 'prostatico'], ['próstata', 'prostatico'],
        ['tiroides', 'tiroide'], ['tiroidea', 'tiroide'], ['tiroideo', 'tiroide'],
        ['sida', 'hiv'],
        ['higado', 'hepatic'], ['hígado', 'hepatic'], ['hepatico', 'hepatic'],
        ['renal', 'renal'], ['riñon', 'renal'], ['riñón', 'renal'], ['rinon', 'renal'],
        ['alergias', 'alergenos'], ['alergia', 'alergenos'],
        ['heces', 'heces'], ['popo', 'heces'], ['excremento', 'heces'],
        ['orines', 'orina'], ['pipi', 'orina'],
        ['coagulacion', 'coagulacion'], ['coagulación', 'coagulacion'],
        ['embarazada', 'embarazo'], ['preñada', 'embarazo'], ['prenada', 'embarazo']
    ]);

    tokenizarBusqueda(texto) {
        const tokens = String(texto || '')
            .replace(/[^\wáéíóúüñÁÉÍÓÚÜÑ]+/g, ' ')
            .split(/\s+/)
            .map(token => token.trim())
            // Las letras y numeros sueltos SI importan aqui: "hepatitis b" no es
            // "hepatitis c", ni "quimica 6" es "quimica 12". Las vocales sueltas que
            // solo son preposiciones ya estan en PALABRAS_VACIAS.
            .filter(token => (token.length >= 2 || /^[\wáéíóúüñ]$/i.test(token)) &&
                !GestorBaseDatos.PALABRAS_VACIAS.has(token.toLowerCase()));

        return [...new Set(tokens)].slice(0, 6).map(token => {
            const sinonimo = GestorBaseDatos.SINONIMOS_TOKEN.get(token.toLowerCase());
            return sinonimo && sinonimo !== token.toLowerCase()
                ? { token, sinonimo }
                : { token, sinonimo: null };
        });
    }

    limitar(valor, minimo, maximo, fallback) {
        const numero = Number.parseInt(valor, 10);
        if (!Number.isInteger(numero)) return fallback;
        return Math.min(maximo, Math.max(minimo, numero));
    }
}

module.exports = GestorBaseDatos;
