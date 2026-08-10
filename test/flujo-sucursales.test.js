const test = require('node:test');
const assert = require('node:assert/strict');
const FlujoSucursales = require('../src/handlers/flujoSucursales');
const GestorEstados = require('../src/services/state');
const { ESTADOS } = require('../src/config');

test('mostrarSucursalAsignada cambia el estado a SUCURSAL_DETALLES', async () => {
    const estados = new GestorEstados();
    estados.actualizar('conv-1', ESTADOS.MENU, {
        sucursalAsignada: { nombre: 'SUCURSAL VILLAHERMOSA MATRIZ', direccion: 'Av. Principal 123' }
    });

    const mockClient = {
        async enviarBotones(accountId, conversationId, text, buttons) {
            return true;
        }
    };

    const flujo = new FlujoSucursales(mockClient, null, estados, null);
    await flujo.mostrarSucursalAsignada('acc-1', 'conv-1');

    const estadoPost = estados.obtener('conv-1');
    assert.equal(estadoPost.estado, ESTADOS.SUCURSAL_DETALLES);
});

test('manejarAccionDetalles con opción 2 (Cambiar ubicación) reinicia la ubicación', async () => {
    const estados = new GestorEstados();
    estados.actualizar('conv-1', ESTADOS.SUCURSAL_DETALLES, {
        sucursalAsignada: { nombre: 'VILLAHERMOSA' }
    });

    let mensajeTextoEnviado = '';
    const mockClient = {
        async enviarTexto(accountId, conversationId, texto) {
            mensajeTextoEnviado = texto;
            return true;
        }
    };

    const flujo = new FlujoSucursales(mockClient, null, estados, null);
    await flujo.manejarAccionDetalles('acc-1', 'conv-1', '2');

    const estadoPost = estados.obtener('conv-1');
    assert.equal(estadoPost.estado, ESTADOS.ESPERANDO_UBICACION);
    assert.equal(estadoPost.datos.sucursalAsignada, null);
    assert.match(mensajeTextoEnviado, /compártenos tu ubicación o escribe tu (ciudad\/)?código postal/i);
});

test('manejarAccionDetalles con texto "Cambiar ubicación" reinicia la ubicación', async () => {
    const estados = new GestorEstados();
    estados.actualizar('conv-1', ESTADOS.SUCURSAL_DETALLES, {
        sucursalAsignada: { nombre: 'VILLAHERMOSA' }
    });

    let mensajeTextoEnviado = '';
    const mockClient = {
        async enviarTexto(accountId, conversationId, texto) {
            mensajeTextoEnviado = texto;
            return true;
        }
    };

    const flujo = new FlujoSucursales(mockClient, null, estados, null);
    await flujo.manejarAccionDetalles('acc-1', 'conv-1', 'Cambiar ubicación');

    const estadoPost = estados.obtener('conv-1');
    assert.equal(estadoPost.estado, ESTADOS.ESPERANDO_UBICACION);
    assert.equal(estadoPost.datos.sucursalAsignada, null);
    assert.match(mensajeTextoEnviado, /compártenos tu ubicación o escribe tu (ciudad\/)?código postal/i);
});
