package com.rajarsheechatterjee.NativeSherpaOnnxTTS

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.lnreader.spec.NativeSherpaOnnxTTSSpec
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

class NativeSherpaOnnxTTS(reactContext: ReactApplicationContext) :
    NativeSherpaOnnxTTSSpec(reactContext) {

    private val thread = HandlerThread("audioHandler").also { it.start() }
    private val audioHandler = Handler(thread.looper)

    private var ttsInstance: OfflineTts? = null
    private var audioTrack: AudioTrack? = null
    private var currentSampleRate: Int = 0

    @Volatile private var isStopped = false
    @Volatile private var isPaused = false

    // ── Engine lifecycle ──────────────────────────────────────────────────────

    override fun initEngine(voiceId: String, modelDir: String, promise: Promise) {
        audioHandler.post {
            try {
                // Release any previously loaded model
                ttsInstance?.release()
                ttsInstance = null
                audioTrack?.release()
                audioTrack = null
                currentSampleRate = 0

                // Read voice.json sidecar to determine model type
                val meta = JSONObject(File(modelDir, "voice.json").readText())
                val modelType = meta.getString("model_type")

                val modelConfig = buildModelConfig(modelType, modelDir)
                val config = OfflineTtsConfig(model = modelConfig, maxNumSentences = 1)
                ttsInstance = OfflineTts(reactApplicationContext.assets, config)

                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("INIT_ERROR", e.message, e)
            }
        }
    }

    override fun deinitEngine(promise: Promise) {
        isStopped = true
        audioHandler.post {
            try {
                audioTrack?.release()
                audioTrack = null
                currentSampleRate = 0
                ttsInstance?.release()
                ttsInstance = null
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("DEINIT_ERROR", e.message, e)
            }
        }
    }

    // ── Synthesis + playback ──────────────────────────────────────────────────

    override fun speak(text: String, promise: Promise) {
        audioHandler.post {
            try {
                val tts = ttsInstance ?: run {
                    promise.reject("NOT_INITIALIZED", "Engine not initialized")
                    return@post
                }

                isStopped = false
                val audio = tts.generate(text = text, sid = 0, speed = 1.0f)

                if (isStopped) {
                    promise.resolve(null)
                    return@post
                }

                // Recreate AudioTrack only if sample rate changed
                if (audio.sampleRate != currentSampleRate) {
                    audioTrack?.release()
                    val minBuf = AudioTrack.getMinBufferSize(
                        audio.sampleRate,
                        AudioFormat.CHANNEL_OUT_MONO,
                        AudioFormat.ENCODING_PCM_FLOAT,
                    )
                    audioTrack = AudioTrack.Builder()
                        .setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build()
                        )
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setSampleRate(audio.sampleRate)
                                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build()
                        )
                        .setBufferSizeInBytes(minBuf * 4)
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
                    currentSampleRate = audio.sampleRate
                }

                val track = audioTrack!!
                track.play()
                track.write(audio.samples, 0, audio.samples.size, AudioTrack.WRITE_BLOCKING)

                // Wait for playback to finish; isStopped check allows immediate cancellation
                val durationMs = audio.samples.size.toLong() * 1000L / audio.sampleRate
                var deadline = System.currentTimeMillis() + durationMs + 150L
                while (System.currentTimeMillis() < deadline && !isStopped) {
                    if (isPaused) deadline += 20L  // extend deadline while paused
                    Thread.sleep(20)
                }

                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SPEAK_ERROR", e.message, e)
            }
        }
    }

    override fun pause(promise: Promise) {
        try {
            isPaused = true
            audioTrack?.pause()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PAUSE_ERROR", e.message, e)
        }
    }

    override fun resume(promise: Promise) {
        try {
            isPaused = false
            audioTrack?.play()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("RESUME_ERROR", e.message, e)
        }
    }

    override fun stop(promise: Promise) {
        // Set flag immediately so the speak() polling loop exits on its next tick
        isStopped = true
        audioHandler.post {
            try {
                val track = audioTrack
                if (track != null && track.state == AudioTrack.STATE_INITIALIZED) {
                    track.pause()
                    track.flush()
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("STOP_ERROR", e.message, e)
            }
        }
    }

    // ── Voice file utilities ──────────────────────────────────────────────────

    override fun getFilesDir(promise: Promise) {
        promise.resolve(reactApplicationContext.filesDir.absolutePath)
    }

    override fun extractTarBz2(tarPath: String, destDir: String, promise: Promise) {
        Thread {
            try {
                val dest = File(destDir)
                dest.mkdirs()

                FileInputStream(tarPath).use { fis ->
                    BZip2CompressorInputStream(fis).use { bzis ->
                        TarArchiveInputStream(bzis).use { tais ->
                            var entry = tais.nextTarEntry
                            while (entry != null) {
                                val outFile = File(destDir, entry.name)
                                if (entry.isDirectory) {
                                    outFile.mkdirs()
                                } else {
                                    outFile.parentFile?.mkdirs()
                                    outFile.outputStream().use { out -> tais.copyTo(out) }
                                }
                                entry = tais.nextTarEntry
                            }
                        }
                    }
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("EXTRACT_ERROR", e.message, e)
            } finally {
                // Clean up temp archive regardless of success or failure
                try { File(tarPath).delete() } catch (_: Exception) {}
            }
        }.start()
    }

    override fun deleteVoiceDir(voiceId: String, promise: Promise) {
        try {
            File(reactApplicationContext.filesDir, "models/$voiceId").deleteRecursively()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DELETE_ERROR", e.message, e)
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private fun buildModelConfig(modelType: String, modelDir: String): OfflineTtsModelConfig {
        return when (modelType) {
            "vits", "mms" -> {
                val lexicon = File(modelDir, "lexicon.txt")
                val dataDir = File(modelDir, "espeak-ng-data")
                OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = findOnnxModel(modelDir),
                        lexicon = if (lexicon.exists()) lexicon.absolutePath else "",
                        tokens = "$modelDir/tokens.txt",
                        dataDir = if (dataDir.exists()) dataDir.absolutePath else "",
                    ),
                    numThreads = 2,
                    debug = false,
                    provider = "cpu",
                )
            }
            "kokoro" -> OfflineTtsModelConfig(
                kokoro = OfflineTtsKokoroModelConfig(
                    model = findOnnxModel(modelDir),
                    voices = "$modelDir/voices.bin",
                    tokens = "$modelDir/tokens.txt",
                    dataDir = "$modelDir/espeak-ng-data",
                ),
                numThreads = 2,
                debug = false,
                provider = "cpu",
            )
            else -> throw IllegalArgumentException("Unsupported model_type: $modelType")
        }
    }

    /** Finds the .onnx model file in modelDir regardless of filename (e.g. en_GB-alan-medium.onnx). */
    private fun findOnnxModel(modelDir: String): String {
        val dir = File(modelDir)
        return dir.listFiles { f -> f.extension == "onnx" }
            ?.firstOrNull()?.absolutePath
            ?: "$modelDir/model.onnx"
    }
}
