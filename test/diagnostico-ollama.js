// Diagnostico de la cadena completa del clasificador. Ejecutar EN EL SERVIDOR donde corre el bot:
//   node test/diagnostico-ollama.js
// No toca la base de datos ni WhatsApp.

const { CONFIG } = require('../src/config');
const LLMClassifier = require('../src/services/llmClassifier');
const AliasEstudiosService = require('../src/services/aliasesEstudios');
const FlujoCotizacion = require('../src/handlers/flujoCotizacion');
const { normalizar } = require('../src/utils/helpers');

const ok = t => console.log(`  \x1b[32mOK\x1b[0m    ${t}`);
const mal = t => console.log(`  \x1b[31mFALLA\x1b[0m ${t}`);
const info = t => console.log(`        ${t}`);

const MENSAJE = process.argv.slice(2).join(' ') ||
    'prueba de azucar, RX AP y lateral de columna cervical, prueba para saber si estoy embarazada';

(async () => {
    console.log('\n══ 1. Configuración leída del .env ══\n');
    console.log(`  NLU_ENABLED  = ${CONFIG.NLU.enabled}`);
    console.log(`  NLU_MODO     = ${CONFIG.NLU.modo}`);
    console.log(`  OLLAMA_URL   = ${CONFIG.NLU.baseUrl}`);
    console.log(`  OLLAMA_MODEL = ${CONFIG.NLU.modelo}`);
    console.log(`  keep_alive   = ${CONFIG.NLU.keepAlive}`);
    console.log(`  timeout      = ${CONFIG.NLU.timeoutMs} ms\n`);

    if (!CONFIG.NLU.enabled) {
        mal('NLU_ENABLED no está en true. El bot funciona sin IA. Pon NLU_ENABLED=true y reinicia.');
        return;
    }
    ok('El clasificador está habilitado.');

    if (CONFIG.NLU.modo !== 'activo') {
        mal(`NLU_MODO=${CONFIG.NLU.modo}: consulta al modelo y lo registra, pero NO cambia la respuesta.`);
        info('Para que actúe: NLU_MODO=activo y reinicia el bot.');
    } else {
        ok('Modo activo: la IA puede rescatar términos.');
    }

    console.log('\n══ 2. ¿Se alcanza Ollama? ══\n');
    let modelos = [];
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(`${CONFIG.NLU.baseUrl}/api/tags`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        modelos = (await r.json()).models?.map(m => m.name) || [];
        ok(`Ollama responde en ${CONFIG.NLU.baseUrl}`);
        info(`Modelos instalados: ${modelos.join(', ') || '(ninguno)'}`);
    } catch (e) {
        mal(`No se pudo conectar: ${e.message}`);
        info('Causas típicas:');
        info('  · El bot corre en otra máquina (o en WSL) y OLLAMA_URL apunta a localhost.');
        info('  · Ollama solo escucha en 127.0.0.1. En el servidor Windows arráncalo así:');
        info('      setx OLLAMA_HOST 0.0.0.0   (y reinicia Ollama)');
        info('  · El firewall de Windows bloquea el puerto 11434.');
        return;
    }

    if (modelos.length && !modelos.some(m => m === CONFIG.NLU.modelo || m.startsWith(`${CONFIG.NLU.modelo}:`))) {
        mal(`El modelo "${CONFIG.NLU.modelo}" no aparece instalado.`);
        info(`Instálalo con: ollama pull ${CONFIG.NLU.modelo}`);
    } else {
        ok(`El modelo "${CONFIG.NLU.modelo}" está disponible.`);
    }

    console.log('\n══ 3. Términos que se extraen del mensaje ══\n');
    console.log(`  Mensaje: "${MENSAJE}"\n`);
    const flujo = new FlujoCotizacion(null, null, null, null, null, null);
    const terminos = flujo.extraerTerminosBusqueda(MENSAJE);
    terminos.forEach(t => console.log(`   · ${JSON.stringify(t)}`));

    console.log('\n══ 4. Cuáles resuelve la tabla de alias (sin IA) ══\n');
    const alias = new AliasEstudiosService();
    const sinAlias = [];
    for (const t of terminos) {
        const r = alias.resolver(t);
        if (r) {
            ok(`${JSON.stringify(t)} → ${r.candidatos.map(c => c.nombre).join(' | ')}`);
        } else {
            sinAlias.push(t);
            info(`  sin alias: ${JSON.stringify(t)}  (dependerá de SQL, del difuso o de la IA)`);
        }
    }

    console.log('\n══ 5. Qué hace el modelo con los términos sin alias ══\n');
    if (sinAlias.length === 0) {
        ok('Ninguno necesita rescate.');
        return;
    }

    const clf = new LLMClassifier(CONFIG.NLU);
    console.log('  Precargando el modelo (la primera vez puede tardar bastante)...');
    const inicioCarga = Date.now();
    const cargado = await clf.precalentar();
    console.log(cargado
        ? `  Modelo cargado en ${((Date.now() - inicioCarga) / 1000).toFixed(1)} s\n`
        : '  No se pudo precargar\n');

    for (const termino of sinAlias) {
        const inicio = Date.now();
        const res = await clf.clasificarIntencion(termino);
        const ms = Date.now() - inicio;

        console.log(`  "${termino}"`);
        if (!res) {
            mal(`  sin respuesta del modelo (${ms} ms) → no hay rescate posible`);
            info(`  si son ${CONFIG.NLU.timeoutMs} ms justos, es timeout: sube NLU_TIMEOUT_MS o usa qwen3:4b`);
            continue;
        }

        console.log(`        intent="${res.intent}"  query="${res.query}"  (${ms} ms)`);

        if (['asesor', 'sucursal'].includes(res.intent)) {
            mal(`  el intent es "${res.intent}": no es una busqueda de catalogo → no se rescata`);
        } else if (normalizar(res.query) === normalizar(termino)) {
            mal('  el modelo devolvió el mismo texto → no se reintenta');
        } else if (alias.resolver(res.query)) {
            ok(`  el término reescrito SÍ casa con la tabla de alias → ${alias.resolver(res.query).candidatos.map(c => c.nombre).join(' | ')}`);
        } else {
            info('  reescrito, pero no casa con la tabla de alias: dependerá del LIKE de SQL');
        }
        console.log();
    }

    console.log('══ Recuerda reiniciar el bot tras cambiar el .env ══\n');
})();
