const fs = require('fs');
const path = require('path');
const { normalizar } = require('../utils/helpers');

function normalizarAlias(texto) {
    return normalizar(texto)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

class AliasEstudiosService {
    constructor(dataPath = path.join(__dirname, '..', 'data', 'estudios-aliases.json')) {
        this.dataPath = dataPath;
        this.aliases = this.cargar();
    }

    cargar() {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
        if (!Array.isArray(data.aliases)) {
            throw new Error('Catálogo de alias inválido');
        }

        const terminos = new Set();
        return data.aliases.map((grupo, indice) => {
            if (!Array.isArray(grupo.terminos) || grupo.terminos.length === 0) {
                throw new Error(`Grupo de alias ${indice} sin términos`);
            }
            if (!Array.isArray(grupo.candidatos) || grupo.candidatos.length === 0) {
                throw new Error(`Grupo de alias ${indice} sin candidatos`);
            }

            const terminosNormalizados = grupo.terminos.map(normalizarAlias);
            terminosNormalizados.forEach(termino => {
                if (!termino || terminos.has(termino)) {
                    throw new Error(`Alias duplicado o vacío: ${termino}`);
                }
                terminos.add(termino);
            });

            const candidatos = grupo.candidatos.map(candidato => {
                const id = Number(candidato.id_estudio);
                if (!Number.isInteger(id) || id <= 0 || !candidato.nombre) {
                    throw new Error(`Candidato inválido para ${grupo.terminos[0]}`);
                }
                return {
                    id,
                    nombre: candidato.nombre,
                    prioridad: Number(candidato.prioridad) || 0
                };
            }).sort((a, b) => b.prioridad - a.prioridad);

            return {
                terminos: terminosNormalizados,
                requiereConfirmacion: Boolean(grupo.requiere_confirmacion),
                pregunta: grupo.pregunta || null,
                candidatos
            };
        });
    }

    resolver(texto) {
        const entrada = normalizarAlias(texto);
        if (!entrada) return null;

        const coincidencias = [];
        for (const grupo of this.aliases) {
            for (const termino of grupo.terminos) {
                const coincide = entrada === termino || ` ${entrada} `.includes(` ${termino} `);
                if (coincide) coincidencias.push({ grupo, termino });
            }
        }

        if (coincidencias.length === 0) return null;
        coincidencias.sort((a, b) => b.termino.length - a.termino.length);
        const mejor = coincidencias[0];

        return {
            alias: mejor.termino,
            requiereConfirmacion: mejor.grupo.requiereConfirmacion,
            pregunta: mejor.grupo.pregunta,
            candidatos: mejor.grupo.candidatos
        };
    }
}

module.exports = AliasEstudiosService;
