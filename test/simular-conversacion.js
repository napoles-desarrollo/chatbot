// Conversa con el bot REAL desde la terminal: mismo orquestador, mismo SQL,
// mismas sucursales y el mismo clasificador que usa WhatsApp. Lo unico simulado
// es el transporte (en vez de WhatsApp, la consola).
//
//   node test/simular-conversacion.js                 -> guion de ejemplo
//   node test/simular-conversacion.js --interactivo   -> escribes tu
//   node test/simular-conversacion.js "hola" "1" "cuanto cuesta la bh"

// Silenciar el log de depuracion: aqui queremos LEER la conversacion.
process.env.CHATBOT_DEBUG = process.env.CHATBOT_DEBUG || 'false';
process.env.CHATBOT_DEBUG_VERBOSE = 'false';

const readline = require('readline');
const { CONFIG } = require('../src/config');
const CacheSucursales = require('../src/services/sucursales');
const GestorEstados = require('../src/services/state');
const GestorBaseDatos = require('../src/services/database');
const GeoService = require('../src/services/geo');
const CatalogoService = require('../src/services/catalogo');
const FlowDefinitionService = require('../src/services/flowDefinition');
const LLMClassifier = require('../src/services/llmClassifier');
const ManejadorComandos = require('../src/handlers/commands');
const { normalizar } = require('../src/utils/helpers');

const CHAT = 'simulador';
const gris = t => `\x1b[90m${t}\x1b[0m`;
const azul = t => `\x1b[36m${t}\x1b[0m`;
const verde = t => `\x1b[32m${t}\x1b[0m`;

// Reproduce lo que hace wa-test.js: numera las opciones y traduce el numero
// que responde el usuario al "value" que espera el orquestador.
class ClienteConsola {
    constructor() {
        this.opciones = new Map();
        this.enviados = 0;
    }

    traducir(texto) {
        const limpio = String(texto || '').trim();
        const ops = this.opciones.get(CHAT);
        if (!ops || ops.length === 0) return texto;
        const directa = ops.find(o => o.numero === limpio || normalizar(o.value) === normalizar(limpio));
        if (directa) { this.opciones.delete(CHAT); return directa.value; }
        return texto;
    }

    async enviarTexto(_a, _c, txt) {
        this.enviados += 1;
        console.log(`\n${azul('BOT')} ${txt}`);
    }

    async enviarBotones(_a, _c, txt, botones) {
        this.registrar(botones);
        this.enviados += 1;
        console.log(`\n${azul('BOT')} ${txt}`);
        botones.forEach((b, i) => console.log(gris(`      [${i + 1}] ${b.title}`)));
    }

    async enviarListaDesplegable(_a, _c, txt, _label, items) {
        this.registrar(items);
        this.enviados += 1;
        console.log(`\n${azul('BOT')} ${txt}`);
        items.forEach((it, i) => console.log(gris(`      [${i + 1}] ${it.title}`)));
    }

    async enviarDocumento(_a, _c, { filename, url }) {
        this.enviados += 1;
        console.log(`\n${azul('BOT')} [documento] ${filename} ← ${String(url).slice(0, 60)}...`);
    }

    async crearNotaPrivada(_a, _c, txt) {
        console.log(gris(`      (nota interna para el asesor: ${txt})`));
    }

    registrar(items) {
        this.opciones.set(CHAT, items.map((it, i) => ({
            numero: String(i + 1), title: it.title, value: it.value
        })));
    }
}

function construir() {
    const cliente = new ClienteConsola();
    const cache = new CacheSucursales(CONFIG.SUCURSALES_DATA_URL, CONFIG.CACHE_TTL);
    const estados = new GestorEstados();
    const bd = new GestorBaseDatos(CONFIG.DB);
    const geo = new GeoService(CONFIG.CP_SHAPEFILE_BASE);
    const catalogo = new CatalogoService(null, undefined, bd, {
        fechaTopDesde: CONFIG.TOP_STUDIES_FROM,
        limiteTop: CONFIG.TOP_STUDIES_LIMIT
    });
    const flow = new FlowDefinitionService(CONFIG.CHATBOT_FLOW_PATH, {
        variables: { Nombre: CONFIG.BOT_ASSISTANT_NAME }
    });
    const clasificador = new LLMClassifier(CONFIG.NLU);
    const manejador = new ManejadorComandos(cliente, cache, estados, bd, geo, catalogo, flow, clasificador);
    return { cliente, manejador, estados, clasificador };
}

async function decir(ctx, texto) {
    console.log(`\n${verde('TÚ ')} ${texto}`);
    const traducido = ctx.cliente.traducir(texto);
    const inicio = Date.now();
    try {
        await ctx.manejador.procesarMensaje(
            'sim', CHAT, normalizar(traducido || ''), traducido || '', [], { telefono: '9931234567' }
        );
    } catch (error) {
        console.log(`\n\x1b[31mEXCEPCION SIN CONTROLAR\x1b[0m ${error.message}`);
    }
    const ms = Date.now() - inicio;
    const estado = ctx.estados.obtener(CHAT).estado;
    console.log(gris(`      ── ${ms} ms · estado: ${estado}`));
}

const GUION = [
    'hola', '86000', '1', '1', 'cuanto cuesta la bh y la quimica sanguinea',
    '1,2', '2', '2', '0265964', 'menu', 'a que hora abren', 'inicio'
];

(async () => {
    const ctx = construir();
    if (CONFIG.NLU.enabled) {
        process.stdout.write(gris('Precargando el modelo... '));
        console.log(gris(await ctx.clasificador.precalentar() ? 'listo' : 'no disponible'));
    }

    const args = process.argv.slice(2).filter(a => a !== '--interactivo');
    const interactivo = process.argv.includes('--interactivo');
    const guion = args.length ? args : (interactivo ? [] : GUION);

    for (const mensaje of guion) await decir(ctx, mensaje);

    if (!interactivo) {
        console.log(gris(`\n── fin del guion · ${ctx.cliente.enviados} mensajes del bot ──\n`));
        return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const preguntar = () => rl.question('\nTÚ  ', async texto => {
        if (['salir', 'exit', 'q'].includes(texto.trim().toLowerCase())) return rl.close();
        await decir(ctx, texto);
        preguntar();
    });
    preguntar();
})();
