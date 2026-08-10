const fs = require('fs');
const path = require('path');

const CAMPOS_REQUERIDOS = [
    'step_id',
    'objective',
    'user_action',
    'bot_response',
    'validation_rule',
    'required_data',
    'next_step',
    'fallback'
];

class FlowDefinitionService {
    constructor(flowPath, opciones = {}) {
        this.flowPath = path.resolve(flowPath);
        this.variables = opciones.variables || {};
        this.nodos = this.cargar();
    }

    cargar() {
        const raw = fs.readFileSync(this.flowPath, 'utf8');
        const data = JSON.parse(raw);

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('chatbot_flow.json debe ser un objeto de nodos por step_id');
        }

        for (const [id, nodo] of Object.entries(data)) {
            this.validarNodo(id, nodo);
        }

        return data;
    }

    validarNodo(id, nodo) {
        if (!nodo || typeof nodo !== 'object' || Array.isArray(nodo)) {
            throw new Error(`Nodo de flujo invalido: ${id}`);
        }

        const faltantes = CAMPOS_REQUERIDOS.filter(campo => !(campo in nodo));
        if (faltantes.length > 0) {
            throw new Error(`Nodo ${id} sin campos requeridos: ${faltantes.join(', ')}`);
        }
    }

    obtenerNodo(stepId) {
        return this.nodos[this.normalizarStepId(stepId)] || null;
    }

    requerirNodo(stepId) {
        const nodo = this.obtenerNodo(stepId);
        if (!nodo) throw new Error(`No existe el nodo de flujo: ${stepId}`);
        return nodo;
    }

    respuesta(stepId, variables = {}) {
        return this.renderizarCampo(stepId, 'bot_response', variables);
    }

    fallback(stepId, variables = {}) {
        return this.renderizarCampo(stepId, 'fallback', variables);
    }

    metadata(stepId) {
        const nodo = this.requerirNodo(stepId);
        return {
            stepId: nodo.step_id,
            objective: nodo.objective,
            userAction: nodo.user_action,
            validationRule: nodo.validation_rule,
            requiredData: nodo.required_data,
            nextStep: nodo.next_step
        };
    }

    renderizarCampo(stepId, campo, variables = {}) {
        const nodo = this.requerirNodo(stepId);
        const valor = nodo[campo];
        if (valor === undefined || valor === null) return '';
        return this.interpolar(String(valor), variables).trim();
    }

    interpolar(texto, variables = {}) {
        const valores = { ...this.variables, ...variables };

        return String(texto || '')
            .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => this.valorVariable(valores, key, match))
            .replace(/\[([A-Za-z0-9_.-]+)\]/g, (match, key) => this.valorVariable(valores, key, match));
    }

    valorVariable(valores, key, fallback) {
        const partes = String(key).split('.');
        let actual = valores;

        for (const parte of partes) {
            if (actual === undefined || actual === null || !(parte in Object(actual))) {
                return fallback;
            }
            actual = actual[parte];
        }

        if (actual === undefined || actual === null) return fallback;
        return String(actual);
    }

    normalizarStepId(stepId) {
        return String(stepId || '').trim();
    }
}

module.exports = FlowDefinitionService;
