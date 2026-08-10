const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { CONFIG } = require('../src/config');
const FlowDefinitionService = require('../src/services/flowDefinition');

test('FlowDefinitionService carga chatbot_flow.json y expone nodos por step_id', () => {
    const flow = new FlowDefinitionService(CONFIG.CHATBOT_FLOW_PATH, {
        variables: { Nombre: 'Napo' }
    });

    const inicio = flow.respuesta('1');
    const metadata = flow.metadata('4.2');

    assert.match(inicio, /Bienvenido a Laboratorios Napoles/);
    assert.match(inicio, /Napo/);
    assert.equal(metadata.stepId, '4.2');
    assert.match(metadata.validationRule, /Validar folio/i);
});

test('FlowDefinitionService permite sobrescribir la ruta del flujo', () => {
    const customPath = path.resolve(__dirname, '..', 'src', 'data', 'chatbot-flow.json');
    const flow = new FlowDefinitionService(customPath);

    assert.match(flow.fallback('4.2.1 B'), /asesor/i);
});

test('FlowDefinitionService reemplaza cadenas vacias por vacio sin mostrar llaves', () => {
    const customPath = path.resolve(__dirname, '..', 'src', 'data', 'chatbot-flow.json');
    const flow = new FlowDefinitionService(customPath);

    const res = flow.respuesta('4.1.1.3', {
        detalle: 'El precio es $100',
        avisoNoEncontrados: '',
        sucursal: 'VILLAHERMOSA',
        indicaciones: 'Ninguna.',
        tiempoEntrega: 'Mismo día'
    });

    assert.doesNotMatch(res, /\{\{/);
    assert.doesNotMatch(res, /avisoNoEncontrados/);
});
