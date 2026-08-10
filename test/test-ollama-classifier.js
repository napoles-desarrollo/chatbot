const LLMClassifier = require('../src/services/llmClassifier');

async function testClassifier() {
    const classifier = new LLMClassifier('http://127.0.0.1:11434', 'qwen3:8b');
    
    const testCases = [
        "¿Cuánto cuesta una química sanguínea?",
        "¿Dónde tienen una sucursal cerca de Tabasco 2000?",
        "¿Cuáles son los requisitos de ayuno para perfil lípido?",
        "Quiero saber si estoy preñada",
        "RX AP y lateral de columna cervical",
        "Quiero hablar con un asesor por favor",
        "Hola buenos días"
    ];

    console.log("=== PROBANDO LLM CLASSIFIER (Qwen3 8B con think: false) ===\n");

    for (const texto of testCases) {
        console.log(`Entrada: "${texto}"`);
        const inicio = Date.now();
        try {
            const res = await classifier.clasificarIntencion(texto);
            const ms = Date.now() - inicio;
            console.log(`Salida:  ${JSON.stringify(res)} (${ms} ms)\n`);
        } catch (err) {
            console.error(`Error:   ${err.message}\n`);
        }
    }
}

testClassifier();
