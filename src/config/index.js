const path = require('path');

const ENV_PATH = process.env.DOTENV_CONFIG_PATH
    ? path.resolve(process.env.DOTENV_CONFIG_PATH)
    : path.resolve(__dirname, '..', '..', '.env');

const DEFAULT_CP_SHAPEFILE_BASE = path.resolve(__dirname, '..', 'utils', 'CP_Tab', 'CP_Tab');
const DEFAULT_CHATBOT_FLOW_PATH = path.resolve(__dirname, '..', 'data', 'chatbot-flow.json');
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
const DEFAULT_WHISPER_CLI_PATH = HOME_DIR
    ? path.join(HOME_DIR, 'whisper.cpp', 'build', 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
    : 'whisper-cli';
const DEFAULT_WHISPER_MODEL_PATH = HOME_DIR
    ? path.join(HOME_DIR, 'whisper.cpp', 'models', 'ggml-small.bin')
    : '';
const DEFAULT_MEDIA_TEMP_DIR = path.resolve(__dirname, '..', '..', 'tmp', 'media');

require('dotenv').config({ path: ENV_PATH, quiet: true });

function listaDesdeEnv(nombre, fallback = []) {
    const valor = process.env[nombre];
    if (!valor) return fallback;
    return valor.split(',').map(item => item.trim()).filter(Boolean);
}

function enteroDesdeEnv(nombre, fallback, minimo, maximo) {
    const valor = Number.parseInt(process.env[nombre], 10);
    if (!Number.isInteger(valor)) return fallback;
    return Math.min(maximo, Math.max(minimo, valor));
}

function booleanoDesdeEnv(nombre, fallback = false) {
    const valor = process.env[nombre];
    if (valor === undefined) return fallback;
    return ['1', 'true', 'si', 'yes'].includes(String(valor).trim().toLowerCase());
}

function validarConfiguracion(requeridas = []) {
    const faltantes = requeridas.filter(v => !process.env[v]);
    if (faltantes.length > 0) throw new Error(`❌ Faltan variables: ${faltantes.join(', ')}`);
}

const CONFIG = {
    CHATWOOT_API_URL: process.env.CHATWOOT_URL || "http://127.0.0.1:3000/api/v1",
    BOT_TOKEN: process.env.CHATWOOT_BOT_TOKEN,
    // Opcionales: a quien se le entrega la conversacion al escalar a humano.
    CHATWOOT_TEAM_ID: process.env.CHATWOOT_TEAM_ID || null,
    CHATWOOT_ASSIGNEE_ID: process.env.CHATWOOT_ASSIGNEE_ID || null,
    CACHE_TTL: 1000 * 60 * 10,
    ITEMS_POR_PAGINA: 10,
    SUCURSALES_DATA_URL: process.env.SUCURSALES_DATA_URL || "https://raw.githubusercontent.com/napoles-desarrollo/sucursales/refs/heads/main/listasucursales.json",
    CHATBOT_FLOW_PATH: process.env.CHATBOT_FLOW_PATH || DEFAULT_CHATBOT_FLOW_PATH,
    BOT_ASSISTANT_NAME: process.env.BOT_ASSISTANT_NAME || 'Napo',
    DEBUG: booleanoDesdeEnv('CHATBOT_DEBUG', true),
    DEBUG_VERBOSE: booleanoDesdeEnv('CHATBOT_DEBUG_VERBOSE', true),
    CP_SHAPEFILE_BASE: process.env.CP_SHAPEFILE_BASES || process.env.CP_SHAPEFILE_BASE || DEFAULT_CP_SHAPEFILE_BASE,
    API_BASE_URL: process.env.API_BASE_URL || "",
    API_TOKEN: process.env.API_TOKEN || "",
    PORTAL_SALUD_URL: process.env.PORTAL_SALUD_URL || "https://portal.labnapoles.mx",
    TOP_STUDIES_FROM: process.env.TOP_STUDIES_FROM || "2026-01-01",
    TOP_STUDIES_LIMIT: enteroDesdeEnv('TOP_STUDIES_LIMIT', 5, 1, 10),
    BOT_DISABLED_LABELS: listaDesdeEnv('BOT_DISABLED_LABELS', ['sucursales']),
    BOT_DISABLED_PHONES: listaDesdeEnv('BOT_DISABLED_PHONES'),
    SPEECH: {
        enabled: booleanoDesdeEnv('AUDIO_TRANSCRIPTION_ENABLED', true),
        ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
        whisperCliPath: process.env.WHISPER_CLI_PATH || DEFAULT_WHISPER_CLI_PATH,
        whisperModelPath: process.env.WHISPER_MODEL_PATH || DEFAULT_WHISPER_MODEL_PATH,
        language: process.env.WHISPER_LANGUAGE || 'es',
        initialPrompt: process.env.WHISPER_INITIAL_PROMPT || 'Chatbot de Laboratorios Napoles en espanol mexicano. Opciones frecuentes: Villahermosa, Villa Jalupa, Nacajuca Laboratorio, cotizar servicios, consultar resultados, direcciones y horarios, hablar con asesor.',
        mediaTempDir: process.env.MEDIA_TEMP_DIR || DEFAULT_MEDIA_TEMP_DIR,
        timeoutMs: enteroDesdeEnv('WHISPER_TIMEOUT_MS', 120000, 1000, 600000),
        keepMedia: booleanoDesdeEnv('MEDIA_KEEP_FILES', false)
    },
    OCR: {
        enabled: booleanoDesdeEnv('OCR_ENABLED', true),
        language: process.env.OCR_LANGUAGE || 'spa+eng',
        timeoutMs: enteroDesdeEnv('OCR_TIMEOUT_MS', 120000, 1000, 600000),
        minChars: enteroDesdeEnv('OCR_MIN_CHARS', 3, 1, 200),
        logProgress: booleanoDesdeEnv('OCR_LOG_PROGRESS', false)
    },
    NLU: {
        enabled: booleanoDesdeEnv('NLU_ENABLED', false),
        // 'sombra' ejecuta el modelo y lo registra sin decidir nada. 'activo' le da el control.
        modo: process.env.NLU_MODO === 'activo' ? 'activo' : 'sombra',
        baseUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
        modelo: process.env.OLLAMA_MODEL || 'qwen3:8b',
        timeoutMs: enteroDesdeEnv('NLU_TIMEOUT_MS', 10000, 500, 60000),
        keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        numCtx: enteroDesdeEnv('NLU_NUM_CTX', 2048, 512, 8192),
        numPredict: enteroDesdeEnv('NLU_NUM_PREDICT', 100, 16, 512),
        sinRazonamiento: booleanoDesdeEnv('NLU_SIN_RAZONAMIENTO', true),
        fallosParaAbrir: enteroDesdeEnv('NLU_FALLOS_PARA_ABRIR', 3, 1, 20),
        reposoMs: enteroDesdeEnv('NLU_REPOSO_MS', 60000, 1000, 600000),
        tamanoCache: enteroDesdeEnv('NLU_CACHE', 500, 0, 5000),
        precalentar: booleanoDesdeEnv('NLU_PRECALENTAR', true)
    },
    DB: {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        server: process.env.DB_SERVER,
        database: process.env.DB_DATABASE,
        port: enteroDesdeEnv('DB_PORT', 1433, 1, 65535),
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        connectionTimeout: enteroDesdeEnv('DB_CONNECTION_TIMEOUT_MS', 15000, 1000, 120000),
        requestTimeout: enteroDesdeEnv('DB_REQUEST_TIMEOUT_MS', 30000, 1000, 300000),
        options: {
            encrypt: booleanoDesdeEnv('DB_ENCRYPT', false),
            trustServerCertificate: booleanoDesdeEnv('DB_TRUST_SERVER_CERTIFICATE', true),
            enableArithAbort: true
        }
    }
};

const ESTADOS = {
    INICIO: 'inicio',
    ESPERANDO_UBICACION: 'esperando_ubicacion',
    CONFIRMANDO_SUCURSAL: 'confirmando_sucursal',
    SELECCIONANDO_SUCURSAL_CERCANA: 'seleccionando_sucursal_cercana',
    MENU: 'menu',
    ESPERANDO_ESTADO: 'esperando_estado',
    ESPERANDO_MUNICIPIO: 'esperando_municipio',
    ESPERANDO_SUCURSAL: 'esperando_sucursal',
    COTIZACION_TIPO_SERVICIO: 'cotizacion_tipo_servicio',
    COTIZACION_FORMA_BUSQUEDA: 'cotizacion_forma_busqueda',
    COTIZACION_BUSCAR_ESTUDIO: 'cotizacion_buscar_estudio',
    COTIZACION_CONFIRMAR_ESTUDIOS: 'cotizacion_confirmar_estudios',
    COTIZACION_POST_COTIZACION: 'cotizacion_post_cotizacion',
    ESPERANDO_CONSULTA_ID: 'esperando_consulta_id',
    RESULTADOS_METODO_BUSQUEDA: 'resultados_metodo_busqueda',
    RESULTADOS_ESPERANDO_DATO: 'resultados_esperando_dato',
    RESULTADOS_ACCION: 'resultados_accion',
    PRECIOS_PASO_MUNICIPIO: 'precios_paso_municipio',
    PRECIOS_PASO_UNO: 'precios_paso_uno',
    AGENTE: 'hablando_con_agente',
    // ✅ AGREGADO: Necesario para el cierre de conversación
    ESPERANDO_CONFIRMACION: 'esperando_confirmacion',
    SUCURSAL_DETALLES: 'sucursal_detalles'
};

module.exports = { CONFIG, ESTADOS, ENV_PATH, validarConfiguracion };
