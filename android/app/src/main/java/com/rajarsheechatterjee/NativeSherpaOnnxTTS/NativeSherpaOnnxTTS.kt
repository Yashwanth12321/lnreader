package com.rajarsheechatterjee.NativeSherpaOnnxTTS

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
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

    // Condition used to wake speakAll when the user resumes or stops playback.
    // Avoids Thread.sleep() polling — the audioHandler thread sleeps for free
    // until resume() or stop() explicitly signals it.
    private val pauseLock = java.util.concurrent.locks.ReentrantLock()
    private val pauseCondition = pauseLock.newCondition()

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
                // Pass null for AssetManager — model files are on the filesystem, not in assets.
                // Must use a typed nullable variable; a direct cast produces a non-null JVM reference.
                val nullManager: android.content.res.AssetManager? = null
                ttsInstance = OfflineTts(nullManager, config)

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

    override fun speak(text: String, speed: Double, promise: Promise) {
        audioHandler.post {
            try {
                val tts = ttsInstance ?: run {
                    promise.reject("NOT_INITIALIZED", "Engine not initialized")
                    return@post
                }

                isStopped = false
                val audio = tts.generate(text = text, sid = 0, speed = speed.toFloat())

                if (isStopped) {
                    promise.resolve(null)
                    return@post
                }

                // Safety cap: skip chunks the model generated > 30 s of audio for
                // (happens when unknown Unicode chars cause runaway generation)
                val maxSamples = audio.sampleRate * 30
                if (audio.samples.size > maxSamples) {
                    promise.resolve(null)
                    return@post
                }

                ensureAudioTrack(audio.sampleRate)

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

    override fun speakAll(sentences: ReadableArray, speed: Double, promise: Promise) {
        audioHandler.post {
            try {
                val tts = ttsInstance ?: run {
                    promise.reject("NOT_INITIALIZED", "Engine not initialized")
                    return@post
                }

                isStopped = false

                // Collect sentence strings
                val texts = (0 until sentences.size()).mapNotNull { sentences.getString(it) }
                    .filter { it.isNotBlank() }

                if (texts.isEmpty()) {
                    promise.resolve(null)
                    return@post
                }

                val spd = speed.toFloat()

                // Ensure AudioTrack exists at the right sample rate.
                // Generate the first sentence to discover the sample rate before play starts.
                val first = tts.generate(text = texts[0], sid = 0, speed = spd)
                if (isStopped) { promise.resolve(null); return@post }

                ensureAudioTrack(first.sampleRate)
                val maxSamples = first.sampleRate * 30

                val track = audioTrack!!
                track.play()

                // Producer: generates remaining sentences on a background thread,
                // pushes FloatArray into a bounded queue (capacity 1 = one sentence ahead).
                // LinkedBlockingQueue does NOT allow null — use a sentinel FloatArray instead.
                val SENTINEL = FloatArray(0) // unique object identity used as end-of-stream marker
                val queue = java.util.concurrent.LinkedBlockingQueue<FloatArray>(2)

                val generatorThread = Thread {
                    try {
                        for (i in 1 until texts.size) {
                            if (isStopped) break
                            val audio = tts.generate(text = texts[i], sid = 0, speed = spd)
                            val samples = if (audio.samples.size > maxSamples) FloatArray(0)
                                          else audio.samples
                            // Use offer() with timeout so stop() can't cause a thread leak:
                            // if the consumer exited early the queue may be full and put() would
                            // block indefinitely (daemon thread, but still a resource leak).
                            while (!isStopped) {
                                if (queue.offer(samples, 100, java.util.concurrent.TimeUnit.MILLISECONDS)) break
                            }
                            if (isStopped) break
                        }
                    } finally {
                        // Best-effort sentinel; ignore if consumer is already gone
                        queue.offer(SENTINEL, 200, java.util.concurrent.TimeUnit.MILLISECONDS)
                    }
                }
                generatorThread.isDaemon = true
                generatorThread.start()

                // Player: write first chunk, then drain queue — WRITE_BLOCKING keeps
                // samples flowing continuously into AudioTrack with zero gap.
                fun writeIfNotStopped(samples: FloatArray) {
                    if (samples.isEmpty() || isStopped) return
                    track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
                }

                writeIfNotStopped(if (first.samples.size > maxSamples) FloatArray(0) else first.samples)

                while (!isStopped) {
                    val samples = queue.poll(2000, java.util.concurrent.TimeUnit.MILLISECONDS)
                        ?: break // timeout — generator thread stalled
                    if (samples === SENTINEL) break // end-of-stream
                    writeIfNotStopped(samples)
                }

                // If all data was written while paused, the ring buffer holds unplayed audio.
                // Wait here until the user resumes (or stops) before draining — otherwise
                // the promise resolves immediately and onDone advances the cursor while paused.
                if (isPaused && !isStopped) {
                    pauseLock.lock()
                    try {
                        while (isPaused && !isStopped) {
                            pauseCondition.await() // zero-CPU sleep until signalled
                        }
                    } finally {
                        pauseLock.unlock()
                    }
                }

                // Drain remaining AudioTrack buffer before resolving
                if (!isStopped) {
                    track.stop()  // drains buffered audio to completion
                    track.flush() // clear buffer so next play() starts clean
                } else {
                    track.pause()
                    track.flush()
                }

                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SPEAK_ALL_ERROR", e.message, e)
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
            // Wake speakAll if it is waiting for the pause to lift
            pauseLock.lock()
            try { pauseCondition.signalAll() } finally { pauseLock.unlock() }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("RESUME_ERROR", e.message, e)
        }
    }

    override fun stop(promise: Promise) {
        // Set flag immediately so the speak() polling loop exits on its next tick
        isStopped = true
        // Wake speakAll if it is waiting inside the pause-condition await
        pauseLock.lock()
        try { pauseCondition.signalAll() } finally { pauseLock.unlock() }
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
                                // Strip the first path component (tar --strip-components=1)
                                // Archives ship as <voiceId>/model.onnx etc; we want model.onnx at destDir root
                                val stripped = entry.name.substringAfter('/')
                                if (stripped.isNotEmpty()) {
                                    val outFile = File(destDir, stripped)
                                    if (entry.isDirectory) {
                                        outFile.mkdirs()
                                    } else {
                                        outFile.parentFile?.mkdirs()
                                        outFile.outputStream().use { out -> tais.copyTo(out) }
                                    }
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

    /** Creates or reuses AudioTrack for the given sample rate. Must be called on audioHandler. */
    private fun ensureAudioTrack(sampleRate: Int) {
        if (sampleRate == currentSampleRate && audioTrack != null) return
        audioTrack?.release()
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
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
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(minBuf * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        currentSampleRate = sampleRate
    }

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
