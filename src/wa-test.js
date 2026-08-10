const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');
const https = require('https');

const { CONFIG, validarConfiguracion } = require('./config');
const { normalizar } = require('./utils/helpers');

const CacheSucursales = require('./services/sucursales');
const GestorEstados = require('./services/state');
const GeoService = require('./services/geo');
const GestorBaseDatos = require('./services/database');
const CatalogoService = require('./services/catalogo');
const SpeechService = require('./services/speech');
const OcrService = require('./services/ocr');
const FlowDefinitionService = require('./services/flowDefinition');
const logger = require('./services/logger');
const ManejadorComandos = require('./handlers/commands');

function booleanoDesdeEnv(nombre, fallback = true) {
    const valor = process.env[nombre];
    if (valor === undefined) return fallback;
    return ['1', 'true', 'si', 'yes'].includes(String(valor).trim().toLowerCase());
}

function crearOpcionesPuppeteer() {
    const fs = require('fs');
    const puppeteer = require('puppeteer');

    const opciones = {
        headless: booleanoDesdeEnv('WA_HEADLESS', true),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions'
        ]
    };

    // Permitir una ruta personalizada mediante variable de entorno
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        opciones.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    // Linux / Ubuntu: utilizar el Chrome descargado por Puppeteer
    else if (process.platform === 'linux') {
        const chromePath = puppeteer.executablePath();

        if (fs.existsSync(chromePath)) {
            opciones.executablePath = chromePath;
        } else {
            throw new Error(
                `No se encontró el Chrome de Puppeteer en: ${chromePath}`
            );
        }
    }
    // Windows: buscar Chrome o Edge instalado
    else if (process.platform === 'win32') {
        const candidatos = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ];

        for (const ruta of candidatos) {
            if (fs.existsSync(ruta)) {
                opciones.executablePath = ruta;
                break;
            }
        }
    }

    console.log('[PUPPETEER] executablePath:', opciones.executablePath);
    console.log('[PUPPETEER] headless:', opciones.headless);

    return opciones;
}

function mostrarAyudaErrorNavegador(error) {
    const mensaje = error?.message || String(error);

    console.error('\nNo se pudo abrir Chrome/Chromium para WhatsApp Web.');
    console.error(mensaje);

    if (process.platform === 'win32') {
        console.error('\nEn Windows ejecuta el siguiente comando para descargar Chrome para Puppeteer:');
        console.error('npx puppeteer browsers install chrome');
        console.error('\nO especifica la ruta de tu Chrome en la variable de entorno PUPPETEER_EXECUTABLE_PATH.');
    } else {
        console.error('\nEn WSL/Ubuntu instala las dependencias del navegador:');
        console.error('sudo apt update');
        console.error('sudo apt install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils');
    }
    console.error('\nLuego vuelve a ejecutar el script.\n');
}

function esChatIgnorado(msg) {
    const origen = String(msg?.from || '');
    return Boolean(
        msg?.fromMe ||
        msg?.isStatus ||
        origen === 'status@broadcast' ||
        origen.endsWith('@broadcast') ||
        origen.endsWith('@newsletter') ||
        origen.endsWith('@g.us')
    );
}

function esMensajeAudio(msg) {
    const tipo = String(msg?.type || '').toLowerCase();
    return Boolean(msg?.hasMedia && ['audio', 'ptt', 'voice'].includes(tipo));
}

function esMensajeImagen(msg) {
    const tipo = String(msg?.type || '').toLowerCase();
    return Boolean(msg?.hasMedia && ['image'].includes(tipo));
}

function limpiarTextoOpcion(texto) {
    let limpio = normalizar(String(texto || ''))
        .replace(/[^\w\s]/g, ' ')
        .replace(/\b(opcion|numero|num|sucursal|laboratorio|lab|matriz)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (limpio.includes('villahermosa') || limpio.includes('villa hermosa')) {
        limpio = `${limpio} villa hermosa hermosa mosa`;
    }

    return limpio.replace(/^\d+\s+/, '').trim();
}

function numeroDesdeTextoOpcion(texto) {
    const limpio = limpiarTextoOpcion(texto);
    const numero = limpio.match(/\b([1-9])\b/);
    if (numero) return Number(numero[1]);

    const palabras = new Map([
        ['uno', 1], ['una', 1], ['primer', 1], ['primero', 1], ['primera', 1],
        ['dos', 2], ['segundo', 2], ['segunda', 2],
        ['tres', 3], ['tercer', 3], ['tercero', 3], ['tercera', 3],
        ['cuatro', 4], ['cuarto', 4], ['cuarta', 4],
        ['cinco', 5], ['quinto', 5], ['quinta', 5],
        ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9]
    ]);

    for (const [palabra, valor] of palabras.entries()) {
        if (new RegExp(`\\b${palabra}\\b`).test(limpio)) return valor;
    }

    return null;
}

function distanciaLevenshtein(a, b) {
    const origen = String(a || '');
    const destino = String(b || '');
    const matriz = Array.from({ length: origen.length + 1 }, (_, i) => [i]);

    for (let j = 1; j <= destino.length; j += 1) matriz[0][j] = j;

    for (let i = 1; i <= origen.length; i += 1) {
        for (let j = 1; j <= destino.length; j += 1) {
            const costo = origen[i - 1] === destino[j - 1] ? 0 : 1;
            matriz[i][j] = Math.min(
                matriz[i - 1][j] + 1,
                matriz[i][j - 1] + 1,
                matriz[i - 1][j - 1] + costo
            );
        }
    }

    return matriz[origen.length][destino.length];
}

function puntuarCoincidenciaOpcion(entrada, titulo) {
    const texto = limpiarTextoOpcion(entrada);
    const opcion = limpiarTextoOpcion(titulo);
    if (!texto || !opcion) return 0;
    if (texto === opcion) return 1;
    if (opcion.includes(texto) && texto.length >= 4) return 0.95;
    if (texto.includes(opcion) && opcion.length >= 4) return 0.95;

    const tokensEntrada = texto.split(/\s+/).filter(token => token.length >= 4);
    const tokensOpcion = new Set(opcion.split(/\s+/).filter(token => token.length >= 4));
    const comunes = tokensEntrada.filter(token => tokensOpcion.has(token)).length;
    const scoreTokens = tokensEntrada.length > 0 ? comunes / tokensEntrada.length : 0;
    const maxLen = Math.max(texto.length, opcion.length, 1);
    const scoreDistancia = 1 - (distanciaLevenshtein(texto, opcion) / maxLen);

    return Math.max(scoreTokens, scoreDistancia);
}

function buscarPorTokenUnico(entrada, opciones) {
    const tokensEntrada = limpiarTextoOpcion(entrada)
        .split(/\s+/)
        .filter(token => token.length >= 4);
    if (tokensEntrada.length === 0) return null;

    for (const token of tokensEntrada) {
        const candidatas = opciones.filter(opcion => limpiarTextoOpcion(opcion.title)
            .split(/\s+/)
            .includes(token));
        if (candidatas.length === 1) return candidatas[0];
    }

    return null;
}

function construirPromptAudio(adapter, chatId) {
    const base = CONFIG.SPEECH.initialPrompt || '';
    const opciones = adapter.obtenerPistasAudio(chatId);
    if (opciones.length === 0) return base;
    return `${base} Opciones visibles en este momento: ${opciones.join(', ')}.`;
}

class WhatsAppTestClient {
    constructor(waClient) {
        this.wa = waClient;
        this.opcionesPorChat = new Map();
    }

    traducirEntrada(chatId, texto) {
        const limpio = String(texto || '').trim();
        const opciones = this.opcionesPorChat.get(chatId);

        if (!opciones || opciones.length === 0) {
            logger.debug('WA_INPUT', 'Entrada sin opciones visibles para traducir', {
                chatId,
                texto
            });
            return texto;
        }

        const directa = opciones.find(opcion => opcion.numero === limpio || normalizar(opcion.value) === normalizar(limpio));
        if (directa) {
            this.opcionesPorChat.delete(chatId);
            logger.info('WA_INPUT', 'Entrada traducida por coincidencia directa', {
                chatId,
                texto,
                opcion: directa
            });
            return directa.value;
        }

        const numerosEnTexto = [...limpio.matchAll(/\b\d+\b/g)].map(m => Number(m[0]));
        if (numerosEnTexto.length > 1) {
            const coincidentes = numerosEnTexto
                .map(num => opciones.find(op => Number(op.numero) === num))
                .filter(Boolean);

            if (coincidentes.length > 1) {
                this.opcionesPorChat.delete(chatId);
                logger.info('WA_INPUT', 'Entrada traducida por multiples numeros', {
                    chatId,
                    texto,
                    coincidentes
                });
                return coincidentes.map(op => op.value).join(', ');
            }
        }

        const numeroHablado = numeroDesdeTextoOpcion(limpio);
        if (numeroHablado !== null) {
            const porNumero = opciones.find(opcion => Number(opcion.numero) === numeroHablado);
            if (porNumero) {
                this.opcionesPorChat.delete(chatId);
                logger.info('WA_INPUT', 'Entrada traducida por numero hablado', {
                    chatId,
                    texto,
                    numeroHablado,
                    opcion: porNumero
                });
                return porNumero.value;
            }
        }

        const porToken = buscarPorTokenUnico(limpio, opciones);
        if (porToken) {
            this.opcionesPorChat.delete(chatId);
            logger.info('WA_INPUT', 'Entrada traducida por token unico', {
                chatId,
                texto,
                opcion: porToken
            });
            return porToken.value;
        }

        const puntuadas = opciones
            .map(opcion => ({ opcion, score: puntuarCoincidenciaOpcion(limpio, opcion.title) }))
            .sort((a, b) => b.score - a.score);

        const mejor = puntuadas[0];
        const segunda = puntuadas[1];
        if (mejor && mejor.score >= 0.72 && (!segunda || mejor.score - segunda.score >= 0.12)) {
            this.opcionesPorChat.delete(chatId);
            logger.info('WA_INPUT', 'Entrada traducida por similitud', {
                chatId,
                texto,
                mejor
            });
            return mejor.opcion.value;
        }

        logger.warn('WA_INPUT', 'No se pudo traducir entrada contra opciones visibles', {
            chatId,
            texto,
            opciones,
            puntuadas: puntuadas.slice(0, 5)
        });
        return texto;
    }

    obtenerPistasAudio(chatId) {
        const opciones = this.opcionesPorChat.get(chatId);
        if (!opciones) return [];
        return opciones.map(opcion => String(opcion.title || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    }

    async enviarTexto(_accountId, chatId, texto) {
        logger.info('WA_OUT', 'Enviando texto a WhatsApp', {
            chatId,
            texto
        });
        return this.wa.sendMessage(chatId, texto);
    }

    async enviarDocumento(_accountId, chatId, { url, buffer, filename = 'Resultado.pdf', caption = '', mimetype = 'application/pdf' }) {
        logger.info('WA_OUT', 'Enviando documento PDF a WhatsApp', {
            chatId,
            filename,
            url: url || 'buffer'
        });
        let base64Data;
        if (buffer) {
            base64Data = Buffer.isBuffer(buffer) ? buffer.toString('base64') : String(buffer);
        } else if (url) {
            const respuesta = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 20000,
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            });
            base64Data = Buffer.from(respuesta.data).toString('base64');
        } else {
            throw new Error('No se proporcionó URL ni Buffer para el documento PDF');
        }

        const media = new MessageMedia(mimetype, base64Data, filename);
        return this.wa.sendMessage(chatId, media, {
            caption: caption || undefined,
            sendMediaAsDocument: true
        });
    }

    async enviarListaDesplegable(_accountId, chatId, texto, _label, items) {
        const opciones = items.map((item, index) => {
            const numero = String(index + 1);
            return {
                numero,
                title: item.title,
                value: item.value
            };
        });

        this.opcionesPorChat.set(chatId, opciones);
        logger.info('WA_OUT', 'Enviando lista a WhatsApp', {
            chatId,
            texto,
            opciones
        });

        const yaTieneOpciones = texto.includes('Selecciona una opción') || texto.includes('1️⃣') || /1[\.\-\)]\s+/.test(texto);
        const formatearOpcion = o => {
            const title = String(o.title || '').trim();
            if (/^[1-9]️⃣/.test(title)) return title;
            const sinPrefijo = title.replace(/^\d+[\.\-\)]\s*/, '');
            return `${o.numero}. ${sinPrefijo}`;
        };

        const mensajeFinal = yaTieneOpciones
            ? `${texto}\n\nResponde con el número de la opción.`
            : `${texto}\n\n${opciones.map(formatearOpcion).join('\n')}\n\nResponde con el número de la opción.`;

        return this.wa.sendMessage(chatId, mensajeFinal);
    }

    async enviarBotones(_accountId, chatId, texto, botones) {
        const opciones = botones.map((boton, index) => {
            const numero = String(index + 1);
            return {
                numero,
                title: boton.title,
                value: boton.value
            };
        });

        this.opcionesPorChat.set(chatId, opciones);
        logger.info('WA_OUT', 'Enviando botones a WhatsApp', {
            chatId,
            texto,
            opciones
        });

        const yaTieneOpciones = texto.includes('Selecciona una opción') || texto.includes('1️⃣') || /1[\.\-\)]\s+/.test(texto);
        const formatearOpcion = o => {
            const title = String(o.title || '').trim();
            if (/^[1-9]️⃣/.test(title)) return title;
            const sinPrefijo = title.replace(/^\d+[\.\-\)]\s*/, '');
            return `${o.numero}. ${sinPrefijo}`;
        };

        const mensajeFinal = yaTieneOpciones
            ? `${texto}\n\nResponde con el número de la opción.`
            : `${texto}\n\n${opciones.map(formatearOpcion).join('\n')}\n\nResponde con el número de la opción.`;

        return this.wa.sendMessage(chatId, mensajeFinal);
    }

    async crearNotaPrivada(_accountId, chatId, texto) {
        logger.info('WA_OUT', 'Nota privada simulada en WhatsApp test', {
            chatId,
            texto
        });
        console.log(`[NOTA PRIVADA][${chatId}] ${texto}`);
    }
}

const wa = new Client({
    authStrategy: new LocalAuth({ clientId: 'napoles-test-v2' }),
    puppeteer: crearOpcionesPuppeteer(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

const cacheSucursales = new CacheSucursales(
    CONFIG.SUCURSALES_DATA_URL,
    CONFIG.CACHE_TTL
);
const gestorEstados = new GestorEstados();
const gestorBD = new GestorBaseDatos(CONFIG.DB);
const geoService = new GeoService(CONFIG.CP_SHAPEFILE_BASE);
const catalogoService = new CatalogoService(null, undefined, gestorBD, {
    fechaTopDesde: CONFIG.TOP_STUDIES_FROM,
    limiteTop: CONFIG.TOP_STUDIES_LIMIT
});
const speechService = new SpeechService(CONFIG.SPEECH);
const ocrService = new OcrService(CONFIG.OCR);
const flowDefinition = new FlowDefinitionService(CONFIG.CHATBOT_FLOW_PATH, {
    variables: { Nombre: CONFIG.BOT_ASSISTANT_NAME }
});
const waAdapter = new WhatsAppTestClient(wa);

const manejador = new ManejadorComandos(
    waAdapter,
    cacheSucursales,
    gestorEstados,
    gestorBD,
    geoService,
    catalogoService,
    flowDefinition
);

wa.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

wa.on('ready', () => {
    logger.info('WA', 'WhatsApp test bot listo');
    console.log('WhatsApp test bot listo');

    if (CONFIG.NLU.enabled && CONFIG.NLU.precalentar) {
        // Carga el modelo en RAM ahora para que el primer paciente no pague el arranque en frio.
        manejador.llmClassifier.precalentar().then(ok => {
            console.log(ok
                ? `🧠 Ollama listo (${CONFIG.NLU.modelo}, modo ${CONFIG.NLU.modo})`
                : '🧠 Ollama no responde: el bot funciona sin IA');
        });
    }
});

wa.on('message', async msg => {
    try {
        logger.info('WA_IN', 'Mensaje recibido desde WhatsApp', {
            from: msg.from,
            fromMe: msg.fromMe,
            type: msg.type,
            hasMedia: msg.hasMedia,
            body: msg.body,
            isStatus: msg.isStatus
        });

        if (esChatIgnorado(msg)) {
            logger.debug('WA_IN', 'Mensaje ignorado por reglas de origen', {
                from: msg.from,
                type: msg.type
            });
            return;
        }

        let ubicacion = null;
        let textoMensaje = msg.body || '';

        if (msg.type === 'location' && msg.location) {
            ubicacion = {
                latitud: msg.location.latitude,
                longitud: msg.location.longitude
            };
            logger.info('WA_IN', 'Ubicacion recibida desde WhatsApp', {
                from: msg.from,
                ubicacion
            });
        }

        if (!ubicacion && esMensajeAudio(msg)) {
            logger.info('AUDIO', 'Audio recibido, iniciando transcripcion', {
                from: msg.from,
                id: msg.id?.id,
                type: msg.type
            });
            await wa.sendMessage(msg.from, 'Escuchando tu audio...');

            let transcripcion = null;
            try {
                const media = await msg.downloadMedia();
                transcripcion = await speechService.transcribirMedia(media, {
                    id: msg.id?.id,
                    chatId: msg.from,
                    initialPrompt: construirPromptAudio(waAdapter, msg.from)
                });
            } catch (errorAudio) {
                logger.error('AUDIO', 'Error transcribiendo audio', {
                    from: msg.from,
                    error: errorAudio.message
                });
                console.error('Error transcribiendo audio:', errorAudio.message);
            }

            if (!transcripcion) {
                logger.warn('AUDIO', 'Transcripcion vacia o no disponible', {
                    from: msg.from
                });
                await wa.sendMessage(msg.from, 'No pude transcribir el audio. Por favor intenta de nuevo o escribeme el mensaje.');
                return;
            }

            textoMensaje = transcripcion;
            logger.info('AUDIO', 'Audio transcrito', {
                from: msg.from,
                transcripcion
            });
            console.log(`[AUDIO][${msg.from}] ${transcripcion}`);
        }

        if (!ubicacion && esMensajeImagen(msg)) {
            logger.info('OCR', 'Imagen recibida, iniciando OCR', {
                from: msg.from,
                id: msg.id?.id,
                type: msg.type,
                caption: msg.body
            });
            await wa.sendMessage(msg.from, 'Leyendo tu imagen...');

            let textoOcr = null;
            try {
                const media = await msg.downloadMedia();
                textoOcr = await ocrService.extraerTextoMedia(media, {
                    id: msg.id?.id,
                    chatId: msg.from
                });
            } catch (errorOcr) {
                logger.error('OCR', 'Error procesando imagen con OCR', {
                    from: msg.from,
                    error: errorOcr.stack || errorOcr.message || String(errorOcr)
                });
                console.error('Error procesando OCR:', errorOcr.message);
            }

            if (!textoOcr) {
                logger.warn('OCR', 'OCR vacio o no disponible', {
                    from: msg.from
                });
                await wa.sendMessage(msg.from, 'No pude leer el folio en la imagen. Por favor intenta con otra imagen mas clara o escríbeme tu número de folio.');
                return;
            }

            textoMensaje = [textoMensaje, textoOcr].filter(Boolean).join('\n');
            logger.info('OCR', 'Texto OCR extraido', {
                from: msg.from,
                textoOcr,
                textoMensaje
            });
            console.log(`[OCR][${msg.from}]\n${textoOcr}`);
        }

        const texto = waAdapter.traducirEntrada(msg.from, textoMensaje);
        logger.info('WA_INPUT', 'Texto final enviado al orquestador', {
            from: msg.from,
            textoOriginal: textoMensaje,
            textoTraducido: texto,
            normalizado: normalizar(texto || ''),
            ubicacion
        });

        await manejador.procesarMensaje(
            'wa-test',
            msg.from,
            normalizar(texto || ''),
            texto || '',
            [],
            {
                ubicacion,
                telefono: msg.from
            }
        );
    } catch (error) {
        logger.error('WA_ERROR', 'Error procesando WhatsApp', {
            from: msg?.from,
            error: error.stack || error.message || String(error)
        });
        console.error('Error procesando WhatsApp:', error);
        if (esChatIgnorado(msg)) return;

        try {
            await wa.sendMessage(msg.from, 'Ocurrió un error controlado. Te canalizaremos con un asesor.');
        } catch (errorEnvio) {
            console.error('No se pudo enviar el mensaje de contingencia:', errorEnvio.message);
        }
    }
});

if (require.main === module) {
    validarConfiguracion(['DB_USER', 'DB_PASSWORD', 'DB_SERVER', 'DB_DATABASE']);

    wa.initialize().catch(error => {
        console.error('\n========== ERROR COMPLETO DE WHATSAPP ==========');
        console.error(error);
        console.error('\n========== STACK TRACE ==========');
        console.error(error?.stack || 'Sin stack trace');
        console.error('===============================================\n');

        mostrarAyudaErrorNavegador(error);
        process.exit(1);
    });
}

module.exports = { WhatsAppTestClient, crearOpcionesPuppeteer, esChatIgnorado, esMensajeAudio, esMensajeImagen };