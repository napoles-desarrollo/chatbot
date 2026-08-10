const test = require('node:test');
const assert = require('node:assert');

process.env.CHATBOT_DEBUG = 'false';

const { ESTADOS } = require('../src/config');
const { normalizar } = require('../src/utils/helpers');
const GestorEstados = require('../src/services/state');
const ManejadorComandos = require('../src/handlers/commands');
const LLMClassifier = require('../src/services/llmClassifier');

const SUCURSAL = { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', direccion: 'Av. Ruiz Cortines', lista_precio: 3 };

// Clasificador apagado: estas pruebas son del flujo determinista, sin IA de por medio.
const sinIa = () => new LLMClassifier({ enabled: false });

function montar() {
    const enviados = [];
    const client = {
        enviarTexto: async (_a, _c, t) => enviados.push(t),
        enviarBotones: async (_a, _c, t) => enviados.push(t),
        enviarListaDesplegable: async (_a, _c, t) => enviados.push(t),
        enviarDocumento: async () => {},
        crearNotaPrivada: async (_a, _c, t) => enviados.push(`[NOTA] ${t}`)
    };
    const estados = new GestorEstados();
    const catalogo = {
        // El catalogo real no tiene "ETS" ni "Perfil de ITS" con ese nombre.
        buscarEstudios: async () => [],
        cotizar: async () => null
    };
    const manejador = new ManejadorComandos(
        client, { obtenerDatos: async () => ({}) }, estados, null, null, catalogo, null, sinIa()
    );
    estados.actualizar('u1', ESTADOS.COTIZACION_BUSCAR_ESTUDIO, {
        sucursalAsignada: SUCURSAL,
        estudiosDisponibles: []
    });
    return { manejador, estados, enviados };
}

const enviar = (m, txt) => m.procesarMensaje('acc', 'u1', normalizar(txt), txt, [], {});

test('"Inicio." con punto final vuelve al inicio', async () => {
    const { manejador, estados } = montar();

    await enviar(manejador, 'Inicio.');

    assert.strictEqual(
        estados.obtener('u1').estado,
        ESTADOS.ESPERANDO_UBICACION,
        'un punto final no debe inutilizar la salida de emergencia'
    );
});

test('"menu!" y "Volver." tambien son comandos globales', async () => {
    for (const texto of ['menu!', 'Volver.', '  INICIO  ']) {
        const { manejador, estados } = montar();
        await enviar(manejador, texto);
        assert.notStrictEqual(
            estados.obtener('u1').estado,
            ESTADOS.COTIZACION_BUSCAR_ESTUDIO,
            `"${texto}" deberia sacar al usuario del flujo de busqueda`
        );
    }
});

test('el primer termino no encontrado ofrece salidas, sin prometer un asesor', async () => {
    const { manejador, estados, enviados } = montar();

    await enviar(manejador, 'ETS');

    const respuesta = enviados.join('\n');
    assert.ok(respuesta.includes('asesor'), 'debe decir como pedir ayuda humana');
    assert.ok(respuesta.includes('menu'), 'y como salir');
    assert.ok(
        !respuesta.includes('Te canalizaremos'),
        'no debe prometer una transferencia que no va a ocurrir'
    );
    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.COTIZACION_BUSCAR_ESTUDIO);
});

test('al segundo fallo, en horario de atencion, canaliza de verdad', async () => {
    const { manejador, estados, enviados } = montar();
    manejador.esHorarioAtencion = () => true;

    await enviar(manejador, 'ETS');
    enviados.length = 0;
    await enviar(manejador, 'Perfil de ITS');

    const respuesta = enviados.join('\n');
    assert.ok(respuesta.includes('Te canalizaremos'), 'ahora si aparece el texto de 4.1.1.1');
    assert.ok(respuesta.includes('[NOTA]'), 'y se abre la nota privada para el asesor');
    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.AGENTE);
});

test('al segundo fallo, fuera de horario, NO promete un asesor que no existe', async () => {
    const { manejador, estados, enviados } = montar();
    manejador.esHorarioAtencion = () => false;

    await enviar(manejador, 'ETS');
    enviados.length = 0;
    await enviar(manejador, 'Perfil de ITS');

    const respuesta = enviados.join('\n');
    assert.ok(
        !respuesta.includes('Te canalizaremos'),
        'prometer y retractarse en dos burbujas seguidas se ve mal'
    );
    assert.ok(respuesta.includes('Horario de atención'), 'debe explicar cuando volver');
    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.MENU, 'y dejarlo en el menu, no en el bucle');
});

test('regresion del bucle de las capturas: JAJAJA y un emoji ya no repiten el mismo error', async () => {
    const { manejador, estados, enviados } = montar();

    await enviar(manejador, 'ETS');
    await enviar(manejador, 'JAJAJA.');
    enviados.length = 0;
    await enviar(manejador, '🥹');

    const repeticiones = enviados.filter(t => t.includes('Te canalizaremos')).length;
    assert.ok(repeticiones <= 1, `el mensaje se repitio ${repeticiones} veces`);
    assert.notStrictEqual(estados.obtener('u1').estado, ESTADOS.COTIZACION_BUSCAR_ESTUDIO);
});

test('un acierto reinicia el contador de intentos fallidos', async () => {
    const { manejador, estados } = montar();
    manejador.flujoCotizacion.catalogo = {
        buscarEstudios: async ({ texto }) =>
            normalizar(texto).includes('glucosa') ? [{ id: 1, nombre: 'GLUCOSA (GLU)', precio: 80 }] : [],
        cotizar: async () => null
    };

    await enviar(manejador, 'ETS');
    assert.strictEqual(estados.obtener('u1').datos.intentosBusqueda, 1);

    await enviar(manejador, 'glucosa');
    assert.strictEqual(
        estados.obtener('u1').datos.intentosBusqueda,
        0,
        'tras encontrar algo, el usuario no debe arrastrar el fallo anterior'
    );
});
