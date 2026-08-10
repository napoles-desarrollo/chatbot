const axios = require('axios');
const logger = require('./logger');

class ChatwootClient {
    constructor(url, token) { 
        this.apiUrl = url; 
        this.token = token; 
    }

    async enviarMensaje(aid, cid, payload) {
        logger.info('CHATWOOT_OUT', 'Enviando mensaje a Chatwoot', {
            accountId: aid,
            conversationId: cid,
            payload
        });
        console.log("🚀 ENVIANDO A CHATWOOT:", JSON.stringify(payload, null, 2));
        try {
            const respuesta = await axios.post(`${this.apiUrl}/accounts/${aid}/conversations/${cid}/messages`, payload, {
                headers: { 'api_access_token': this.token }
            });
            logger.debug('CHATWOOT_OUT', 'Respuesta Chatwoot', {
                accountId: aid,
                conversationId: cid,
                status: respuesta.status,
                data: respuesta.data
            });
        } catch (e) {
            logger.error('CHATWOOT_OUT', 'Error API Chatwoot', {
                accountId: aid,
                conversationId: cid,
                error: e.response ? e.response.data : e.message
            });
            console.error(`❌ Error API Chatwoot: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
        }
    }

    /**
     * Llamada generica a la API de Chatwoot. Nunca lanza: si un endpoint no existe en
     * esta version o el token no tiene permisos, se registra y la conversacion sigue.
     * Verificado en developers.chatwoot.com:
     *   POST /accounts/{aid}/conversations/{cid}/toggle_status  { status }
     *   POST /accounts/{aid}/conversations/{cid}/assignments    { assignee_id | team_id }
     */
    async peticion(metodo, ruta, payload, contexto) {
        try {
            const respuesta = await axios({
                method: metodo,
                url: `${this.apiUrl}${ruta}`,
                data: payload,
                headers: { 'api_access_token': this.token }
            });
            logger.debug('CHATWOOT_API', 'Llamada correcta', { contexto, ruta, status: respuesta.status });
            return respuesta.data;
        } catch (e) {
            logger.error('CHATWOOT_API', 'Llamada fallida', {
                contexto,
                ruta,
                error: e.response ? e.response.data : e.message
            });
            return null;
        }
    }

    /**
     * Devuelve la conversacion a la cola humana. Sin esto el bot avisa al paciente de
     * que "un asesor se pondra en contacto" pero Chatwoot nunca se entera: la
     * conversacion sigue en manos del bot y ningun agente recibe notificacion.
     */
    async abrirParaHumano(aid, cid, { teamId = null, assigneeId = null } = {}) {
        await this.peticion('post', `/accounts/${aid}/conversations/${cid}/toggle_status`,
            { status: 'open' }, 'abrir para humano');

        if (assigneeId || teamId) {
            await this.peticion('post', `/accounts/${aid}/conversations/${cid}/assignments`,
                assigneeId ? { assignee_id: Number(assigneeId) } : { team_id: Number(teamId) },
                'asignar conversacion');
        }
        return true;
    }

    /** Marca la conversacion como atendida por el bot (fuera de la bandeja activa). */
    async marcarAtendidaPorBot(aid, cid) {
        return this.peticion('post', `/accounts/${aid}/conversations/${cid}/toggle_status`,
            { status: 'pending' }, 'marcar pendiente');
    }

    async enviarTexto(aid, cid, txt) {
        return this.enviarMensaje(aid, cid, { content: txt, message_type: "outgoing" });
    }

    async enviarListaDesplegable(aid, cid, txt, label, items) {
        const textoBoton = (label || "Ver opciones").substring(0, 20);

        const itemsFormateados = items.map(item => ({
            title: String(item.title).substring(0, 24),
            value: String(item.value || item.id)
        }));

        return this.enviarMensaje(aid, cid, {
            content: txt,
            message_type: "outgoing",
            content_type: "input_select",
            content_attributes: {
                items: itemsFormateados,
                label: textoBoton,
                button_text: textoBoton
            }
        });
    }

    // ✅ ESTA ES LA FUNCIÓN QUE FALTABA
    async enviarBotones(aid, cid, txt, botones) {
        return this.enviarMensaje(aid, cid, {
            content: txt,
            message_type: "outgoing",
            content_type: "input_select",
            content_attributes: {
                // WhatsApp convierte listas de <= 3 items en botones si no llevan "label"
                // O usamos el formato explícito de botones si tu bridge lo soporta
                items: botones.map(b => ({ 
                    title: b.title.substring(0, 20), 
                    value: b.value 
                }))
            }
        });
    }

    async crearNotaPrivada(aid, cid, txt) {
        return this.enviarMensaje(aid, cid, {
            content: txt,
            private: true,
            message_type: "outgoing"
        });
    }

    async enviarDocumento(aid, cid, { url, filename, caption }) {
        const contenido = caption
            ? `${caption}\n\n📄 Documento: ${filename}\n🔗 Enlace de descarga: ${url}`
            : `📄 Documento: ${filename}\n🔗 Enlace de descarga: ${url}`;
        return this.enviarTexto(aid, cid, contenido);
    }
}

module.exports = ChatwootClient;
