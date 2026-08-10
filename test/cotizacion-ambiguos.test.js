const test = require('node:test');
const assert = require('node:assert');

process.env.CHATBOT_DEBUG = 'false';

const { ESTADOS } = require('../src/config');
const { normalizar } = require('../src/utils/helpers');
const GestorEstados = require('../src/services/state');
const ManejadorComandos = require('../src/handlers/commands');
const LLMClassifier = require('../src/services/llmClassifier');

const SUCURSAL = { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', lista_precio: 2 };

// "quimica sanguinea" son 4 estudios distintos con precios distintos: es ambiguo.
// "bh" es uno solo: es inequivoco. "perfil tiroideo" tambien es ambiguo.
const CATALOGO = {
    'bh': [{ id: 230, nombre: 'BIOMETRIA HEMATICA COMPLETA', precio: 150 }],
    'quimica sanguinea': [
        { id: 142, nombre: 'QUIMICA SANGUINEA (12 ELEMENTOS)', precio: 500 },
        { id: 139, nombre: 'QUIMICA SANGUINEA (3 ELEMENTOS)', precio: 190 },
        { id: 141, nombre: 'QUIMICA SANGUINEA (6 ELEMENTOS)', precio: 350 },
        { id: 140, nombre: 'QUIMICA SANGUINEA (4 ELEMENTOS)', precio: 230 }
    ],
    'perfil tiroideo': [
        { id: 145, nombre: 'PERFIL TIROIDEO', precio: 700 },
        { id: 146, nombre: 'PERFIL TIROIDEO 2', precio: 900 }
    ]
};

function montar() {
    const enviados = [];
    const listas = [];
    const client = {
        enviarTexto: async (_a, _c, t) => enviados.push(t),
        enviarBotones: async (_a, _c, t) => enviados.push(t),
        enviarListaDesplegable: async (_a, _c, t, _l, items = []) => {
            enviados.push(t);
            listas.push({ texto: t, items });
        },
        enviarDocumento: async () => {},
        crearNotaPrivada: async () => {}
    };
    const estados = new GestorEstados();
    const catalogo = {
        buscarEstudios: async ({ texto }) => CATALOGO[normalizar(texto)] || [],
        cotizar: async ({ estudios, sucursal }) => ({ sucursal, items: estudios, total: 0 }),
        // El diccionario define la pregunta para el termino ambiguo.
        resolverAlias: texto => normalizar(texto) === 'quimica sanguinea'
            ? { pregunta: '¿De cuántos elementos necesitas la química sanguínea?', candidatos: [] }
            : null
    };
    const manejador = new ManejadorComandos(
        client, { obtenerDatos: async () => ({}) }, estados, null, null, catalogo, null,
        new LLMClassifier({ enabled: false })
    );
    estados.actualizar('u1', ESTADOS.COTIZACION_BUSCAR_ESTUDIO, {
        sucursalAsignada: SUCURSAL, estudiosDisponibles: []
    });
    return { manejador, estados, enviados, listas };
}

const enviar = (m, txt) => m.procesarMensaje('acc', 'u1', normalizar(txt), txt, [], {});

test('un termino ambiguo se pregunta en vez de elegir por el paciente', async () => {
    const { manejador, estados, listas } = montar();

    await enviar(manejador, 'bh, quimica sanguinea');

    assert.strictEqual(listas.length, 1, 'debe preguntar, no cotizar de golpe');
    assert.match(listas[0].texto, /cuántos elementos/i, 'usa la pregunta del diccionario');
    assert.match(listas[0].texto, /Ya tengo: BIOMETRIA HEMATICA COMPLETA/,
        'confirma lo que ya resolvio para no perder al paciente');
    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.COTIZACION_CONFIRMAR_ESTUDIOS);
});

test('las opciones se ordenan por precio, de menor a mayor', async () => {
    const { manejador, listas } = montar();

    await enviar(manejador, 'bh, quimica sanguinea');

    const precios = listas[0].items.map(i => Number(String(i.title).match(/\$([\d.]+)/)[1]));
    assert.deepStrictEqual(
        precios, [...precios].sort((a, b) => a - b),
        'ordenar alfabeticamente pone "(32 ELEMENTOS)" antes que "(4 ELEMENTOS)"'
    );
});

test('lo elegido se cotiza JUNTO con lo que ya se habia resuelto', async () => {
    const { manejador, enviados } = montar();

    await enviar(manejador, 'bh, quimica sanguinea');
    await enviar(manejador, '2');   // la segunda mas barata: 4 ELEMENTOS $230

    const cotizacion = enviados.find(t => t.includes('COTIZACIÓN'));
    assert.ok(cotizacion, 'debe salir una cotizacion');
    assert.match(cotizacion, /BIOMETRIA HEMATICA COMPLETA/, 'no se puede perder lo ya resuelto');
    assert.match(cotizacion, /QUIMICA SANGUINEA \(4 ELEMENTOS\)/);
    assert.strictEqual(
        enviados.filter(t => t.includes('COTIZACIÓN')).length, 1,
        'una sola cotizacion, no una por estudio'
    );
});

test('dos terminos ambiguos se preguntan en cadena y acaban en una cotizacion', async () => {
    const { manejador, enviados, listas } = montar();

    await enviar(manejador, 'quimica sanguinea, perfil tiroideo');
    assert.strictEqual(listas.length, 1, 'primero pregunta por uno');

    await enviar(manejador, '1');
    assert.strictEqual(listas.length, 2, 'luego por el otro');

    await enviar(manejador, '1');
    const cotizacion = enviados.find(t => t.includes('COTIZACIÓN'));
    assert.match(cotizacion, /QUIMICA SANGUINEA \(3 ELEMENTOS\)/);
    assert.match(cotizacion, /PERFIL TIROIDEO/);
});

test('si nada es ambiguo no se pregunta nada', async () => {
    const { manejador, enviados, listas } = montar();

    await enviar(manejador, 'bh');

    assert.ok(enviados.some(t => t.includes('COTIZACIÓN')), 'cotiza directo');
    assert.strictEqual(
        listas.filter(l => /cuántos elementos/i.test(l.texto)).length, 0,
        'no debe molestar al paciente con preguntas innecesarias'
    );
});
