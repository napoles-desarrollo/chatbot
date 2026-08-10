// Validacion FUNCIONAL del diccionario de alias: no solo que los ids existan,
// sino que cada termino que escriba un paciente acabe devolviendo algo util.
//
//   node test/validar-diccionario.js [idListaPrecio] [rutaJson]
//
// Comprueba cuatro cosas por cada termino:
//   1. Que resuelva (que el servicio lo reconozca).
//   2. Que resuelva a SU grupo y no lo eclipse otro termino mas largo.
//   3. Que sus ids existan en LAB.Estudios.
//   4. Que al menos un candidato tenga precio activo en esa sucursal.
//      Si ninguno lo tiene, el alias apaga el filtro de texto (database.js) y
//      el paciente recibe "no encontre" aunque el estudio exista.

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../src/config');
const AliasEstudiosService = require('../src/services/aliasesEstudios');
const { normalizar } = require('../src/utils/helpers');

const LISTA = Number(process.argv[2] || 2);
const RUTA = path.resolve(process.argv[3] || path.join(__dirname, '..', 'src', 'data', 'estudios-aliases.json'));

const rojo = t => `\x1b[31m${t}\x1b[0m`;
const verde = t => `\x1b[32m${t}\x1b[0m`;
const amarillo = t => `\x1b[33m${t}\x1b[0m`;

(async () => {
    console.log(`\nDiccionario: ${RUTA}`);
    console.log(`Lista de precios: ${LISTA}\n`);

    let servicio;
    try {
        servicio = new AliasEstudiosService(RUTA);
    } catch (error) {
        console.log(rojo(`El servicio NO carga este archivo: ${error.message}`));
        console.log('El bot no arrancaria con este diccionario.');
        process.exit(1);
    }

    const crudo = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
    const grupos = crudo.aliases;
    const totalTerminos = grupos.reduce((n, g) => n + g.terminos.length, 0);
    console.log(verde(`✓ Carga correctamente: ${grupos.length} grupos, ${totalTerminos} terminos\n`));

    // --- 2. Terminos eclipsados por otro grupo -------------------------------
    const eclipsados = [];
    for (const grupo of grupos) {
        const idsGrupo = new Set(grupo.candidatos.map(c => c.id_estudio));
        for (const termino of grupo.terminos) {
            const r = servicio.resolver(termino);
            if (!r) {
                eclipsados.push({ termino, motivo: 'no resuelve' });
                continue;
            }
            const idsResueltos = r.candidatos.map(c => c.id);
            if (!idsResueltos.some(id => idsGrupo.has(id))) {
                eclipsados.push({
                    termino,
                    motivo: `lo captura otro grupo -> ${r.candidatos[0].nombre.slice(0, 40)}`
                });
            }
        }
    }

    // --- 3 y 4. Contra el catalogo real -------------------------------------
    const ids = [...new Set(grupos.flatMap(g => g.candidatos.map(c => c.id_estudio)))];
    let filas = null;
    try {
        const sql = require('mssql');
        const pool = await new sql.ConnectionPool(CONFIG.DB).connect();
        const r = await pool.request().query(`
            SELECT E.IdEstudio, LTRIM(RTRIM(E.Nombre)) AS Nombre, LPE.Precio,
                   (SELECT COUNT(*) FROM LAB.ListaDePrecioEstudio x
                     WHERE x.IdEstudio = E.IdEstudio AND x.Activo = 1) AS EnListas
            FROM LAB.Estudios E
            LEFT JOIN LAB.ListaDePrecioEstudio LPE
                   ON LPE.IdEstudio = E.IdEstudio AND LPE.IdListaPrecio = ${LISTA} AND LPE.Activo = 1
            WHERE E.IdEstudio IN (${ids.join(',')})`);
        filas = new Map(r.recordset.map(x => [Number(x.IdEstudio), x]));
        await pool.close();
    } catch (error) {
        console.log(amarillo(`Sin acceso a SQL (${error.message}): solo se valida la parte lexica.\n`));
    }

    const muertos = [];
    const desincronizados = [];
    const sinPrecio = [];
    const soloOtrasSucursales = [];

    if (filas) {
        for (const grupo of grupos) {
            const conPrecio = grupo.candidatos.filter(c => {
                const f = filas.get(c.id_estudio);
                return f && f.Precio !== null && f.Precio !== undefined;
            });
            for (const c of grupo.candidatos) {
                const f = filas.get(c.id_estudio);
                if (!f) {
                    muertos.push({ ...c, alias: grupo.terminos[0] });
                } else if (normalizar(f.Nombre) !== normalizar(c.nombre)) {
                    desincronizados.push({ ...c, real: f.Nombre, alias: grupo.terminos[0] });
                }
            }
            if (conPrecio.length === 0) {
                // Distinguir "esta sucursal no lo ofrece" (normal) de "no lo ofrece nadie" (defecto).
                const enAlgunaLista = grupo.candidatos.some(c => Number(filas.get(c.id_estudio)?.EnListas || 0) > 0);
                const destino = enAlgunaLista ? soloOtrasSucursales : sinPrecio;
                destino.push({
                    alias: grupo.terminos[0],
                    terminos: grupo.terminos.length,
                    candidatos: grupo.candidatos.map(c => c.id_estudio).join(', '),
                    listas: grupo.candidatos.reduce((n, c) => n + Number(filas.get(c.id_estudio)?.EnListas || 0), 0)
                });
            }
        }
    }

    // --- Informe -------------------------------------------------------------
    const bloque = (titulo, lista, formato, explicacion) => {
        if (lista.length === 0) return;
        console.log(rojo(`${titulo} (${lista.length})`));
        if (explicacion) console.log(`   ${explicacion}\n`);
        lista.slice(0, 20).forEach(x => console.log(`   ${formato(x)}`));
        if (lista.length > 20) console.log(`   ... y ${lista.length - 20} mas`);
        console.log();
    };

    bloque('❌ TERMINOS QUE NO LLEGAN A SU GRUPO', eclipsados,
        x => `"${x.termino}" — ${x.motivo}`,
        'Otro grupo con un termino mas especifico se los queda.');

    bloque('❌ IDS INEXISTENTES', muertos,
        x => `${x.id_estudio} "${x.nombre}" (alias: ${x.alias})`,
        'El alias gana, aporta el id, se descarta el LIKE y no devuelve nada. Estudio inencontrable.');

    bloque('⚠️  NOMBRE DESINCRONIZADO CON EL CATALOGO', desincronizados,
        x => `${x.id_estudio}\n      alias:    "${x.nombre}"\n      catalogo: "${x.real}"`,
        'Funciona (manda por id), pero el archivo esta describiendo otra cosa.');

    bloque('❌ GRUPOS QUE NINGUNA SUCURSAL COTIZA', sinPrecio,
        x => `"${x.alias}" (+${x.terminos - 1} terminos) -> ids ${x.candidatos}`,
        'Existen en el catalogo pero no estan en ninguna lista de precios: alias inutil.');

    if (soloOtrasSucursales.length) {
        console.log(amarillo(`ℹ️  NO DISPONIBLES EN LA LISTA ${LISTA}, SI EN OTRAS SUCURSALES (${soloOtrasSucursales.length})`));
        console.log('   No es un defecto del diccionario: ese estudio no se ofrece aqui.\n');
        soloOtrasSucursales.forEach(x =>
            console.log(`   "${x.alias}" -> ids ${x.candidatos} (activo en ${x.listas} listas)`));
        console.log();
    }

    const problemas = eclipsados.length + muertos.length + sinPrecio.length;
    if (problemas === 0) {
        console.log(verde('✓ Diccionario funcional: todos los terminos resuelven y todos los grupos cotizan.\n'));
    } else {
        console.log(`Resumen: ${problemas} problemas que afectan al paciente` +
            (desincronizados.length ? `, ${desincronizados.length} avisos cosmeticos` : '') + '\n');
    }
})();
