const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

function expandirRuta(ruta) {
    const valor = String(ruta || '').trim();
    if (!valor.startsWith('~')) return valor;
    const home = os.homedir();
    return path.join(home, valor.slice(1));
}

function esRutaArchivo(valor) {
    return /[\\/]/.test(String(valor || '')) || path.isAbsolute(String(valor || ''));
}

function extensionDesdeMime(mimetype) {
    const mime = String(mimetype || '').toLowerCase();
    if (mime.includes('ogg') || mime.includes('opus')) return '.ogg';
    if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
    if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
    if (mime.includes('wav')) return '.wav';
    if (mime.includes('webm')) return '.webm';
    return '.ogg';
}

class SpeechService {
    constructor(config = {}, runner = execFileAsync) {
        this.config = {
            enabled: config.enabled !== false,
            ffmpegPath: config.ffmpegPath || 'ffmpeg',
            whisperCliPath: expandirRuta(config.whisperCliPath || 'whisper-cli'),
            whisperModelPath: expandirRuta(config.whisperModelPath || ''),
            language: config.language || 'es',
            initialPrompt: config.initialPrompt || '',
            mediaTempDir: path.resolve(config.mediaTempDir || path.join(os.tmpdir(), 'chatbot-media')),
            timeoutMs: config.timeoutMs || 120000,
            keepMedia: Boolean(config.keepMedia)
        };
        this.runner = runner;
        logger.debug('AUDIO', 'SpeechService inicializado', this.config);
    }

    esAudioMedia(media) {
        const mime = String(media?.mimetype || '').toLowerCase();
        return mime.startsWith('audio/') || mime.includes('ogg') || mime.includes('opus');
    }

    verificarConfiguracion() {
        if (!this.config.enabled) {
            logger.warn('AUDIO', 'Transcripcion de audio desactivada');
            throw new Error('La transcripcion de audio esta desactivada.');
        }

        if (!this.config.whisperModelPath) {
            logger.error('AUDIO', 'Falta modelo whisper');
            throw new Error('Falta WHISPER_MODEL_PATH o el modelo por defecto de whisper.cpp.');
        }

        const archivos = [
            ['WHISPER_MODEL_PATH', this.config.whisperModelPath]
        ];

        if (esRutaArchivo(this.config.whisperCliPath)) {
            archivos.push(['WHISPER_CLI_PATH', this.config.whisperCliPath]);
        }

        for (const [nombre, archivo] of archivos) {
            if (!fs.existsSync(archivo)) {
                logger.error('AUDIO', 'Archivo requerido de audio no existe', {
                    nombre,
                    archivo
                });
                throw new Error(`${nombre} no existe: ${archivo}`);
            }
        }
        logger.debug('AUDIO', 'Configuracion de audio verificada', {
            whisperCliPath: this.config.whisperCliPath,
            whisperModelPath: this.config.whisperModelPath,
            ffmpegPath: this.config.ffmpegPath,
            language: this.config.language
        });
    }

    async transcribirMedia(media, opciones = {}) {
        logger.info('AUDIO', 'Solicitud de transcripcion recibida', {
            mimetype: media?.mimetype,
            hasData: Boolean(media?.data),
            dataLength: media?.data ? String(media.data).length : 0,
            opciones
        });

        if (!media?.data) {
            logger.warn('AUDIO', 'Media sin data, no se transcribe');
            return null;
        }
        if (!this.esAudioMedia(media)) {
            logger.warn('AUDIO', 'Media no es audio, no se transcribe', {
                mimetype: media?.mimetype
            });
            return null;
        }

        this.verificarConfiguracion();

        await fsp.mkdir(this.config.mediaTempDir, { recursive: true });
        const workDir = await fsp.mkdtemp(path.join(this.config.mediaTempDir, 'audio-'));
        const extension = extensionDesdeMime(media.mimetype);
        const inputPath = path.join(workDir, `entrada${extension}`);
        const wavPath = path.join(workDir, 'audio.wav');
        const outputBase = path.join(workDir, 'transcripcion');
        const outputTxt = `${outputBase}.txt`;

        try {
            await fsp.writeFile(inputPath, Buffer.from(media.data, 'base64'));
            logger.debug('AUDIO', 'Archivo de audio temporal escrito', {
                inputPath,
                wavPath,
                outputTxt
            });

            await this.ejecutar(this.config.ffmpegPath, [
                '-y',
                '-i', inputPath,
                '-ar', '16000',
                '-ac', '1',
                '-c:a', 'pcm_s16le',
                wavPath
            ]);
            logger.debug('AUDIO', 'ffmpeg termino conversion a wav', {
                wavPath
            });

            const prompt = String(opciones.initialPrompt || this.config.initialPrompt || '').trim();
            const argsWhisper = [
                '-m', this.config.whisperModelPath,
                '-f', wavPath,
                '-l', this.config.language,
                '-otxt',
                '-of', outputBase,
                '-nt'
            ];

            if (prompt) {
                argsWhisper.push('--prompt', prompt, '--carry-initial-prompt');
            }

            const resultadoWhisper = await this.ejecutar(this.config.whisperCliPath, argsWhisper);
            logger.debug('AUDIO', 'whisper.cpp termino transcripcion', {
                stdout: resultadoWhisper.stdout,
                stderr: resultadoWhisper.stderr,
                outputTxt
            });

            const texto = fs.existsSync(outputTxt)
                ? await fsp.readFile(outputTxt, 'utf8')
                : resultadoWhisper.stdout;

            const limpio = this.limpiarTranscripcion(texto);
            logger.info('AUDIO', 'Transcripcion limpia', {
                textoOriginal: texto,
                textoLimpio: limpio
            });
            return limpio;
        } finally {
            if (!this.config.keepMedia) {
                await fsp.rm(workDir, { recursive: true, force: true });
                logger.debug('AUDIO', 'Temporales de audio eliminados', {
                    workDir
                });
            } else {
                logger.info('AUDIO', 'Temporales de audio conservados', {
                    workDir
                });
            }
        }
    }

    async ejecutar(comando, args) {
        logger.debug('AUDIO_CMD', 'Ejecutando comando de audio', {
            comando,
            args
        });
        const resultado = await this.runner(comando, args, {
            timeout: this.config.timeoutMs,
            maxBuffer: 1024 * 1024 * 10
        });
        logger.debug('AUDIO_CMD', 'Comando de audio finalizado', {
            comando,
            stdout: resultado.stdout,
            stderr: resultado.stderr
        });
        return resultado;
    }

    limpiarTranscripcion(texto) {
        return String(texto || '')
            .replace(/\[[^\]]+-->\s*[^\]]+\]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

module.exports = SpeechService;
