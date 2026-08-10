class ResultadosService {
    constructor(apiClient, db, portalUrl) {
        this.api = apiClient;
        this.db = db;
        this.portalUrl = portalUrl;
    }

    async buscar({ metodo, valor }) {
        if (this.api?.disponible()) {
            const data = await this.api.get('/resultados', { [metodo]: valor });
            return this.normalizarResultado(data, metodo, valor);
        }

        if (metodo === 'folio' && this.db?.obtenerLinkResultados) {
            const datos = await this.db.obtenerLinkResultados(valor);
            if (!datos) return null;
            return this.normalizarResultado(datos, metodo, valor);
        }

        throw new Error('Consulta de resultados no configurada para este método');
    }

    normalizarResultado(data, metodo, valor) {
        if (!data) return null;

        const registro = Array.isArray(data) ? data[0] : (data.resultado || data.data || data);
        if (!registro) return null;

        const estatus = Number(registro.estatus ?? registro.Estatus ?? registro.status ?? registro.IdEstatus);
        const link = registro.link || registro.LinkDescarga || registro.url || registro.pdfUrl || registro.pdf_url || null;
        const disponible = Boolean(
            registro.disponible ??
            registro.liberado ??
            registro.resultadosDisponibles ??
            (estatus >= 5 && estatus <= 9 && link)
        );

        return {
            metodo,
            valor,
            disponible,
            link,
            portalUrl: registro.portalUrl || registro.portal_url || this.portalUrl,
            estatus: Number.isFinite(estatus) ? estatus : null,
            paciente: registro.paciente || registro.Paciente || registro.nombrePaciente || null,
            sucursal: registro.sucursal || registro.Sucursal || null,
            fecha: registro.fecha || registro.Fecha || registro.fechaRecepcion || null,
            folio: registro.folio || registro.Folio || valor,
            mensaje: registro.mensaje || registro.observaciones || null
        };
    }
}

module.exports = ResultadosService;
