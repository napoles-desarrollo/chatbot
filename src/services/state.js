const { ESTADOS } = require('../config');
const logger = require('./logger');

class GestorEstados {
    constructor() { this.conversaciones = new Map(); }
    
    estadoInicial() {
        return { estado: ESTADOS.INICIO, datos: {} };
    }

    obtener(cid) { 
        if (!this.conversaciones.has(cid)) {
            const inicial = this.estadoInicial();
            this.conversaciones.set(cid, inicial);
            logger.debug('STATE', 'Nueva conversacion en memoria', {
                conversationId: cid,
                estado: inicial.estado
            });
        }
        return this.conversaciones.get(cid); 
    }
    
    actualizar(cid, nuevo, datos = {}) { 
        const actual = this.obtener(cid);
        const anterior = actual.estado;
        actual.estado = nuevo; 
        actual.datos = { ...actual.datos, ...datos }; 
        this.conversaciones.set(cid, actual);
        logger.debug('STATE', 'Estado actualizado', {
            conversationId: cid,
            de: anterior,
            a: nuevo,
            datosNuevos: datos,
            datosActuales: actual.datos
        });
    }
    
    reiniciar(cid) { 
        const inicial = this.estadoInicial();
        this.conversaciones.set(cid, inicial);
        logger.debug('STATE', 'Conversacion reiniciada', {
            conversationId: cid,
            estado: inicial.estado
        });
    }
    
    limpiar(cid) { 
        this.conversaciones.delete(cid);
        logger.debug('STATE', 'Conversacion eliminada de memoria', {
            conversationId: cid
        });
    }
}

module.exports = GestorEstados;
