const tesseract = require('tesseract.js');
const logger = require('./logger');

class OcrService {
    constructor(config = {}, recognizer = tesseract) {
        this.config = {
            enabled: config.enabled !== false,
            language: config.language || 'spa+eng',
            timeoutMs: config.timeoutMs || 120000,
            minChars: config.minChars || 3,
            logProgress: Boolean(config.logProgress)
        };
        this.recognizer = recognizer;
        logger.debug('OCR', 'OcrService inicializado', this.config);
    }

    esImagenMedia(media) {
        const mime = String(media?.mimetype || '').toLowerCase();
        return mime.startsWith('image/');
    }

    async extraerTextoMedia(media, opciones = {}) {
        logger.info('OCR', 'Solicitud OCR recibida', {
            mimetype: media?.mimetype,
            hasData: Boolean(media?.data),
            dataLength: media?.data ? String(media.data).length : 0,
            opciones
        });

        if (!this.config.enabled) {
            throw new Error('OCR desactivado.');
        }
        if (!media?.data) {
            logger.warn('OCR', 'Media sin data, no se procesa OCR');
            return null;
        }
        if (!this.esImagenMedia(media)) {
            logger.warn('OCR', 'Media no es imagen, no se procesa OCR', {
                mimetype: media?.mimetype
            });
            return null;
        }

        const buffer = Buffer.from(media.data, 'base64');
        const resultado = await this.conTimeout(
            this.recognizer.recognize(buffer, this.config.language, this.opcionesTesseract(opciones)),
            this.config.timeoutMs
        );
        const textoOriginal = resultado?.data?.text || resultado?.text || '';
        const textoLimpio = this.limpiarTexto(textoOriginal);
        const confidence = resultado?.data?.confidence ?? null;

        logger.info('OCR', 'OCR terminado', {
            confidence,
            textoOriginal,
            textoLimpio
        });

        if (textoLimpio.length < this.config.minChars) return null;
        return textoLimpio;
    }

    opcionesTesseract(opciones = {}) {
        const base = { ...(opciones.tesseractOptions || {}) };
        if (this.config.logProgress) {
            base.logger = mensaje => logger.debug('OCR_PROGRESS', 'Progreso OCR', mensaje);
        }
        return base;
    }

    async conTimeout(promesa, timeoutMs) {
        let timer;
        try {
            return await Promise.race([
                promesa,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`Timeout OCR despues de ${timeoutMs}ms`)), timeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    limpiarTexto(texto) {
        return String(texto || '')
            .replace(/\\r/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .map(linea => linea.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
    }
}

module.exports = OcrService;
