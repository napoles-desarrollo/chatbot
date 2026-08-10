// Reconstruye un diccionario de alias cuyos id_estudio son de otro catalogo.
// Los TERMINOS (vocabulario del paciente) se conservan; los IDS se vuelven a
// deducir casando el campo "nombre" de cada candidato contra LAB.Estudios.
//
//   node test/reestructurar-alias.js                 -> simulacro, no escribe nada
//   node test/reestructurar-alias.js --escribir      -> genera el archivo de salida
//
// Regla de oro: ante la duda, se descarta. Un alias equivocado no falla, cotiza
// otro estudio (el alias apaga el filtro de texto en database.js), asi que un
// candidato dudoso hace mas dano que uno ausente.

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../src/config');
const { normalizar, calcularSimilitud } = require('../src/utils/helpers');

const ESCRIBIR = process.argv.includes('--escribir');
const ORIGEN = path.join(__dirname, '..', 'src', 'data', 'aliases_estudios.json');
const ACTUAL = path.join(__dirname, '..', 'src', 'data', 'estudios-aliases.json');
const SALIDA = path.join(__dirname, '..', 'src', 'data', 'estudios-aliases.generado.json');
const REVISION = path.join(__dirname, '..', 'src', 'data', 'alias-por-revisar.json');

// El archivo origen tiene deriva entre "terminos" y "nombre": a partir de cierto punto
// cada grupo lleva el nombre del estudio contiguo. Casar por nombre no lo arregla, porque
// el nombre que trae YA es el equivocado. Lo unico defendible es separar los grupos donde
// termino y estudio comparten vocabulario (fiables) de los que no (revision humana).
const VACIAS_LEX = new Set(['de','del','la','el','los','las','anti','por','ig','igg','igm','iga',
    'total','libre','suero','sangre','orina','plasma','para','con','virus','acido','prueba']);

function tokensLexicos(texto) {
    return new Set(normalizar(texto).replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
        .filter(t => t.length >= 4 && !VACIAS_LEX.has(t)));
}

function terminoCuadraConEstudio(terminos, candidatos) {
    const delEstudio = new Set();
    for (const c of candidatos) for (const t of tokensLexicos(c.nombre)) delEstudio.add(t);
    for (const termino of terminos) {
        const t = tokensLexicos(termino);
        if (t.size === 0) return true;                    // siglas: no se puede juzgar
        for (const a of t) {
            for (const b of delEstudio) {
                if (a === b) return true;
                if (a.slice(0, 5) === b.slice(0, 5)) return true;   // mielina / mielinas
            }
        }
    }
    return false;
}

const UMBRAL_SIMILITUD = 0.94;

function normalizarAlias(texto) {
    return normalizar(texto).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

(async () => {
    const origen = JSON.parse(fs.readFileSync(ORIGEN, 'utf8'));
    const actual = JSON.parse(fs.readFileSync(ACTUAL, 'utf8'));

    const sql = require('mssql');
    const pool = await new sql.ConnectionPool(CONFIG.DB).connect();
    const { recordset } = await pool.request().query(`
        SELECT E.IdEstudio, LTRIM(RTRIM(E.Nombre)) AS Nombre,
               (SELECT COUNT(*) FROM LAB.ListaDePrecioEstudio x
                 WHERE x.IdEstudio = E.IdEstudio AND x.Activo = 1) AS EnListas
        FROM LAB.Estudios E`);
    await pool.close();

    // Un mismo nombre puede repetirse (VDRL sale 4 veces): se prefiere el que
    // este activo en mas listas de precio, que es el vigente en la practica.
    const porNombre = new Map();
    for (const fila of recordset) {
        const clave = normalizar(fila.Nombre);
        if (!clave) continue;
        const previo = porNombre.get(clave);
        if (!previo || Number(fila.EnListas) > Number(previo.EnListas)) porNombre.set(clave, fila);
    }
    const vivos = recordset.filter(f => Number(f.EnListas) > 0);

    console.log(`\nCatalogo real: ${recordset.length} estudios, ${porNombre.size} nombres unicos, ${vivos.length} con precio activo`);
    console.log(`Archivo origen: ${origen.aliases.length} grupos\n`);

    const stats = { exacto: 0, similar: 0, descartado: 0, sinPrecio: 0 };
    const dudosos = [];

    function resolverCandidato(nombre) {
        const clave = normalizar(nombre);
        const exacto = porNombre.get(clave);
        if (exacto) { stats.exacto += 1; return exacto; }

        // Sin coincidencia exacta: solo se acepta un parecido MUY alto y unico.
        let mejor = null, segundo = 0;
        for (const fila of vivos) {
            const s = calcularSimilitud(nombre, fila.Nombre);
            if (!mejor || s > mejor.s) { segundo = mejor ? mejor.s : 0; mejor = { fila, s }; }
            else if (s > segundo) segundo = s;
        }
        if (mejor && mejor.s >= UMBRAL_SIMILITUD && mejor.s - segundo >= 0.03) {
            stats.similar += 1;
            dudosos.push({ pedia: nombre, resuelto: mejor.fila.Nombre, score: mejor.s.toFixed(3) });
            return mejor.fila;
        }
        stats.descartado += 1;
        return null;
    }

    // Los terminos que ya existen en el diccionario en uso mandan: no se tocan.
    const terminosReservados = new Set();
    for (const g of actual.aliases) for (const t of g.terminos) terminosReservados.add(normalizarAlias(t));

    const gruposNuevos = [];
    const gruposDudosos = [];
    let terminosDescartados = 0;

    for (const grupo of origen.aliases) {
        const candidatos = [];
        const idsVistos = new Set();
        for (const c of grupo.candidatos) {
            const fila = resolverCandidato(c.nombre);
            if (!fila) continue;
            if (Number(fila.EnListas) === 0) { stats.sinPrecio += 1; continue; }
            if (idsVistos.has(fila.IdEstudio)) continue;
            idsVistos.add(fila.IdEstudio);
            candidatos.push({
                id_estudio: Number(fila.IdEstudio),
                nombre: fila.Nombre,
                prioridad: 100 - candidatos.length * 10
            });
        }
        if (candidatos.length === 0) continue;

        const terminos = [];
        for (const t of grupo.terminos) {
            const n = normalizarAlias(t);
            if (!n || n.length < 3) { terminosDescartados += 1; continue; }
            if (terminosReservados.has(n)) { terminosDescartados += 1; continue; }
            terminosReservados.add(n);
            terminos.push(n);
        }
        if (terminos.length === 0) continue;

        const destino = terminoCuadraConEstudio(terminos, candidatos) ? gruposNuevos : gruposDudosos;
        destino.push({
            terminos,
            requiere_confirmacion: candidatos.length > 1,
            ...(candidatos.length > 1 ? { pregunta: grupo.pregunta || 'Encontré varias opciones. ¿Cuál necesitas?' } : {}),
            candidatos
        });
    }

    console.log('Resolucion de los 654 candidatos por nombre:');
    console.log(`   coincidencia exacta ....... ${stats.exacto}`);
    console.log(`   parecido >= ${UMBRAL_SIMILITUD} y unico .. ${stats.similar}`);
    console.log(`   sin precio en ninguna lista ${stats.sinPrecio}  (descartados)`);
    console.log(`   sin coincidencia fiable ... ${stats.descartado}  (descartados)\n`);

    if (dudosos.length) {
        console.log(`Casos aceptados por parecido (revisar, ${dudosos.length}):`);
        dudosos.slice(0, 12).forEach(d =>
            console.log(`   ${d.score}  "${d.pedia.slice(0, 44)}"\n          -> "${d.resuelto.slice(0, 44)}"`));
        if (dudosos.length > 12) console.log(`   ... y ${dudosos.length - 12} mas`);
        console.log();
    }

    const total = { grupos: actual.aliases.length + gruposNuevos.length };
    console.log(`Grupos FIABLES (termino y estudio comparten vocabulario): ${gruposNuevos.length}`);
    console.log(`Grupos A REVISAR (sin relacion lexica, posible deriva):    ${gruposDudosos.length}`);
    console.log(`Descartados por no casar con el catalogo:                  ${origen.aliases.length - gruposNuevos.length - gruposDudosos.length}`);
    console.log(`Terminos descartados por duplicado o vacio: ${terminosDescartados}`);
    console.log(`Diccionario resultante: ${total.grupos} grupos, ` +
        `${[...actual.aliases, ...gruposNuevos].reduce((n, g) => n + g.terminos.length, 0)} terminos\n`);

    if (!ESCRIBIR) {
        console.log('Simulacro. Ejecuta con --escribir para generar el archivo.\n');
        return;
    }

    const resultado = { version: 2, aliases: [...actual.aliases, ...gruposNuevos] };
    fs.writeFileSync(SALIDA, JSON.stringify(resultado, null, 2) + '\n', 'utf8');
    fs.writeFileSync(REVISION, JSON.stringify({ version: 2, aliases: gruposDudosos }, null, 2) + '\n', 'utf8');
    console.log(`Escrito (revision humana): ${REVISION}`);
    console.log(`Escrito: ${SALIDA}`);
    console.log('Validalo antes de sustituir el que esta en uso:');
    console.log(`   node test/validar-diccionario.js 2 ${path.relative(process.cwd(), SALIDA)}\n`);
})();
