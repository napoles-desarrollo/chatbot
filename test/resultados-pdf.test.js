const test = require('node:test');
const assert = require('node:assert/strict');
const FlujoResultados = require('../src/handlers/flujoResultados');

test('FlujoResultados envía documento PDF si el cliente lo soporta', async () => {
    let documentoEnviado = null;

    const mockClient = {
        async enviarDocumento(accountId, conversationId, opciones) {
            documentoEnviado = opciones;
            return true;
        },
        async enviarTexto() {
            throw new Error('No debería llamar a enviarTexto si enviarDocumento fue exitoso');
        }
    };

    const mockEstados = { actualizar() {} };
    const flujo = new FlujoResultados(mockClient, mockEstados, null);

    const resultado = {
        folio: '0163538',
        disponible: true,
        link: 'https://www.sisclin.mx:8087/Resultados/CreaPDFResultadoMembreteDescarga2?_IdRecepcion=10'
    };

    await flujo.enviarPdfResultado('acc', 'conv', resultado);

    assert.ok(documentoEnviado);
    assert.equal(documentoEnviado.url, resultado.link);
    assert.equal(documentoEnviado.filename, 'Resultado_Folio_0163538.pdf');
});

test('FlujoResultados hace fallback a enviarTexto si enviarDocumento falla', async () => {
    let textoEnviado = null;

    const mockClient = {
        async enviarDocumento() {
            throw new Error('Falla simulada de red al descargar PDF');
        },
        async enviarTexto(accountId, conversationId, texto) {
            textoEnviado = texto;
            return true;
        }
    };

    const mockEstados = { actualizar() {} };
    const flujo = new FlujoResultados(mockClient, mockEstados, null);

    const resultado = {
        folio: '0163538',
        disponible: true,
        link: 'https://www.sisclin.mx:8087/Resultados/CreaPDFResultadoMembreteDescarga2?_IdRecepcion=10'
    };

    await flujo.enviarPdfResultado('acc', 'conv', resultado);

    assert.ok(textoEnviado);
    assert.match(textoEnviado, /Descargar resultados: https:\/\/www\.sisclin\.mx:8087/);
});
