const { ESTADOS } = require('../config');
const { normalizar } = require('../utils/helpers');
const logger = require('../services/logger');

class FlujoResultados {
    constructor(client, estados, db, flowDefinition = null) {
        this.client = client;
        this.estados = estados;
        this.db = db;
        this.flow = flowDefinition;
    }

    async iniciar(accountId, conversationId) {
        logger.info('RESULTADOS', 'Iniciando flujo de resultados', {
            accountId,
            conversationId
        });
        this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
            metodoBusqueda: 'folio',
            datoBusqueda: null,
            resultadoConsulta: null,
            intentos: 0
        });

        return this.client.enviarTexto(
            accountId,
            conversationId,
            'Con gusto te ayudamos a consultar tus resultados.\n\nPor favor comparte foto de tu recibo o número de folio\n\n1️⃣ Hablar con un asesor'
        );
    }

    async manejarMetodoBusqueda(accountId, conversationId, mensaje, transferirAAgente) {
        const opcion = normalizar(mensaje);
        logger.info('RESULTADOS', 'Metodo de busqueda recibido', {
            accountId,
            conversationId,
            mensaje,
            opcion
        });

        if (['4', 'asesor', 'hablar con asesor'].includes(opcion) || opcion.includes('asesor')) {
            logger.info('RESULTADOS', 'Usuario eligio asesor en metodo de busqueda', {
                conversationId
            });
            return transferirAAgente();
        }

        const metodo = this.resolverMetodoBusqueda(opcion);
        if (!metodo) {
            logger.warn('RESULTADOS', 'Metodo de busqueda invalido', {
                conversationId,
                mensaje,
                opcion
            });
            return this.client.enviarTexto(
                accountId,
                conversationId,
                this.textoFallback(
                    '4.2',
                    'Puedes usar folio, expediente o telefono registrado. Si necesitas ayuda, escribe asesor.'
                )
            );
        }

        this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
            metodoBusqueda: metodo,
            datoBusqueda: null,
            resultadoConsulta: null,
            intentos: 0
        });
        logger.info('RESULTADOS', 'Metodo de busqueda aceptado', {
            conversationId,
            metodo
        });

        return this.client.enviarTexto(accountId, conversationId, this.mensajeSolicitudDato(metodo));
    }

    async manejarDatoBusqueda(accountId, conversationId, dato) {
        const estadoActual = this.estados.obtener(conversationId);
        const valor = String(dato || '').trim();
        const valorNorm = normalizar(valor);
        let intentos = estadoActual.datos?.intentos || 0;
        logger.info('RESULTADOS', 'Dato de busqueda recibido', {
            accountId,
            conversationId,
            valor,
            intentos
        });

        // Si el usuario elige hablar con asesor
        if (['1', 'asesor', 'hablar con un asesor', 'hablar con asesor'].includes(valorNorm) || valorNorm.includes('asesor')) {
            logger.info('RESULTADOS', 'Usuario eligio asesor desde resultados', {
                conversationId
            });
            // Delegamos al estado MENU para que commands.js lo maneje
            this.estados.actualizar(conversationId, ESTADOS.MENU);
            return this.client.enviarTexto(accountId, conversationId, "Escribe *asesor* y te canalizaremos con nuestro equipo de atención.");
        }

        // Intentar extraer folio del texto (puede venir de OCR)
        // 1. Buscar patrón "Folio:" o "Folio :" seguido del número
        const folioLabelMatch = valor.match(/folio\s*[:.]?\s*(\d+)/i);
        // 2. Si no hay etiqueta, buscar secuencia de 5+ dígitos
        const folioDigitMatch = !folioLabelMatch ? valor.match(/(\d{5,})/) : null;
        // 3. Si el usuario escribió solo números
        const folioDirecto = (!folioLabelMatch && !folioDigitMatch && /^\d+$/.test(valor)) ? valor : null;
        const folio = folioLabelMatch ? folioLabelMatch[1] : (folioDigitMatch ? folioDigitMatch[1] : folioDirecto);

        if (!folio) {
            if (intentos === 0) {
                logger.warn('RESULTADOS', 'No se detecto folio, primer intento', {
                    conversationId,
                    valor
                });
                this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
                    intentos: 1
                });
                return this.client.enviarTexto(accountId, conversationId, 'No pudimos detectar un número de folio. Por favor ingresa solo los números de tu folio o envía una foto más clara de tu recibo.');
            }

            logger.warn('RESULTADOS', 'Folio invalido, reiniciando resultados', {
                conversationId,
                valor
            });
            return this.reiniciarResultados(accountId, conversationId);
        }

        return this.consultarPorFolio(accountId, conversationId, folio);
    }

    async manejarConsultaResultados(accountId, conversationId, folio) {
        this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
            metodoBusqueda: 'folio',
            intentos: this.estados.obtener(conversationId).datos?.intentos || 0
        });
        return this.manejarDatoBusqueda(accountId, conversationId, folio);
    }

    async consultarPorFolio(accountId, conversationId, folio) {
        try {
            logger.info('RESULTADOS', 'Consultando resultados por folio', {
                accountId,
                conversationId,
                folio
            });
            const datos = await this.db.obtenerLinkResultados(folio);
            if (!datos) {
                logger.warn('RESULTADOS', 'Folio sin resultados', {
                    conversationId,
                    folio
                });
                return this.manejarResultadoNoEncontrado(accountId, conversationId, folio);
            }

            const resultado = {
                folio,
                link: datos.link,
                estatus: Number(datos.estatus),
                disponible: Number(datos.estatus) >= 5 && Number(datos.estatus) <= 9
            };
            logger.info('RESULTADOS', 'Resultado de folio interpretado', {
                conversationId,
                resultado
            });

            this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ACCION, {
                metodoBusqueda: 'folio',
                datoBusqueda: folio,
                resultadoConsulta: resultado,
                accionResultados: resultado.disponible ? 'resultado_disponible' : 'resultado_pendiente',
                intentos: 0
            });

            if (resultado.disponible) {
                return this.client.enviarTexto(accountId, conversationId, this.formatearResultadoDisponible(resultado));
            }

            return this.client.enviarTexto(accountId, conversationId, this.formatearResultadoPendiente(resultado));
        } catch (error) {
            logger.error('RESULTADOS', 'Error consultando resultados', {
                conversationId,
                folio,
                error: error.stack || error.message || String(error)
            });
            console.error('Error consultando resultados:', error.message);
            return this.reiniciarResultados(accountId, conversationId);
        }
    }

    async manejarAccionResultados(accountId, conversationId, mensaje, acciones) {
        const opcion = normalizar(mensaje);
        const estadoActual = this.estados.obtener(conversationId);
        const resultado = estadoActual.datos?.resultadoConsulta;
        const accionResultados = estadoActual.datos?.accionResultados;
        logger.info('RESULTADOS', 'Accion sobre resultados recibida', {
            accountId,
            conversationId,
            mensaje,
            opcion,
            accionResultados,
            resultado
        });

        if (accionResultados === 'post_descarga') {
            if (['1', 'consultar otro', 'consultar otro resultado', 'otro resultado'].includes(opcion)) {
                return this.iniciar(accountId, conversationId);
            }
            if (['2', 'asesor', 'hablar con asesor'].includes(opcion) || opcion.includes('asesor')) {
                return acciones.transferirAAgente();
            }
            if (['3', 'finalizar', 'finalizar consulta', 'no', 'gracias'].includes(opcion)) {
                return this.finalizarConsultaResultados(accountId, conversationId);
            }
            return this.client.enviarTexto(accountId, conversationId, this.textoFlujo(
                '4.2.1.B.1',
                '¿Necesitas algo mas?\n1. Consultar otro resultado\n2. Hablar con un asesor\n3. Finalizar consulta'
            ));
        }

        if (!resultado?.disponible) {
            if (['1', 'asesor', 'hablar con asesor'].includes(opcion) || opcion.includes('asesor')) {
                return acciones.transferirAAgente();
            }
            if (['2', 'consultar otro', 'consultar otro folio', 'otro folio', 'otro resultado'].includes(opcion)) {
                return this.iniciar(accountId, conversationId);
            }
            if (['3', 'finalizar', 'finalizar consulta', 'no', 'gracias'].includes(opcion)) {
                return this.finalizarConsultaResultados(accountId, conversationId);
            }
            return this.client.enviarTexto(accountId, conversationId, this.textoFlujo(
                '4.2.1 A',
                '¿Cómo deseas continuar?\n1. Hablar con un asesor\n2. Consultar otro folio\n3. Finalizar consulta'
            ));
        }

        if (['1', 'descargar', 'descargar pdf'].includes(opcion) && resultado?.disponible) {
            this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ACCION, {
                accionResultados: 'post_descarga'
            });
            await this.enviarPdfResultado(accountId, conversationId, resultado);
            return this.client.enviarTexto(accountId, conversationId, this.textoFlujo(
                '4.2.1.B.1',
                '¿Necesitas algo mas?\n1. Consultar otro resultado\n2. Hablar con un asesor\n3. Finalizar consulta'
            ));
        }

        if (['2', 'portal', 'portal salud'].includes(opcion) && resultado?.disponible) {
            return this.client.enviarTexto(accountId, conversationId, this.textoFlujo(
                '4.2.1.B.2',
                'Puedes consultar y descargar tus resultados desde Portal Salud.\n\nhttps://portal.labnapoles.mx'
            ));
        }

        if (['3', 'asesor', 'hablar con asesor'].includes(opcion) || opcion.includes('asesor')) {
            return acciones.transferirAAgente();
        }

        return acciones.mostrarMenu();
    }

    async finalizarConsultaResultados(accountId, conversationId) {
        logger.info('RESULTADOS', 'Finalizando consulta de resultados', {
            accountId,
            conversationId
        });
        await this.client.enviarTexto(accountId, conversationId, this.textoFlujo(
            '4.2.1 A.1 y 4.2.1.B.1.1',
            'Hemos finalizado tu consulta de resultados. Gracias por comunicarte con Laboratorios Napoles.'
        ));
        this.estados.reiniciar(conversationId);
    }

    async manejarResultadoNoEncontrado(accountId, conversationId, folio) {
        const estadoActual = this.estados.obtener(conversationId);
        const intentos = estadoActual.datos?.intentos || 0;
        logger.warn('RESULTADOS', 'Manejando resultado no encontrado', {
            accountId,
            conversationId,
            folio,
            intentos
        });

        if (intentos === 0) {
            this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
                intentos: 1
            });
            return this.client.enviarTexto(
                accountId,
                conversationId,
                `No encontramos resultados para el folio *${folio}*. Intentalo de nuevo o escribe asesor.`
            );
        }

        return this.reiniciarResultados(accountId, conversationId);
    }

    async reiniciarResultados(accountId, conversationId) {
        logger.info('RESULTADOS', 'Reiniciando flujo de resultados', {
            accountId,
            conversationId
        });
        this.estados.actualizar(conversationId, ESTADOS.RESULTADOS_ESPERANDO_DATO, {
            metodoBusqueda: 'folio',
            datoBusqueda: null,
            resultadoConsulta: null,
            intentos: 0
        });
        return this.client.enviarTexto(
            accountId,
            conversationId,
            'No pudimos confirmar la información.\n\nPor favor comparte foto de tu recibo o número de folio\n\n1️⃣ Hablar con un asesor'
        );
    }

    resolverMetodoBusqueda(opcion) {
        if (['1', 'folio', 'numero de folio'].includes(opcion) || opcion.includes('folio')) return 'folio';
        if (['2', 'expediente', 'numero de expediente'].includes(opcion) || opcion.includes('expediente')) return 'expediente';
        if (['3', 'telefono', 'celular', 'numero celular registrado'].includes(opcion) || opcion.includes('telefono') || opcion.includes('celular')) return 'telefono';
        return null;
    }

    validarDatoBusqueda(metodo, valor) {
        if (!valor) return false;
        if (metodo === 'folio' || metodo === 'expediente') return /^\d+$/.test(valor);
        if (metodo === 'telefono') return valor.replace(/\D/g, '').length >= 10;
        return false;
    }

    mensajeSolicitudDato(metodo) {
        if (metodo === 'folio') {
            return 'Por favor, ingresa el folio de tu recibo de pago.\nEjemplo: 0265964';
        }
        if (metodo === 'expediente') {
            return 'Por favor, ingresa tu numero de expediente.';
        }
        return 'Por favor, ingresa el numero celular registrado a 10 digitos.';
    }

    mensajeDatoInvalido(metodo) {
        if (metodo === 'telefono') {
            return 'El telefono debe contener al menos 10 digitos. Intentalo nuevamente.';
        }
        return 'El dato debe contener solo numeros. Intentalo nuevamente.';
    }

    formatearResultadoDisponible(resultado) {
        return [
            '🧪 Tus resultados ya están disponibles.',
            '',
            `🧾 Folio: ${resultado.folio}`,
            '',
            '¿Cómo deseas consultarlos?',
            '',
            '1️⃣ Descargar PDF',
            '2️⃣ Acceder al Portal Salud',
            '3️⃣ Hablar con un asesor'
        ].join('\n');
    }

    formatearResultadoPendiente(resultado) {
        return [
            '🧪 Encontramos información relacionada con tu solicitud:',
            '',
            `🧾 Folio: ${resultado.folio}`,
            '',
            '⏳ Tus resultados aún se encuentran en proceso de validación.',
            '',
            'El tiempo de entrega puede variar según el tipo de estudio solicitado.',
            '',
            '¿Cómo deseas continuar?',
            '',
            '1️⃣ Hablar con un asesor',
            '2️⃣ Consultar otro folio',
            '3️⃣ Finalizar consulta'
        ].join('\n');
    }

    formatearDescarga(resultado) {
        return [
            '📄 Tus resultados están listos para descarga.',
            '',
            `🔗 Descargar resultados: ${resultado.link}`,
            '',
            '⚠️ Por seguridad, este enlace puede expirar después de un tiempo determinado.'
        ].join('\n');
    }

    async enviarPdfResultado(accountId, conversationId, resultado) {
        if (!resultado?.link) {
            logger.warn('RESULTADOS', 'No hay enlace para enviar PDF', { accountId, conversationId });
            return this.client.enviarTexto(accountId, conversationId, this.formatearDescarga(resultado));
        }

        if (typeof this.client?.enviarDocumento === 'function') {
            try {
                const filename = `Resultado_Folio_${resultado.folio || 'Estudio'}.pdf`;
                const caption = '📄 Tus resultados están listos para descarga.';
                await this.client.enviarDocumento(accountId, conversationId, {
                    url: resultado.link,
                    filename,
                    caption,
                    mimetype: 'application/pdf'
                });
                return;
            } catch (error) {
                logger.error('RESULTADOS', 'Error enviando documento PDF directo, usando enlace en texto como fallback', {
                    accountId,
                    conversationId,
                    error: error.message
                });
            }
        }

        await this.client.enviarTexto(accountId, conversationId, this.formatearDescarga(resultado));
    }

    textoFlujo(stepId, fallback, variables = {}) {
        try {
            const texto = this.flow?.respuesta(stepId, variables);
            return texto || fallback;
        } catch (_error) {
            return fallback;
        }
    }

    textoFallback(stepId, fallback, variables = {}) {
        try {
            const texto = this.flow?.fallback(stepId, variables);
            return texto || fallback;
        } catch (_error) {
            return fallback;
        }
    }
}

module.exports = FlujoResultados;
