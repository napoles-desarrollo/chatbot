const test = require('node:test');
const assert = require('node:assert');

process.env.CHATBOT_DEBUG = 'false';

const LLMClassifier = require('../src/services/llmClassifier');
const { ESTADOS } = require('../src/config');
const { normalizar } = require('../src/utils/helpers');
const GestorEstados = require('../src/services/state');
const ManejadorComandos = require('../src/handlers/commands');

// --- Ollama falso -----------------------------------------------------------

function respuestaOk(objeto) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: JSON.stringify(objeto) } })
    };
}

function fetchFalso(respuestas) {
    const llamadas = [];
    const cola = Array.isArray(respuestas) ? [...respuestas] : null;

    const impl = async (url, opciones) => {
        llamadas.push({ url, payload: JSON.parse(opciones.body) });
        const siguiente = cola ? cola.shift() : respuestas;
        if (typeof siguiente === 'function') return siguiente();
        if (siguiente instanceof Error) throw siguiente;
        return siguiente;
    };

    impl.llamadas = llamadas;
    return impl;
}

const configBase = {
    enabled: true,
    modo: 'activo',
    baseUrl: 'http://ollama-falso:11434',
    modelo: 'qwen3:8b',
    timeoutMs: 500
};

// --- El clasificador --------------------------------------------------------

test('clasifica una cotizacion y normaliza el termino coloquial', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'glucosa' }));
    const clf = new LLMClassifier(configBase, null, fetchImpl);

    const res = await clf.clasificarIntencion('cuanto sale la del azucar');

    assert.deepStrictEqual(res, { intent: 'cotizacion', query: 'glucosa' });
    assert.strictEqual(fetchImpl.llamadas[0].url, 'http://ollama-falso:11434/api/chat');
});

test('el payload lleva keep_alive, think:false, temperatura 0 y el esquema cerrado', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'asesor', query: '' }));
    const clf = new LLMClassifier({ ...configBase, keepAlive: '30m' }, null, fetchImpl);

    await clf.clasificarIntencion('quiero hablar con alguien');
    const { payload } = fetchImpl.llamadas[0];

    assert.strictEqual(payload.keep_alive, '30m', 'sin keep_alive Ollama descarga el modelo a los 5 min');
    assert.strictEqual(payload.think, false, 'el razonamiento debe ir desactivado');
    assert.strictEqual(payload.stream, false);
    assert.strictEqual(payload.options.temperature, 0);
    assert.deepStrictEqual(
        payload.format.properties.intent.enum,
        ['cotizacion', 'sucursal', 'indicaciones', 'asesor', 'desconocido']
    );
});

test('un fallo de Ollama devuelve null y NO lanza', async () => {
    const clf = new LLMClassifier(configBase, null, fetchFalso(new Error('ECONNREFUSED')));

    const res = await clf.clasificarIntencion('cuanto cuesta la biometria');

    assert.strictEqual(res, null, 'null significa: sigue con el flujo determinista');
});

test('un intent inventado fuera del catalogo se descarta', async () => {
    const clf = new LLMClassifier(
        configBase, null,
        fetchFalso(respuestaOk({ intent: 'diagnostico_medico', query: 'tengo diabetes' }))
    );

    assert.strictEqual(await clf.clasificarIntencion('mi azucar salio en 300'), null);
});

test('el circuito se abre tras 3 fallos y deja de llamar a Ollama', async () => {
    const fetchImpl = fetchFalso(new Error('ECONNREFUSED'));
    const clf = new LLMClassifier({ ...configBase, fallosParaAbrir: 3, reposoMs: 60000 }, null, fetchImpl);

    for (let i = 0; i < 3; i += 1) await clf.clasificarIntencion(`mensaje ${i}`);
    assert.strictEqual(fetchImpl.llamadas.length, 3);
    assert.strictEqual(clf.disponible(), false);

    await clf.clasificarIntencion('otro mensaje mas');
    assert.strictEqual(fetchImpl.llamadas.length, 3, 'con el circuito abierto no debe volver a llamar');
});

test('la cache evita una segunda inferencia para el mismo texto', async () => {
    const fetchImpl = fetchFalso([
        respuestaOk({ intent: 'cotizacion', query: 'biometria hematica' }),
        respuestaOk({ intent: 'desconocido', query: '' })
    ]);
    const clf = new LLMClassifier(configBase, null, fetchImpl);

    const a = await clf.clasificarIntencion('cuanto cuesta la BH');
    const b = await clf.clasificarIntencion('  Cuanto Cuesta La BH  ');

    assert.deepStrictEqual(a, b);
    assert.strictEqual(fetchImpl.llamadas.length, 1, 'la segunda debe salir de cache');
});

test('si Ollama no admite think:false, reintenta una vez sin ese campo', async () => {
    const fetchImpl = fetchFalso([
        { ok: false, status: 400, text: async () => 'unknown field "think"' },
        respuestaOk({ intent: 'sucursal', query: 'tabasco 2000' })
    ]);
    const clf = new LLMClassifier(configBase, null, fetchImpl);

    const res = await clf.clasificarIntencion('donde queda la de tabasco 2000');

    assert.deepStrictEqual(res, { intent: 'sucursal', query: 'tabasco 2000' });
    assert.strictEqual(fetchImpl.llamadas[0].payload.think, false);
    assert.strictEqual('think' in fetchImpl.llamadas[1].payload, false, 'el reintento va sin think');
});

test('deshabilitado no consulta nada', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'x' }));
    const clf = new LLMClassifier({ ...configBase, enabled: false }, null, fetchImpl);

    assert.strictEqual(await clf.clasificarIntencion('cuanto cuesta'), null);
    assert.strictEqual(fetchImpl.llamadas.length, 0);
});

// --- El orquestador ---------------------------------------------------------

const SUCURSAL = { id: 1, titulo: 'SUCURSAL GALERIAS', direccion: 'Ruiz Cortines', lista_precio: 3 };

function montarBot(clasificador) {
    const enviados = [];
    const client = {
        enviarTexto: async (_a, _c, t) => enviados.push(t),
        enviarBotones: async (_a, _c, t) => enviados.push(t),
        enviarListaDesplegable: async (_a, _c, t, _l, items = []) =>
            enviados.push(`${t}\n${items.map(i => i.title).join('\n')}`),
        enviarDocumento: async () => {},
        crearNotaPrivada: async () => {}
    };
    const estados = new GestorEstados();
    const catalogo = {
        buscarEstudios: async ({ texto }) => [{ id: 42, nombre: `ESTUDIO ${texto.toUpperCase()}`, precio: 350 }],
        cotizar: async ({ estudios, sucursal }) => ({ sucursal, items: estudios, total: 350 })
    };
    const manejador = new ManejadorComandos(
        client, { obtenerDatos: async () => ({}) }, estados, null, null, catalogo, null, clasificador
    );
    estados.actualizar('u1', ESTADOS.MENU, { sucursalAsignada: SUCURSAL });
    return { manejador, estados, enviados };
}

const enviar = (m, txt) => m.procesarMensaje('acc', 'u1', normalizar(txt), txt, [], {});

test('modo activo: una pregunta libre en el menu entra directo a cotizar', async () => {
    const clf = new LLMClassifier(
        configBase, null,
        fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'prueba de embarazo' }))
    );
    const { manejador, estados, enviados } = montarBot(clf);

    await enviar(manejador, 'quiero saber si estoy preñada cuanto sale');

    // Una sola coincidencia clara ya no pasa por la lista: se cotiza directo.
    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.COTIZACION_POST_COTIZACION);
    assert.ok(
        enviados.some(t => t.includes('PRUEBA DE EMBARAZO')),
        `esperaba el estudio buscado, salio: ${JSON.stringify(enviados)}`
    );
});

test('modo sombra: clasifica y registra, pero NO cambia el rumbo', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'prueba de embarazo' }));
    const clf = new LLMClassifier({ ...configBase, modo: 'sombra' }, null, fetchImpl);
    const { manejador, estados, enviados } = montarBot(clf);

    await enviar(manejador, 'quiero saber si estoy preñada cuanto sale');

    assert.strictEqual(fetchImpl.llamadas.length, 1, 'en sombra si consulta al modelo');
    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.MENU, 'pero no debe mover el estado');
    assert.ok(enviados.some(t => t.includes('¿En qué podemos ayudarte hoy?')));
});

test('con Ollama caido el menu sigue funcionando igual que siempre', async () => {
    const clf = new LLMClassifier(configBase, null, fetchFalso(new Error('ECONNREFUSED')));
    const { manejador, estados, enviados } = montarBot(clf);

    await enviar(manejador, 'quiero saber si estoy preñada cuanto sale');

    assert.strictEqual(estados.obtener('u1').estado, ESTADOS.MENU);
    assert.ok(enviados.some(t => t.includes('¿En qué podemos ayudarte hoy?')));
});

test('las opciones numericas del menu nunca consultan al modelo', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'x' }));
    const clf = new LLMClassifier(configBase, null, fetchImpl);
    const { manejador } = montarBot(clf);

    await enviar(manejador, '1');

    assert.strictEqual(fetchImpl.llamadas.length, 0, 'el camino rapido debe evitar la inferencia');
});

// --- Regresion: el mensaje real que fallo en produccion ----------------------
// "prueba de azucar, RX AP y lateral de columna cervical, prueba para saber si estoy embarazada"
// Los dos primeros los resuelve la tabla de alias; el tercero solo lo salva la IA.

const MENSAJE_REAL = 'prueba de azucar, RX AP y lateral de columna cervical, prueba para saber si estoy embarazada';

// Modela el sistema real: SQL + tabla de alias resuelven el termino canonico,
// pero NO una frase natural completa.
const CATALOGO_REAL = {
    'prueba de azucar': [{ id: 1, nombre: 'GLUCOSA (GLU)', precio: 80 }],
    'rx columna cervical ap': [{ id: 2, nombre: 'RX. COLUMNA CERVICAL AP (RX.CCAP)', precio: 300 }],
    'rx columna cervical lateral': [{ id: 3, nombre: 'RX. COLUMNA CERVICAL LATERAL (RX.CCLAT)', precio: 300 }],
    'prueba de embarazo': [{ id: 5580, nombre: 'PRUEBA INMUNOLOGICA DE EMBARAZO', precio: 250 }]
};

function montarCotizacion(clasificador) {
    const enviados = [];
    const client = {
        enviarTexto: async (_a, _c, t) => enviados.push(t),
        enviarBotones: async (_a, _c, t) => enviados.push(t),
        enviarListaDesplegable: async (_a, _c, t, _l, items = []) =>
            enviados.push(`${t}\n${items.map(i => i.title).join('\n')}`),
        enviarDocumento: async () => {},
        crearNotaPrivada: async () => {}
    };
    const estados = new GestorEstados();
    const catalogo = {
        buscarEstudios: async ({ texto }) => CATALOGO_REAL[normalizar(texto)] || [],
        cotizar: async ({ estudios, sucursal }) => ({ sucursal, items: estudios, total: 0 })
    };
    const manejador = new ManejadorComandos(
        client, { obtenerDatos: async () => ({}) }, estados, null, null, catalogo, null, clasificador
    );
    estados.actualizar('u1', ESTADOS.COTIZACION_BUSCAR_ESTUDIO, {
        sucursalAsignada: SUCURSAL,
        estudiosDisponibles: []
    });
    return { manejador, enviados };
}

test('regresion: sin IA, la frase natural del embarazo se queda sin precio', async () => {
    const clf = new LLMClassifier({ ...configBase, enabled: false }, null, fetchFalso(null));
    const { manejador, enviados } = montarCotizacion(clf);

    await enviar(manejador, MENSAJE_REAL);
    const cotizacion = enviados.join('\n');

    assert.ok(cotizacion.includes('GLUCOSA'), 'la glucosa si se resuelve por alias');
    assert.ok(cotizacion.includes('RX. COLUMNA CERVICAL AP'));
    assert.ok(cotizacion.includes('RX. COLUMNA CERVICAL LATERAL'));
    assert.ok(
        cotizacion.includes('No encontré precio activo'),
        'este es exactamente el fallo reportado en produccion'
    );
});

test('con IA activa, la frase natural se reescribe y sale con precio', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'prueba de embarazo' }));
    const clf = new LLMClassifier(configBase, null, fetchImpl);
    const { manejador, enviados } = montarCotizacion(clf);

    await enviar(manejador, MENSAJE_REAL);
    const cotizacion = enviados.join('\n');

    assert.ok(cotizacion.includes('PRUEBA INMUNOLOGICA DE EMBARAZO'), `salio: ${cotizacion}`);
    assert.ok(!cotizacion.includes('No encontré precio activo'), 'ya no debe quedar nada sin precio');
    assert.strictEqual(fetchImpl.llamadas.length, 1, 'solo el termino que fallo consulta al modelo');
});

test('la IA no se consulta para los terminos que el catalogo ya resuelve', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'lo que sea' }));
    const clf = new LLMClassifier(configBase, null, fetchImpl);
    const { manejador } = montarCotizacion(clf);

    await enviar(manejador, 'prueba de azucar');

    assert.strictEqual(fetchImpl.llamadas.length, 0);
});

test('modo sombra: registra el rescate pero deja el resultado intacto', async () => {
    const fetchImpl = fetchFalso(respuestaOk({ intent: 'cotizacion', query: 'prueba de embarazo' }));
    const clf = new LLMClassifier({ ...configBase, modo: 'sombra' }, null, fetchImpl);
    const { manejador, enviados } = montarCotizacion(clf);

    await enviar(manejador, MENSAJE_REAL);
    const cotizacion = enviados.join('\n');

    assert.strictEqual(fetchImpl.llamadas.length, 1, 'en sombra si consulta');
    assert.ok(cotizacion.includes('No encontré precio activo'), 'pero no cambia lo que ve el paciente');
});
