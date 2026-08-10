const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ESTADOS, ENV_PATH } = require('../src/config');
const { normalizar } = require('../src/utils/helpers');
const GestorEstados = require('../src/services/state');
const CatalogoService = require('../src/services/catalogo');
const SucursalesService = require('../src/services/sucursales');
const GeoService = require('../src/services/geo');
const ManejadorComandos = require('../src/handlers/commands');
const FlujoSucursales = require('../src/handlers/flujoSucursales');
const FlowDefinitionService = require('../src/services/flowDefinition');

class ClientePrueba {
    constructor() {
        this.eventos = [];
    }

    async enviarTexto(_aid, _cid, texto) {
        this.eventos.push({ tipo: 'texto', texto });
    }

    async enviarListaDesplegable(_aid, _cid, texto, label, items) {
        this.eventos.push({ tipo: 'lista', texto, label, items });
    }

    async enviarBotones(_aid, _cid, texto, items) {
        this.eventos.push({ tipo: 'botones', texto, items });
    }

    async crearNotaPrivada(_aid, _cid, texto) {
        this.eventos.push({ tipo: 'nota', texto });
    }
}

test('la ruta de .env no depende del directorio de ejecucion', () => {
    assert.equal(ENV_PATH, path.resolve(__dirname, '..', '.env'));
});

test('conversacion nueva muestra bienvenida antes de validar ubicacion', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const flow = new FlowDefinitionService(path.resolve(__dirname, '..', 'src', 'data', 'chatbot-flow.json'), {
        variables: { Nombre: 'Napo' }
    });
    const manejador = new ManejadorComandos(cliente, {}, estados, {}, {}, {}, flow);
    const cid = 'chat-nuevo-saludo';

    await manejador.procesarMensaje('cuenta', cid, 'hola', 'hola');

    assert.equal(estados.obtener(cid).estado, ESTADOS.ESPERANDO_UBICACION);
    assert.equal(cliente.eventos.at(-1).tipo, 'texto');
    assert.match(cliente.eventos.at(-1).texto, /Bienvenido a Laboratorios Napoles/);
    assert.doesNotMatch(cliente.eventos.at(-1).texto, /No pudimos identificar/);
});

test('conversacion nueva con CP procesa ubicacion y llega a menu', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const flow = new FlowDefinitionService(path.resolve(__dirname, '..', 'src', 'data', 'chatbot-flow.json'), {
        variables: { Nombre: 'Napo' }
    });
    const sucursalesCercanas = [
        { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', direccion: 'Direccion 1', lista_precio: 2, distanciaKm: 0.1 },
        { id: 2, titulo: 'SUCURSAL VILLA JALUPA', direccion: 'Direccion 2', lista_precio: 34, distanciaKm: 20 },
        { id: 3, titulo: 'SUCURSAL NACAJUCA LABORATORIO', direccion: 'Direccion 3', lista_precio: 47, distanciaKm: 23 }
    ];
    const cache = {
        async obtenerDatos() {
            return {};
        },
        obtenerEstados() {
            return [];
        },
        buscarMunicipio() {
            return null;
        }
    };
    const geo = {
        resolverCp(cp) {
            return { cp, latitud: 17.97, longitud: -92.95 };
        },
        sucursalesCercanas() {
            return sucursalesCercanas;
        }
    };
    const manejador = new ManejadorComandos(cliente, cache, estados, {}, geo, {}, flow);
    const cid = 'chat-cp-directo';

    await manejador.procesarMensaje('cuenta', cid, '86150', '86150');

    assert.equal(estados.obtener(cid).estado, ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA);
    assert.equal(cliente.eventos[0].tipo, 'texto');
    assert.match(cliente.eventos[0].texto, /Bienvenido a Laboratorios Napoles/);
    assert.equal(cliente.eventos.at(-1).tipo, 'lista');
    assert.match(cliente.eventos.at(-1).texto, /C\.?P\.?\s*86150/);

    await manejador.procesarMensaje('cuenta', cid, '1', '1');

    assert.equal(estados.obtener(cid).estado, ESTADOS.MENU);
    assert.equal(estados.obtener(cid).datos.sucursalAsignada.id, 1);
    assert.equal(cliente.eventos.at(-1).tipo, 'lista');
    assert.ok(cliente.eventos.at(-1).items.some(item => item.value === '1'));
});

test('CatalogoService resuelve azucar a GLUCOSA antes de consultar SQL', async () => {
    let parametros;
    const db = {
        async buscarEstudios(entrada) {
            parametros = entrada;
            return [{ IdEstudio: 1, Estudio: 'GLUCOSA', Precio: 90 }];
        }
    };
    const catalogo = new CatalogoService(null, undefined, db);

    const resultados = await catalogo.buscarEstudios({
        texto: 'quiero checarme el azucar',
        tipoServicio: 'laboratorio',
        sucursal: { lista_precio: 2 }
    });

    assert.equal(parametros.texto, 'GLUCOSA');
    assert.deepEqual(parametros.estudioIds, [1]);
    assert.equal(parametros.listaPrecioId, 2);
    assert.equal(resultados[0].precio, 90);
});

test('CatalogoService ofrece los 3 paneles de ITS y no filtra por el texto del usuario', async () => {
    let parametros;
    const db = {
        async buscarEstudios(entrada) {
            parametros = entrada;
            // El SQL descarta el LIKE cuando llegan ids de alias (database.js:124),
            // por eso "ETS" puede devolver estudios cuyo nombre no contiene "ETS".
            return [
                { IdEstudio: 4900, Estudio: 'PANEL DE PCR INFECCIOSO DE TRANSMISION SEXUAL BASICO', Precio: 1500 },
                { IdEstudio: 5408, Estudio: 'PANEL DE PCR INFECCIOSO DE TRANSMISION SEXUAL COMPLETO', Precio: 2500 },
                { IdEstudio: 5409, Estudio: 'PANEL DE PCR INFECCIOSO DE TRANSMISION SEXUAL 2', Precio: 2000 }
            ];
        }
    };
    const catalogo = new CatalogoService(null, undefined, db);

    const resultados = await catalogo.buscarEstudios({
        texto: 'Perfil de ITS',
        tipoServicio: 'laboratorio',
        sucursal: { lista_precio: 2 }
    });

    assert.deepEqual(parametros.estudioIds, [4900, 5408, 5409]);
    assert.equal(resultados.length, 3, 'son ambiguos: el paciente debe elegir, no el bot');
});

test('sucursal convierte lista_precio numerica y descarta un logo como mapa movil', () => {
    const servicio = new SucursalesService('https://example.test/sucursales.json', 1000);
    const sucursal = servicio.homologarSucursal({
        id: 1,
        titulo: 'SUCURSAL VILLAHERMOSA',
        latitud: 17.970675435081063,
        longitud: -92.95695791280816,
        lista_precio: '2',
        mapa_movil: 'https://cdn.example.test/logo-vertical.png'
    }, 'Tabasco', 'Centro', 0);

    assert.equal(sucursal.lista_precio, 2);
    assert.match(sucursal.mapa_movil, /^https:\/\/www\.google\.com\/maps\/dir\//);
});

test('GeoService usa el shapefile empaquetado si la ruta configurada no existe', () => {
    const geo = new GeoService('C:\\Users\\Kevin Gabriel\\Documents\\CP_Tab\\CP_Tab');
    const resultado = geo.resolverCp('86099');

    assert.equal(resultado.cp, '86099');
    assert.equal(typeof resultado.latitud, 'number');
    assert.equal(typeof resultado.longitud, 'number');
});

test('GeoService acepta una carpeta como base de shapefile', () => {
    const carpeta = path.resolve(__dirname, '..', 'src', 'utils', 'CP_Tab');
    const geo = new GeoService(carpeta);
    const resultado = geo.resolverCp('86099');

    assert.equal(resultado.cp, '86099');
});

test('cotizacion refresca una sucursal antigua que no tenia lista de precios', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const cache = {
        async actualizarSucursal() {
            return { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', lista_precio: 2 };
        }
    };
    const manejador = new ManejadorComandos(cliente, cache, estados, {}, {}, {});
    const cid = 'chat-cache-antigua';
    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', lista_precio: null }
    });

    await manejador.procesarMensaje('cuenta', cid, '1', '1');

    assert.equal(estados.obtener(cid).estado, ESTADOS.COTIZACION_FORMA_BUSQUEDA);
    assert.equal(estados.obtener(cid).datos.sucursalAsignada.lista_precio, 2);
});

test('la opcion 2 dentro de cotizacion muestra top 5 y permite cotizar', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const catalogo = {
        async obtenerMasSolicitados() {
            return [
                { id: 230, nombre: 'BIOMETRIA HEMATICA COMPLETA', precio: 120, cantidad: 50 },
                { id: 1, nombre: 'GLUCOSA', precio: 90, cantidad: 45 }
            ];
        },
        async cotizar({ estudios, sucursal }) {
            return {
                sucursal,
                items: estudios,
                total: estudios[0].precio,
                moneda: 'MXN'
            };
        }
    };
    const manejador = new ManejadorComandos(
        cliente,
        {},
        estados,
        {},
        {},
        catalogo
    );
    const cid = 'chat-top5';
    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: {
            titulo: 'SUCURSAL VILLAHERMOSA',
            lista_precio: 2
        }
    });

    await manejador.procesarMensaje('cuenta', cid, '1', '1');
    assert.equal(estados.obtener(cid).estado, ESTADOS.COTIZACION_FORMA_BUSQUEDA);

    await manejador.procesarMensaje('cuenta', cid, '2', '2');
    assert.equal(estados.obtener(cid).estado, ESTADOS.COTIZACION_CONFIRMAR_ESTUDIOS);
    const listaTop = cliente.eventos.at(-1);
    assert.equal(listaTop.tipo, 'lista');
    assert.equal(listaTop.items[0].value, 'estudio:230');

    await manejador.procesarMensaje(
        'cuenta',
        cid,
        normalizar(listaTop.items[0].value),
        listaTop.items[0].value
    );
    assert.equal(estados.obtener(cid).estado, ESTADOS.COTIZACION_POST_COTIZACION);
    assert.ok(cliente.eventos.some(evento => evento.texto?.includes('$120.00 pesos')));
});

test('cotizacion permite seleccionar varios estudios de la lista', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const catalogo = {
        async obtenerMasSolicitados() {
            return [
                { id: 230, nombre: 'BIOMETRIA HEMATICA COMPLETA', precio: 120, cantidad: 50 },
                { id: 1, nombre: 'GLUCOSA', precio: 90, cantidad: 45 },
                { id: 300, nombre: 'EXAMEN GENERAL DE ORINA', precio: 80, cantidad: 30 }
            ];
        },
        async cotizar({ estudios, sucursal }) {
            assert.deepEqual(estudios.map(estudio => estudio.id), [230, 1]);
            return {
                sucursal,
                items: estudios,
                total: estudios.reduce((total, estudio) => total + estudio.precio, 0),
                moneda: 'MXN'
            };
        }
    };
    const manejador = new ManejadorComandos(cliente, {}, estados, {}, {}, catalogo);
    const cid = 'chat-cotizacion-multiple-lista';
    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: {
            titulo: 'SUCURSAL VILLAHERMOSA',
            lista_precio: 2
        }
    });

    await manejador.procesarMensaje('cuenta', cid, '1', '1');
    await manejador.procesarMensaje('cuenta', cid, '2', '2');
    await manejador.procesarMensaje('cuenta', cid, '1 2', '1, 2');

    assert.equal(estados.obtener(cid).estado, ESTADOS.COTIZACION_POST_COTIZACION);
    const textoCotizacion = cliente.eventos.find(evento => evento.tipo === 'texto' && evento.texto.includes('COTIZACIÓN')).texto;
    assert.match(textoCotizacion, /BIOMETRIA HEMATICA COMPLETA/);
    assert.match(textoCotizacion, /GLUCOSA/);
});

test('cotizacion busca y cotiza varios estudios escritos en un mensaje', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const busquedas = [];
    const catalogo = {
        async buscarEstudios({ texto }) {
            busquedas.push(texto);
            if (normalizar(texto).includes('bh')) {
                return [{ id: 230, nombre: 'BIOMETRIA HEMATICA COMPLETA', precio: 120 }];
            }
            if (normalizar(texto).includes('glucosa')) {
                return [{ id: 1, nombre: 'GLUCOSA', precio: 90 }];
            }
            return [];
        },
        async cotizar({ estudios, sucursal }) {
            return {
                sucursal,
                items: estudios,
                total: estudios.reduce((total, estudio) => total + estudio.precio, 0),
                moneda: 'MXN'
            };
        }
    };
    const manejador = new ManejadorComandos(cliente, {}, estados, {}, {}, catalogo);
    const cid = 'chat-cotizacion-multiple-texto';
    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: {
            titulo: 'SUCURSAL VILLAHERMOSA',
            lista_precio: 2
        }
    });

    await manejador.procesarMensaje('cuenta', cid, '1', '1');
    await manejador.procesarMensaje('cuenta', cid, 'buscar', 'Buscar por nombre');
    await manejador.procesarMensaje('cuenta', cid, normalizar('BH, GLUCOSA'), 'BH, GLUCOSA');

    assert.deepEqual(busquedas, ['BH', 'GLUCOSA']);
    assert.equal(estados.obtener(cid).estado, ESTADOS.COTIZACION_POST_COTIZACION);
    const textoCotizacion = cliente.eventos.find(evento => evento.tipo === 'texto' && evento.texto.includes('COTIZACIÓN')).texto;
    assert.match(textoCotizacion, /BIOMETRIA HEMATICA COMPLETA/);
    assert.match(textoCotizacion, /GLUCOSA/);
});

test('comando natural de direccion busca municipio mencionado en el texto', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const cache = {
        async obtenerDatos() {
            return {
                Tabasco: {
                    Centla: [
                        {
                            id: 12,
                            titulo: 'SUCURSAL FRONTERA',
                            direccion: 'Calle Principal, Frontera, Centla.',
                            horario_general: 'Lunes a Viernes',
                            mapa_movil: 'https://www.google.com/maps/dir/?api=1&destination=18,-92'
                        }
                    ]
                }
            };
        }
    };
    const manejador = new ManejadorComandos(cliente, cache, estados, {}, {}, {});
    const cid = 'chat-direccion-centla';
    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: {
            titulo: 'SUCURSAL VILLAHERMOSA',
            lista_precio: 2
        }
    });

    await manejador.procesarMensaje(
        'cuenta',
        cid,
        normalizar('dame la direccion de la que esta en centla'),
        'dame la direccion de la que esta en centla'
    );

    assert.equal(cliente.eventos.at(-1).tipo, 'botones');
    assert.match(cliente.eventos.at(-1).texto, /Frontera, Centla/);
});

test('seleccion de sucursal cercana respeta la tercera opcion numerica', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const flujo = new FlujoSucursales(cliente, {}, estados, {});
    const cid = 'chat-sucursal-tercera';
    const sucursalesCercanas = [
        { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', direccion: 'Direccion 1' },
        { id: 2, titulo: 'SUCURSAL VILLA JALUPA', direccion: 'Direccion 2' },
        { id: 3, titulo: 'SUCURSAL NACAJUCA LABORATORIO', direccion: 'Direccion 3' }
    ];

    estados.actualizar(cid, ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA, {
        sucursalesCercanas,
        origenUbicacion: { cp: '86150' }
    });

    await flujo.manejarSeleccionSucursalCercana('cuenta', cid, '3');

    const estadoFinal = estados.obtener(cid);
    assert.equal(estadoFinal.estado, ESTADOS.MENU);
    assert.equal(estadoFinal.datos.sucursalAsignada.id, 3);
});

test('seleccion de sucursal cercana acepta nombre parcial de audio', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const flujo = new FlujoSucursales(cliente, {}, estados, {});
    const cid = 'chat-sucursal-audio';

    estados.actualizar(cid, ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA, {
        sucursalesCercanas: [
            { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', direccion: 'Direccion 1' },
            { id: 2, titulo: 'SUCURSAL VILLA JALUPA', direccion: 'Direccion 2' },
            { id: 3, titulo: 'SUCURSAL NACAJUCA LABORATORIO', direccion: 'Direccion 3' }
        ],
        origenUbicacion: { cp: '86150' }
    });

    await flujo.manejarSeleccionSucursalCercana('cuenta', cid, 'BJR Mosa');

    const estadoFinal = estados.obtener(cid);
    assert.equal(estadoFinal.estado, ESTADOS.MENU);
    assert.equal(estadoFinal.datos.sucursalAsignada.id, 1);
});

test('orquestador no toma 4 como asesor dentro de sucursales cercanas', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const manejador = new ManejadorComandos(cliente, {}, estados, {}, {}, {});
    const cid = 'chat-sucursal-editar';

    estados.actualizar(cid, ESTADOS.SELECCIONANDO_SUCURSAL_CERCANA, {
        sucursalesCercanas: [
            { id: 1, titulo: 'SUCURSAL VILLAHERMOSA', direccion: 'Direccion 1' },
            { id: 2, titulo: 'SUCURSAL VILLA JALUPA', direccion: 'Direccion 2' },
            { id: 3, titulo: 'SUCURSAL NACAJUCA LABORATORIO', direccion: 'Direccion 3' }
        ],
        origenUbicacion: { cp: '86150' }
    });

    await manejador.procesarMensaje('cuenta', cid, '4', '4');

    assert.equal(estados.obtener(cid).estado, ESTADOS.ESPERANDO_UBICACION);
    assert.equal(cliente.eventos.at(-1).tipo, 'texto');
});

test('opcion resultados inicia metodo de busqueda definido en chatbot_flow', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const flow = new FlowDefinitionService(path.resolve(__dirname, '..', 'src', 'data', 'chatbot-flow.json'));
    const manejador = new ManejadorComandos(cliente, {}, estados, {}, {}, {}, flow);
    const cid = 'chat-resultados-flow';

    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: {
            titulo: 'SUCURSAL VILLAHERMOSA',
            lista_precio: 2
        }
    });

    await manejador.procesarMensaje('cuenta', cid, '2', '2');

    assert.equal(estados.obtener(cid).estado, ESTADOS.RESULTADOS_ESPERANDO_DATO);
    assert.match(cliente.eventos.at(-1).texto, /Por favor comparte foto de tu recibo o número de folio/);
});

test('flujo resultados usa datos reales y no el ejemplo hardcodeado del JSON', async () => {
    const cliente = new ClientePrueba();
    const estados = new GestorEstados();
    const flow = new FlowDefinitionService(path.resolve(__dirname, '..', 'src', 'data', 'chatbot-flow.json'));
    const db = {
        async obtenerLinkResultados(folio) {
            assert.equal(folio, '0265964');
            return {
                link: 'https://resultado.test/0265964',
                estatus: 7
            };
        }
    };
    const manejador = new ManejadorComandos(cliente, {}, estados, db, {}, {}, flow);
    const cid = 'chat-resultados-disponibles';

    estados.actualizar(cid, ESTADOS.MENU, {
        sucursalAsignada: {
            titulo: 'SUCURSAL VILLAHERMOSA',
            lista_precio: 2
        }
    });

    await manejador.procesarMensaje('cuenta', cid, '2', '2');
    await manejador.procesarMensaje('cuenta', cid, '0265964', '0265964');

    assert.equal(estados.obtener(cid).estado, ESTADOS.RESULTADOS_ACCION);
    assert.match(cliente.eventos.at(-1).texto, /0265964/);
    assert.doesNotMatch(cliente.eventos.at(-1).texto, /Adri/);
    assert.doesNotMatch(cliente.eventos.at(-1).texto, /0163538/);

    await manejador.procesarMensaje('cuenta', cid, '1', '1');

    assert.match(cliente.eventos.at(-2).texto, /https:\/\/resultado\.test\/0265964/);
    assert.match(cliente.eventos.at(-1).texto, /Consultar otro resultado/);
});

test('extraerTerminosBusqueda respeta AP y lateral en estudios de radiografía', async () => {
    const FlujoCotizacion = require('../src/handlers/flujoCotizacion');
    const flujo = new FlujoCotizacion();

    const terminos = flujo.extraerTerminosBusqueda('RX AP y lateral de columna cervical');
    assert.deepEqual(terminos, ['rx columna cervical AP', 'rx columna cervical lateral']);
});
