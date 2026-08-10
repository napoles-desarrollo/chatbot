const express = require('express');
const { CONFIG, validarConfiguracion } = require('./config');
const { normalizar } = require('./utils/helpers');
const logger = require('./services/logger');

try {
    validarConfiguracion([
        'CHATWOOT_BOT_TOKEN',
        'DB_USER',
        'DB_PASSWORD',
        'DB_SERVER',
        'DB_DATABASE'
    ]);
} catch (error) {
    console.error('\nNo se pudo iniciar el webhook de Chatwoot.');
    console.error(error.message);
    console.error('\nAhora estamos probando el flujo sin Chatwoot.');
    console.error('Usa: npm start');
    console.error('O usa: node src/wa-test.js');
    console.error('\nCuando regreses a Chatwoot, llena CHATWOOT_BOT_TOKEN y ejecuta: npm run start:chatwoot\n');
    process.exit(1);
}

// Importamos Servicios
const CacheSucursales = require('./services/sucursales');
const GestorEstados = require('./services/state');
const GestorBaseDatos = require('./services/database');
const ChatwootClient = require('./services/chatwoot');
const GeoService = require('./services/geo');
const CatalogoService = require('./services/catalogo');
const FlowDefinitionService = require('./services/flowDefinition');

// Importamos Handler (El orquestador que dividimos)
const ManejadorComandos = require('./handlers/commands');

const app = express();
app.use(express.json());

// Inicialización de Servicios
const cacheSucursales = new CacheSucursales(
    CONFIG.SUCURSALES_DATA_URL,
    CONFIG.CACHE_TTL
);
const gestorEstados = new GestorEstados();
const gestorBD = new GestorBaseDatos(CONFIG.DB);
const chatwootClient = new ChatwootClient(CONFIG.CHATWOOT_API_URL, CONFIG.BOT_TOKEN);
const geoService = new GeoService(CONFIG.CP_SHAPEFILE_BASE);
const catalogoService = new CatalogoService(null, undefined, gestorBD, {
    fechaTopDesde: CONFIG.TOP_STUDIES_FROM,
    limiteTop: CONFIG.TOP_STUDIES_LIMIT
});
const flowDefinition = new FlowDefinitionService(CONFIG.CHATBOT_FLOW_PATH, {
    variables: { Nombre: CONFIG.BOT_ASSISTANT_NAME }
});

// Inicialización del Manejador con sus 4 flujos internos
const manejadorComandos = new ManejadorComandos(
    chatwootClient,
    cacheSucursales,
    gestorEstados,
    gestorBD,
    geoService,
    catalogoService,
    flowDefinition
);

function normalizarTelefono(valor) {
    return String(valor || "").replace(/\D/g, "");
}

function obtenerEtiquetas(conversation) {
    return (conversation?.labels || [])
        .map(label => {
            if (typeof label === 'string') return label;
            return label?.title || label?.name || label?.label || "";
        })
        .map(label => normalizar(label))
        .filter(Boolean);
}

function obtenerTelefonoWebhook(body) {
    const conversation = body.conversation || {};
    const candidatos = [
        body.contact?.phone_number,
        body.sender?.phone_number,
        conversation.meta?.sender?.phone_number,
        conversation.meta?.sender?.identifier,
        conversation.sender?.phone_number,
        conversation.contact_inbox?.contact?.phone_number,
        conversation.additional_attributes?.phone_number
    ];

    return candidatos.map(normalizarTelefono).find(Boolean) || "";
}

function telefonoCoincide(telefono, bloqueado) {
    if (!telefono || !bloqueado) return false;
    return telefono === bloqueado || telefono.endsWith(bloqueado) || bloqueado.endsWith(telefono);
}

function debeSilenciarBotPorRegla(body, labels) {
    const etiquetasDesactivadas = (CONFIG.BOT_DISABLED_LABELS || []).map(normalizar);
    const telefonosDesactivados = (CONFIG.BOT_DISABLED_PHONES || []).map(normalizarTelefono).filter(Boolean);
    const etiquetaBloqueada = labels.find(label => etiquetasDesactivadas.includes(label));
    const telefono = obtenerTelefonoWebhook(body);
    const telefonoBloqueado = telefonosDesactivados.find(bloqueado => telefonoCoincide(telefono, bloqueado));

    if (etiquetaBloqueada || telefonoBloqueado) {
        return {
            activo: true,
            motivo: etiquetaBloqueada ? `etiqueta:${etiquetaBloqueada}` : `telefono:${telefonoBloqueado}`
        };
    }

    return { activo: false };
}

function coordenadaValida(latitud, longitud) {
    return Number.isFinite(latitud) &&
        Number.isFinite(longitud) &&
        latitud >= -90 &&
        latitud <= 90 &&
        longitud >= -180 &&
        longitud <= 180;
}

function obtenerUbicacionDesdeObjeto(obj, profundidad = 0) {
    if (!obj || typeof obj !== 'object' || profundidad > 5) return null;

    const latitud = Number(obj.latitude ?? obj.latitud ?? obj.lat);
    const longitud = Number(obj.longitude ?? obj.longitud ?? obj.lng ?? obj.lon);

    if (coordenadaValida(latitud, longitud)) {
        return { latitud, longitud };
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            const ubicacion = obtenerUbicacionDesdeObjeto(item, profundidad + 1);
            if (ubicacion) return ubicacion;
        }
        return null;
    }

    for (const valor of Object.values(obj)) {
        const ubicacion = obtenerUbicacionDesdeObjeto(valor, profundidad + 1);
        if (ubicacion) return ubicacion;
    }

    return null;
}

function obtenerUbicacionWebhook(body) {
    return obtenerUbicacionDesdeObjeto({
        content_attributes: body.content_attributes,
        attachments: body.attachments,
        message: body.message,
        content: body.content
    });
}

// Precarga de Datos de Sucursales
cacheSucursales.obtenerDatos().catch(e => console.error('⚠️ Error precarga:', e.message));

// Webhook Principal
app.post('/webhook', async (req, res) => {
    const { event, message_type, content, conversation, account, status } = req.body;
    
    // Extraemos etiquetas para el bloqueo de seguridad
    const labels = obtenerEtiquetas(conversation);
    logger.info('WEBHOOK_IN', 'Evento recibido desde Chatwoot', {
        event,
        message_type,
        status,
        accountId: account?.id,
        conversationId: conversation?.id,
        content,
        labels,
        telefono: obtenerTelefonoWebhook(req.body),
        ubicacion: obtenerUbicacionWebhook(req.body),
        body: req.body
    });

    // Validaciones básicas de integridad de datos
    if (!account?.id || !conversation?.id) {
        logger.warn('WEBHOOK_IN', 'Webhook sin account.id o conversation.id', {
            account,
            conversation
        });
        return res.status(400).send('error_datos');
    }

    try {
        // CASO 1: MENSAJE CREADO (Interacción del Usuario)
        if (event === "message_created") {
            // 1. Ignorar mensajes salientes (del bot o agentes)
            if (message_type === "outgoing") {
                logger.debug('WEBHOOK_ROUTE', 'Mensaje saliente ignorado', {
                    conversationId: conversation.id
                });
                return res.status(200).send('ignorado_saliente');
            }

            // 2. Reglas manuales para desactivar el bot por etiqueta o telefono
            const bloqueoBot = debeSilenciarBotPorRegla(req.body, labels);
            if (bloqueoBot.activo) {
                logger.info('WEBHOOK_ROUTE', 'Bot desactivado por regla manual', {
                    conversationId: conversation.id,
                    bloqueoBot
                });
                console.log(`[BOT] 🤫 Desactivado en conversación ${conversation.id} por ${bloqueoBot.motivo}`);
                return res.status(200).send('bot_desactivado');
            }

            // 3. Si hay un agente humano asignado, el bot se retira
            if (conversation.assignee_id) {
                logger.info('WEBHOOK_ROUTE', 'Bot se retira porque hay agente asignado', {
                    conversationId: conversation.id,
                    assigneeId: conversation.assignee_id
                });
                return res.status(200).send('agente_atendiendo');
            }

            // 4. Procesar lógica a través del orquestador modular
            const resultado = await manejadorComandos.procesarMensaje(
                account.id,
                conversation.id,
                normalizar(content || ""),
                content || "",
                labels,
                {
                    ubicacion: obtenerUbicacionWebhook(req.body),
                    telefono: obtenerTelefonoWebhook(req.body)
                }
            );

            // 5. Manejo de silencios (multimedia o etiquetas de bloqueo)
            if (resultado === "silence") return res.status(200).send('bot_silenciado');

            logger.info('WEBHOOK_OUT', 'Webhook procesado correctamente', {
                conversationId: conversation.id,
                resultado: resultado || 'ok'
            });
            return res.status(200).send('ok');
        }

        // CASO 2: CAMBIO DE ESTADO (Cierre de ticket)
        if (event === "conversation_status_changed") {
            if (status === "resolved") {
                logger.info('WEBHOOK_ROUTE', 'Conversacion resuelta, enviando despedida', {
                    conversationId: conversation.id
                });
                console.log(`🏁 Conversación ${conversation.id} resuelta. Enviando despedida.`);
                // Reinicia estado y muestra menú principal
                await manejadorComandos.manejarDespedida(account.id, conversation.id);
                return res.status(200).send('despedida_enviada');
            }
        }

        logger.debug('WEBHOOK_ROUTE', 'Evento ignorado', {
            event,
            conversationId: conversation.id
        });
        res.status(200).send('evento_ignorado');

    } catch (e) {
        logger.error('WEBHOOK_ERROR', 'Error controlado procesando webhook', {
            conversationId: conversation?.id,
            error: e.stack || e.message || String(e)
        });
        console.error('💥 Error Webhook:', e);
        // Respondemos 200 para evitar bucles de reintento de Chatwoot ante errores lógicos
        res.status(200).send('error_controlado');
    }
});

// Endpoint de Salud
app.get('/health', (req, res) => res.json({ 
    status: 'ok', 
    version: 'Modular 4 flujos',
    database: 'configured'
}));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Bot Laboratorios Napoles listo en puerto ${PORT}`);
    console.log(`🛡️  Arquitectura modular activa (Resultados, Sucursales, Cotización, Comandos).`);

    if (CONFIG.NLU.enabled && CONFIG.NLU.precalentar) {
        // Carga el modelo en RAM ahora para que el primer paciente no pague el arranque en frio.
        manejadorComandos.llmClassifier.precalentar().then(ok => {
            console.log(ok
                ? `🧠 Ollama listo (${CONFIG.NLU.modelo}, modo ${CONFIG.NLU.modo})`
                : '🧠 Ollama no responde: el bot funciona sin IA');
        });
    }
});
