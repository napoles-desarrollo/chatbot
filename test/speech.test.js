const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SpeechService = require('../src/services/speech');
const OcrService = require('../src/services/ocr');
const { WhatsAppTestClient, esMensajeAudio, esMensajeImagen } = require('../src/wa-test');

test('SpeechService convierte audio y transcribe con whisper.cpp en espanol', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'speech-test-'));
    const whisperCliPath = path.join(tempRoot, 'whisper-cli');
    const modelPath = path.join(tempRoot, 'ggml-small.bin');
    fs.writeFileSync(whisperCliPath, '');
    fs.writeFileSync(modelPath, '');

    const llamadas = [];
    const runner = async (comando, args) => {
        llamadas.push({ comando, args });

        if (comando === whisperCliPath) {
            const outputBase = args[args.indexOf('-of') + 1];
            fs.writeFileSync(`${outputBase}.txt`, 'quiero cotizar servicios\n');
        }

        return { stdout: '', stderr: '' };
    };

    const servicio = new SpeechService({
        ffmpegPath: 'ffmpeg',
        whisperCliPath,
        whisperModelPath: modelPath,
        language: 'es',
        initialPrompt: 'Opciones: Villahermosa, cotizar servicios.',
        mediaTempDir: tempRoot
    }, runner);

    const texto = await servicio.transcribirMedia({
        mimetype: 'audio/ogg; codecs=opus',
        data: Buffer.from('audio-falso').toString('base64')
    });

    assert.equal(texto, 'quiero cotizar servicios');
    assert.equal(llamadas[0].comando, 'ffmpeg');
    assert.equal(llamadas[1].comando, whisperCliPath);
    assert.deepEqual(llamadas[1].args.slice(0, 2), ['-m', modelPath]);
    assert.equal(llamadas[1].args[llamadas[1].args.indexOf('-l') + 1], 'es');
    assert.equal(llamadas[1].args[llamadas[1].args.indexOf('--prompt') + 1], 'Opciones: Villahermosa, cotizar servicios.');
    assert.equal(llamadas[1].args.includes('--carry-initial-prompt'), true);

    await fsp.rm(tempRoot, { recursive: true, force: true });
});

test('wa-test identifica notas de voz y audios como media transcribible', () => {
    assert.equal(esMensajeAudio({ hasMedia: true, type: 'ptt' }), true);
    assert.equal(esMensajeAudio({ hasMedia: true, type: 'audio' }), true);
    assert.equal(esMensajeAudio({ hasMedia: true, type: 'image' }), false);
    assert.equal(esMensajeAudio({ hasMedia: false, type: 'ptt' }), false);
});

test('OcrService extrae texto de imagen y limpia lineas', async () => {
    const llamadas = [];
    const recognizer = {
        async recognize(buffer, language, options) {
            llamadas.push({ buffer, language, options });
            return {
                data: {
                    text: '  BIOMETRIA HEMATICA\\n\\nGLUCOSA   \\n',
                    confidence: 91
                }
            };
        }
    };
    const servicio = new OcrService({
        language: 'spa+eng',
        timeoutMs: 1000,
        minChars: 2
    }, recognizer);

    const texto = await servicio.extraerTextoMedia({
        mimetype: 'image/jpeg',
        data: Buffer.from('imagen-falsa').toString('base64')
    });

    assert.equal(texto, 'BIOMETRIA HEMATICA\nGLUCOSA');
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].language, 'spa+eng');
    assert.equal(Buffer.isBuffer(llamadas[0].buffer), true);
});

test('wa-test identifica imagenes como media OCR', () => {
    assert.equal(esMensajeImagen({ hasMedia: true, type: 'image' }), true);
    assert.equal(esMensajeImagen({ hasMedia: true, type: 'ptt' }), false);
    assert.equal(esMensajeImagen({ hasMedia: false, type: 'image' }), false);
});

test('wa-test traduce nombres hablados de opciones visibles', async () => {
    const enviados = [];
    const cliente = new WhatsAppTestClient({
        async sendMessage(chatId, texto) {
            enviados.push({ chatId, texto });
        }
    });

    await cliente.enviarListaDesplegable('cuenta', 'chat-audio', 'Elige una sucursal', 'Elegir', [
        { title: '1 VILLAHERMOSA', value: 'cercana_0' },
        { title: '2 VILLA JALUPA', value: 'cercana_1' },
        { title: '3 NACAJUCA LABORATORIO', value: 'cercana_2' }
    ]);

    assert.equal(cliente.traducirEntrada('chat-audio', 'BJR Mosa'), 'cercana_0');
    assert.equal(enviados.length, 1);
});
