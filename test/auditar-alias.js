// Comprueba que cada id_estudio de estudios-aliases.json exista de verdad y esté
// activo en una lista de precios. Un alias que apunta a un id inexistente no solo
// falla: además desactiva el filtro de texto (database.js:124), asi que la busqueda
// tampoco puede caer al LIKE. El estudio se vuelve INENCONTRABLE.
//
//   node test/auditar-alias.js [idListaPrecio]
//
// Si no hay acceso a SQL desde esta maquina, imprime la consulta para pegarla en SSMS.

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../src/config');

const LISTA = Number(process.argv[2] || 0);
const rutaAlias = path.resolve(__dirname, '..', 'src', 'data', 'estudios-aliases.json');
const aliases = JSON.parse(fs.readFileSync(rutaAlias, 'utf8')).aliases;

const candidatos = [];
for (const grupo of aliases) {
    for (const c of grupo.candidatos) {
        candidatos.push({ id: c.id_estudio, nombre: c.nombre, alias: grupo.terminos[0] });
    }
}
const ids = [...new Set(candidatos.map(c => c.id))].sort((a, b) => a - b);

const SQL = `
SELECT E.IdEstudio, E.Nombre, E.Clave${LISTA ? ',\n       LPE.Precio, LPE.Activo' : ''}
FROM LAB.Estudios E
${LISTA ? `LEFT JOIN LAB.ListaDePrecioEstudio LPE\n       ON LPE.IdEstudio = E.IdEstudio AND LPE.IdListaPrecio = ${LISTA}` : ''}
WHERE E.IdEstudio IN (${ids.join(', ')});`.trim();

function informar(filas) {
    const porId = new Map(filas.map(f => [Number(f.IdEstudio), f]));
    const inexistentes = [];
    const nombreDistinto = [];
    const sinPrecio = [];

    for (const c of candidatos) {
        const fila = porId.get(c.id);
        if (!fila) {
            inexistentes.push(c);
            continue;
        }
        const real = String(fila.Nombre || '').trim().toUpperCase();
        if (real !== c.nombre.trim().toUpperCase()) {
            nombreDistinto.push({ ...c, real: fila.Nombre });
        }
        if (LISTA && (fila.Precio === null || fila.Precio === undefined || fila.Activo === false || fila.Activo === 0)) {
            sinPrecio.push(c);
        }
    }

    console.log(`\nRevisados ${candidatos.length} candidatos (${ids.length} ids únicos)\n`);

    if (inexistentes.length) {
        console.log('❌ IDs QUE NO EXISTEN EN LAB.Estudios');
        console.log('   Estos alias dejan el estudio INENCONTRABLE: el alias gana, aporta el id,');
        console.log('   se descarta el LIKE del texto y la consulta no devuelve nada.\n');
        for (const c of inexistentes) console.log(`   ${c.id}  "${c.nombre}"  (alias: ${c.alias})`);
        console.log();
    } else {
        console.log('✅ Todos los ids existen en LAB.Estudios\n');
    }

    if (nombreDistinto.length) {
        console.log('⚠️  EL NOMBRE DEL ALIAS NO COINCIDE CON EL DEL CATALOGO');
        for (const c of nombreDistinto) {
            console.log(`   ${c.id}\n      alias:    "${c.nombre}"\n      catalogo: "${c.real}"`);
        }
        console.log();
    }

    if (LISTA) {
        if (sinPrecio.length) {
            console.log(`⚠️  SIN PRECIO ACTIVO EN LA LISTA ${LISTA}`);
            console.log('   Existen, pero esa sucursal no los cotiza: el paciente verá "no encontré".\n');
            for (const c of sinPrecio) console.log(`   ${c.id}  "${c.nombre}"  (alias: ${c.alias})`);
            console.log();
        } else {
            console.log(`✅ Todos tienen precio activo en la lista ${LISTA}\n`);
        }
    } else {
        console.log('ℹ️  Pasa el IdListaPrecio de una sucursal para comprobar también los precios:');
        console.log('   node test/auditar-alias.js 3\n');
    }
}

(async () => {
    let sql;
    try {
        sql = require('mssql');
    } catch (_e) {
        console.log('mssql no disponible. Ejecuta esta consulta a mano:\n');
        console.log(SQL);
        return;
    }

    let pool;
    try {
        pool = await new sql.ConnectionPool(CONFIG.DB).connect();
        const resultado = await pool.request().query(SQL);
        informar(resultado.recordset);
    } catch (error) {
        console.log(`No se pudo consultar SQL Server: ${error.message}\n`);
        console.log('Ejecuta esta consulta en SSMS y compara los ids con los del alias:\n');
        console.log(SQL);
        console.log('\nIDs que espera el alias:');
        for (const c of candidatos) console.log(`   ${c.id}  "${c.nombre}"  (alias: ${c.alias})`);
    } finally {
        if (pool) await pool.close();
    }
})();
