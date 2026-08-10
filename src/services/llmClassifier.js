const logger = require('./logger');

const SYSTEM_PROMPT = `Eres el clasificador de intenciones del asistente de Laboratorios Nápoles (México).
Tu tarea es clasificar el mensaje del usuario y extraer el nombre estándar del estudio/tema en 'query'.

Categorías permitidas ('intent'):
1. "cotizacion": Pregunta por precio, costo o estudios de laboratorio/gabinete.
2. "sucursal": Busca ubicación, dirección, horario o sucursales.
3. "indicaciones": Pregunta por requisitos de ayuno, preparación o muestras.
4. "asesor": Desea hablar con un agente humano.
5. "desconocido": Cualquier otra interacción.

REGLAS DE NORMALIZACIÓN PARA 'query':
Debes traducir modismos, abreviaturas clínicas, lenguaje coloquial mexicano, síntomas o frases informales al término médico/comercial estándar del estudio:
- "preñada", "embarazada", "saber si estoy embarazada", "saber si estoy preñada" -> "prueba de embarazo"
- "azúcar", "azúcar alta", "para saber la glucosa" -> "glucosa"
- "rx", "placa", "radiografía" -> "radiografia"
- "rx ap y lateral de columna cervical" -> "radiografia de columna cervical ap y lateral"
- "usg", "eco", "ecografía" -> "ultrasonido"
- "estudio de la próstata" -> "antigeno prostatico"
- "saber si tengo anemia" -> "biometria hematica"
- "papanicolado", "papanicolaou" -> "papanicolaou"
- "grasa en la sangre" -> "perfil lipido"

Reglas estrictas:
- No inventes información.
- Nunca des precios, direcciones, horarios ni promociones: eso lo consulta el sistema.
- Nunca diagnostiques ni interpretes resultados médicos. Eso es "desconocido".
- Debes responder únicamente con el JSON especificado.`;

const SCHEMA_JSON = {
    type: "object",
    properties: {
        intent: {
            type: "string",
            enum: ["cotizacion", "sucursal", "indicaciones", "asesor", "desconocido"]
        },
        query: {
            type: "string"
        }
    },
    required: ["intent", "query"]
};

const INTENTS_VALIDOS = new Set(SCHEMA_JSON.properties.intent.enum);
const VACIO = { intent: 'desconocido', query: '' };

class LLMClassifier {
    /**
     * Admite la forma nueva `new LLMClassifier(CONFIG.NLU)` y la antigua
     * `new LLMClassifier('http://host:11434', 'qwen3:8b')`.
     */
    constructor(config = {}, modeloLegacy = null, fetchImpl = null) {
        const opciones = typeof config === 'string'
            ? { baseUrl: config, modelo: modeloLegacy || 'qwen3:8b' }
            : (config || {});

        this.config = {
            enabled: opciones.enabled !== false,
            // 'sombra' consulta el modelo y lo registra, pero NO decide. 'activo' le da el control.
            modo: opciones.modo === 'activo' ? 'activo' : 'sombra',
            baseUrl: String(opciones.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
            modelo: opciones.modelo || 'qwen3:8b',
            timeoutMs: opciones.timeoutMs || 10000,
            // Sin esto Ollama descarga el modelo a los 5 min de inactividad y la siguiente
            // consulta paga la recarga completa de 5.2 GB, muy por encima del timeout.
            keepAlive: opciones.keepAlive || '30m',
            numCtx: opciones.numCtx || 2048,
            numPredict: opciones.numPredict || 100,
            sinRazonamiento: opciones.sinRazonamiento !== false,
            fallosParaAbrir: opciones.fallosParaAbrir || 3,
            reposoMs: opciones.reposoMs || 60000,
            tamanoCache: opciones.tamanoCache ?? 500
        };

        this.fetch = fetchImpl || globalThis.fetch;
        this.cache = new Map();
        this.fallosConsecutivos = 0;
        this.abiertoHasta = 0;
        this.soportaThink = true;

        // Compatibilidad con el código previo.
        this.ollamaUrl = this.config.baseUrl;
        this.model = this.config.modelo;
        this.timeoutMs = this.config.timeoutMs;

        logger.debug('LLM', 'LLMClassifier inicializado', this.config);
    }

    /** El clasificador está encendido y el circuito no está abierto. */
    disponible() {
        return this.config.enabled && this.abiertoHasta <= Date.now();
    }

    /** Solo en modo activo se le permite cambiar el rumbo de la conversación. */
    decide() {
        return this.config.enabled && this.config.modo === 'activo';
    }

    claveCache(texto) {
        return String(texto || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    leerCache(clave) {
        if (!this.cache.has(clave)) return undefined;
        const valor = this.cache.get(clave);
        this.cache.delete(clave);
        this.cache.set(clave, valor);
        return valor;
    }

    guardarCache(clave, valor) {
        if (this.config.tamanoCache <= 0) return;
        if (this.cache.size >= this.config.tamanoCache) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(clave, valor);
    }

    construirPayload(mensajeOriginal) {
        const payload = {
            model: this.config.modelo,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: mensajeOriginal }
            ],
            format: SCHEMA_JSON,
            stream: false,
            keep_alive: this.config.keepAlive,
            options: {
                temperature: 0.0,
                top_p: 1,
                num_ctx: this.config.numCtx,
                num_predict: this.config.numPredict
            }
        };

        if (this.config.sinRazonamiento && this.soportaThink) {
            payload.think = false;
        }

        return payload;
    }

    async llamarOllama(payload, timeoutMs = this.config.timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const respuesta = await this.fetch(`${this.config.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!respuesta.ok) {
                const detalle = await respuesta.text().catch(() => '');
                const error = new Error(`Error en API Ollama: ${respuesta.status} ${detalle}`.trim());
                error.status = respuesta.status;
                error.detalle = detalle;
                throw error;
            }

            return await respuesta.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    interpretar(data) {
        const content = data?.message?.content ?? data?.response ?? '';
        if (!content) return null;

        let parsed;
        try {
            parsed = typeof content === 'string' ? JSON.parse(content) : content;
        } catch (_error) {
            logger.error('LLM_PARSE', 'Error parseando JSON de Ollama', { content });
            return null;
        }

        const intent = String(parsed?.intent || '').trim();
        if (!INTENTS_VALIDOS.has(intent)) {
            logger.warn('LLM_PARSE', 'Intent fuera del catálogo cerrado', { parsed });
            return null;
        }

        return { intent, query: String(parsed?.query || '').trim() };
    }

    registrarFallo(error, texto) {
        this.fallosConsecutivos += 1;

        if (error?.name === 'AbortError') {
            logger.warn('LLM_TIMEOUT', 'Timeout en Ollama, cayendo a fallback', {
                texto,
                timeoutMs: this.config.timeoutMs,
                fallosConsecutivos: this.fallosConsecutivos
            });
        } else {
            logger.error('LLM_API_ERROR', 'Error conectando con Ollama', {
                texto,
                error: error?.message || String(error),
                fallosConsecutivos: this.fallosConsecutivos
            });
        }

        if (this.fallosConsecutivos >= this.config.fallosParaAbrir) {
            this.abiertoHasta = Date.now() + this.config.reposoMs;
            logger.error('LLM_CIRCUITO', 'Circuito abierto: se deja de consultar a Ollama', {
                fallosConsecutivos: this.fallosConsecutivos,
                reposoMs: this.config.reposoMs
            });
        }
    }

    /**
     * Devuelve { intent, query } o null.
     * null significa siempre "sigue con el comportamiento determinista de siempre".
     * Nunca lanza: cualquier fallo del modelo se convierte en null.
     */
    async clasificarIntencion(mensajeOriginal) {
        const texto = String(mensajeOriginal || '').trim();
        if (!texto) return VACIO;
        if (!this.config.enabled) return null;

        if (this.abiertoHasta > Date.now()) {
            logger.debug('LLM_CIRCUITO', 'Circuito abierto, se omite la consulta', { texto });
            return null;
        }

        const clave = this.claveCache(texto);
        const enCache = this.leerCache(clave);
        if (enCache !== undefined) {
            logger.debug('LLM', 'Intent resuelto desde caché', { texto, resultado: enCache });
            return enCache;
        }

        const inicio = Date.now();
        try {
            let data;
            try {
                data = await this.llamarOllama(this.construirPayload(texto));
            } catch (error) {
                // Ollama antiguo no conoce el parámetro think: reintentar una vez sin él.
                if (this.soportaThink && error?.status === 400 && /think/i.test(error?.detalle || '')) {
                    logger.warn('LLM', 'Esta versión de Ollama no admite think:false, se reintenta sin él');
                    this.soportaThink = false;
                    data = await this.llamarOllama(this.construirPayload(texto));
                } else {
                    throw error;
                }
            }

            const resultado = this.interpretar(data);
            this.fallosConsecutivos = 0;

            logger.info('LLM', 'Intent clasificado', {
                texto,
                resultado,
                modo: this.config.modo,
                latenciaMs: Date.now() - inicio
            });

            if (resultado) this.guardarCache(clave, resultado);
            return resultado;
        } catch (error) {
            this.registrarFallo(error, texto);
            return null;
        }
    }

    /**
     * Carga el modelo en RAM al arrancar para que el primer paciente no pague el arranque en frío.
     * Manda el prompt de sistema REAL, no uno de juguete: así se calienta también la caché de
     * atención del prefijo, que es lo que hace que la primera consulta de verdad tarde ~4x más.
     */
    async precalentar(timeoutMs = 180000) {
        if (!this.config.enabled) return false;

        const inicio = Date.now();
        try {
            await this.llamarOllama(this.construirPayload('calentamiento'), timeoutMs);

            logger.info('LLM', 'Modelo precargado en Ollama', {
                modelo: this.config.modelo,
                baseUrl: this.config.baseUrl,
                keepAlive: this.config.keepAlive,
                msCarga: Date.now() - inicio
            });
            return true;
        } catch (error) {
            logger.warn('LLM', 'No se pudo precargar el modelo, el bot sigue funcionando sin IA', {
                error: error?.message || String(error)
            });
            return false;
        }
    }
}

module.exports = LLMClassifier;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.SCHEMA_JSON = SCHEMA_JSON;
