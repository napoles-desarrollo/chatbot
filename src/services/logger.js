const { inspect } = require('util');

function booleanoDesdeEnv(nombre, fallback = true) {
    const valor = process.env[nombre];
    if (valor === undefined) return fallback;
    return ['1', 'true', 'si', 'yes', 'on'].includes(String(valor).trim().toLowerCase());
}

function enteroDesdeEnv(nombre, fallback, minimo, maximo) {
    const valor = Number.parseInt(process.env[nombre], 10);
    if (!Number.isInteger(valor)) return fallback;
    return Math.min(maximo, Math.max(minimo, valor));
}

const DEBUG_ACTIVO = booleanoDesdeEnv('CHATBOT_DEBUG', true);
const DEBUG_VERBOSE = booleanoDesdeEnv('CHATBOT_DEBUG_VERBOSE', true);
const MAX_TEXTO = enteroDesdeEnv('CHATBOT_DEBUG_MAX_TEXT', 1200, 200, 10000);

const CAMPOS_SENSIBLES = new Set([
    'password',
    'token',
    'api_token',
    'api_access_token',
    'authorization',
    'bot_token',
    'chatwoot_bot_token',
    'db_password'
]);

const CAMPOS_PESADOS = new Set([
    'data',
    'body',
    'media',
    'base64',
    'mimetype'
]);

function truncarTexto(texto) {
    const valor = String(texto);
    if (valor.length <= MAX_TEXTO) return valor;
    return `${valor.slice(0, MAX_TEXTO)}... [truncado ${valor.length - MAX_TEXTO} chars]`;
}

function limpiarValor(valor, profundidad = 0) {
    if (valor === null || valor === undefined) return valor;
    if (typeof valor === 'string') return truncarTexto(valor);
    if (typeof valor !== 'object') return valor;
    if (valor instanceof Date) return valor.toISOString();
    if (valor instanceof Error) {
        return {
            message: valor.message,
            stack: valor.stack
        };
    }
    if (Buffer.isBuffer(valor)) return `[buffer ${valor.length} bytes]`;
    if (profundidad > 5) return '[profundidad-maxima]';
    if (Array.isArray(valor)) return valor.map(item => limpiarValor(item, profundidad + 1));

    const salida = {};
    for (const [clave, item] of Object.entries(valor)) {
        const claveNormalizada = clave.toLowerCase();
        if (CAMPOS_SENSIBLES.has(claveNormalizada) || claveNormalizada.includes('password') || claveNormalizada.includes('token')) {
            salida[clave] = '[oculto]';
            continue;
        }
        if (CAMPOS_PESADOS.has(claveNormalizada) && typeof item === 'string' && item.length > 200) {
            salida[clave] = `[omitido ${item.length} chars]`;
            continue;
        }
        salida[clave] = limpiarValor(item, profundidad + 1);
    }
    return salida;
}

function formatoFecha() {
    return new Date().toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City',
        hour12: false
    });
}

function imprimir(nivel, area, mensaje, datos) {
    if (!DEBUG_ACTIVO && nivel !== 'ERROR') return;

    const prefijo = `[${formatoFecha()}][${nivel}][${area}]`;
    const metodo = nivel === 'ERROR' ? console.error : console.log;

    metodo(`${prefijo} ${mensaje}`);
    if (datos !== undefined) {
        metodo(inspect(limpiarValor(datos), {
            colors: true,
            depth: DEBUG_VERBOSE ? 8 : 4,
            maxArrayLength: DEBUG_VERBOSE ? 80 : 20,
            breakLength: 140,
            compact: false
        }));
    }
}

module.exports = {
    activo: () => DEBUG_ACTIVO,
    debug: (area, mensaje, datos) => imprimir('DEBUG', area, mensaje, datos),
    info: (area, mensaje, datos) => imprimir('INFO', area, mensaje, datos),
    warn: (area, mensaje, datos) => imprimir('WARN', area, mensaje, datos),
    error: (area, mensaje, datos) => imprimir('ERROR', area, mensaje, datos)
};
