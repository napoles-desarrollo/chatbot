const test = require('node:test');
const assert = require('node:assert/strict');

const GestorBaseDatos = require('../src/services/database');

function crearDriver(recordset) {
    const captura = { inputs: {} };

    class Request {
        input(nombre, _tipo, valor) {
            captura.inputs[nombre] = valor;
            return this;
        }

        async query(query) {
            captura.query = query;
            return { recordset };
        }
    }

    class ConnectionPool {
        async connect() {
            return this;
        }

        request() {
            return new Request();
        }

        async close() {}
    }

    return {
        captura,
        driver: {
            ConnectionPool,
            Int: 'Int',
            Date: 'Date',
            VarChar: 'VarChar',
            NVarChar: longitud => `NVarChar(${longitud})`
        }
    };
}

test('top 5 usa lista de precio, fecha parametrizada y filtro sargable', async () => {
    const { captura, driver } = crearDriver([
        { IdEstudio: 1, Estudio: 'GLUCOSA', Cantidad: 20, Precio: 90 }
    ]);
    const db = new GestorBaseDatos({}, driver);

    const resultado = await db.obtenerEstudiosMasSolicitados({
        listaPrecioId: 2,
        fechaDesde: '2026-01-01',
        limite: 5
    });

    assert.equal(resultado.length, 1);
    assert.equal(captura.inputs.listaPrecioId, 2);
    assert.equal(captura.inputs.limite, 5);
    assert.equal(captura.inputs.fechaDesde.getFullYear(), 2026);
    assert.match(captura.query, /LPE\.IdListaPrecio = @listaPrecioId/);
    assert.match(captura.query, /RE\.FechaCreacion >= @fechaDesde/);
    assert.doesNotMatch(captura.query, /CONVERT\([^)]*RE\.FechaCreacion/i);
});

test('busqueda genera parametros para ids de alias sin interpolar valores', async () => {
    const { captura, driver } = crearDriver([]);
    const db = new GestorBaseDatos({}, driver);

    await db.buscarEstudios({
        texto: 'GLUCOSA',
        listaPrecioId: 2,
        estudioIds: [1, 71]
    });

    assert.equal(captura.inputs.estudioId0, 1);
    assert.equal(captura.inputs.estudioId1, 71);
    assert.match(captura.query, /E\.IdEstudio IN \(@estudioId0, @estudioId1\)/);
    assert.doesNotMatch(captura.query, /IN \(1, 71\)/);
});

test('resultado encontrado se devuelve sin ejecutar el bloque roto de sucursales', async () => {
    const { driver } = crearDriver([
        { IdRecepcion: 10, Pendientes: 0, LinkDescarga: 'https://resultado.test/10' }
    ]);
    const db = new GestorBaseDatos({}, driver);

    const resultado = await db.obtenerLinkResultados('0265964');

    assert.deepEqual(resultado, {
        link: 'https://resultado.test/10',
        estatus: 7
    });
});
