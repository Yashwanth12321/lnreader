# Sherpa-ONNX Offline TTS Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sherpa-ONNX as a second TTS engine in LNReader, enabling downloadable high-quality offline voices (VITS, MMS, Kokoro) alongside the existing system TTS.

**Architecture:** A Kotlin TurboModule (`NativeSherpaOnnxTTS`) wraps the Sherpa-ONNX AAR, running ONNX inference and AudioTrack playback on a dedicated HandlerThread. A JS voice registry (`sherpaVoiceRegistry.ts`) manages model downloads using `expo-file-system` + a native tar.bz2 extractor. A JS wrapper (`sherpaOnnxTTS.ts`) handles sentence-level chunking and feeds text to the native module sequentially. The existing system TTS path is untouched.

**Tech Stack:** React Native 0.81.6 (New Architecture / TurboModules), Kotlin, Sherpa-ONNX Android AAR, Apache Commons Compress (tar.bz2), expo-file-system, MMKV

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `specs/NativeSherpaOnnxTTSSpec.ts` | TurboModule codegen spec — defines JS↔Native API surface |
| `android/app/libs/sherpa-onnx-android.aar` | Sherpa-ONNX prebuilt AAR (download separately) |
| `android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTS.kt` | Kotlin implementation: model lifecycle, AudioTrack, extraction |
| `android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTSPackage.kt` | New Architecture package registrar |
| `src/assets/sherpa_models.json` | Bundled voice manifest (copy of project-root `models.json`, renamed) |
| `src/utils/sherpaVoiceRegistry.ts` | Voice manifest parser + download manager |
| `src/utils/sherpaOnnxTTS.ts` | Sentence splitter + sequential synthesis coordinator |

### Modified Files
| File | Change |
|---|---|
| `android/app/build.gradle` | Add AAR fileTree dep + abiFilters + packagingOptions + commons-compress |
| `android/app/src/main/java/com/rajarsheechatterjee/LNReader/MainApplication.kt` | Register `NativeSherpaOnnxTTSPackage` |
| `src/hooks/persisted/useSettings.ts` | Add `ttsEngine`, `sherpaTtsVoiceId` fields + migration guard |
| `src/screens/reader/components/ReaderBottomSheet/TTSTab.tsx` | Engine toggle + offline voice list UI |
| `src/screens/reader/components/WebViewReader.tsx` | Route `speakText()` through engine setting |

---

## Chunk 1: Phase 1 — TurboModule Scaffold

### Task 1: Write the TurboModule Spec File

**Files:**
- Create: `specs/NativeSherpaOnnxTTSSpec.ts`

> **Context:** The project uses React Native New Architecture (TurboModules). Codegen reads TypeScript spec files from `specs/` to auto-generate C++/Java bridge code. Look at `specs/NativeTTSMediaControl.ts` as the exact pattern to follow. The Package class will reference `NativeSherpaOnnxTTSSpec.NAME`.

- [ ] **Step 1: Create the spec file**

```typescript
// specs/NativeSherpaOnnxTTSSpec.ts
import { TurboModule, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Engine lifecycle
  initEngine(voiceId: string, modelDir: string): Promise<void>;
  deinitEngine(): Promise<void>;

  // Synthesis + playback
  speak(text: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;

  // Voice file utilities (used by sherpaVoiceRegistry.ts)
  getFilesDir(): Promise<string>;
  extractTarBz2(tarPath: string, destDir: string): Promise<void>;
  deleteVoiceDir(voiceId: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSherpaOnnxTTS');
```

- [ ] **Step 2: Verify codegen picks it up**

Run:
```bash
cd android && ./gradlew generateCodegenArtifactsFromSchema 2>&1 | tail -20
```
Expected: `BUILD SUCCESSFUL`. If errors appear, they will mention missing imports — check the spec matches the pattern above exactly.

---

### Task 2: Write the Kotlin Stub Module

**Files:**
- Create: `android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTS.kt`

> **Context:** Codegen produces an abstract class `com.lnreader.spec.NativeSherpaOnnxTTSSpec` that your Kotlin class must extend. For `Promise<void>` methods, codegen generates abstract fun signatures with a `promise: Promise` parameter. Call `promise.resolve(null)` on success, `promise.reject("TAG", message)` on error. In this Phase 1 stub, all methods just resolve immediately — no real logic yet.

- [ ] **Step 1: Create the stub Kotlin file**

```kotlin
// android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTS.kt
package com.rajarsheechatterjee.NativeSherpaOnnxTTS

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.lnreader.spec.NativeSherpaOnnxTTSSpec

class NativeSherpaOnnxTTS(reactContext: ReactApplicationContext) :
    NativeSherpaOnnxTTSSpec(reactContext) {

    override fun initEngine(voiceId: String, modelDir: String, promise: Promise) {
        promise.resolve(null)
    }

    override fun deinitEngine(promise: Promise) {
        promise.resolve(null)
    }

    override fun speak(text: String, promise: Promise) {
        promise.resolve(null)
    }

    override fun pause(promise: Promise) {
        promise.resolve(null)
    }

    override fun resume(promise: Promise) {
        promise.resolve(null)
    }

    override fun stop(promise: Promise) {
        promise.resolve(null)
    }

    override fun getFilesDir(promise: Promise) {
        promise.resolve(reactApplicationContext.filesDir.absolutePath)
    }

    override fun extractTarBz2(tarPath: String, destDir: String, promise: Promise) {
        promise.resolve(null)
    }

    override fun deleteVoiceDir(voiceId: String, promise: Promise) {
        promise.resolve(null)
    }
}
```

---

### Task 3: Write the Package Registrar

**Files:**
- Create: `android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTSPackage.kt`

> **Context:** This is identical in structure to `NativeTTSMediaControlPackage.kt`. It must extend `BaseReactPackage` (NOT `ReactPackage`) and implement `getReactModuleInfoProvider()`. The `NAME` constant is generated by codegen into `NativeSherpaOnnxTTSSpec.NAME` — do NOT hardcode the string.

- [ ] **Step 1: Create the package file**

```kotlin
// android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTSPackage.kt
package com.rajarsheechatterjee.NativeSherpaOnnxTTS

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.lnreader.spec.NativeSherpaOnnxTTSSpec

class NativeSherpaOnnxTTSPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeSherpaOnnxTTSSpec.NAME) {
            NativeSherpaOnnxTTS(reactContext)
        } else {
            null
        }

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            NativeSherpaOnnxTTSSpec.NAME to ReactModuleInfo(
                NativeSherpaOnnxTTSSpec.NAME,
                NativeSherpaOnnxTTSSpec.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true
            )
        )
    }
}
```

---

### Task 4: Register the Package in MainApplication

**Files:**
- Modify: `android/app/src/main/java/com/rajarsheechatterjee/LNReader/MainApplication.kt`

> **Context:** All custom packages are added inside `getPackages()` in `MainApplication.kt`. Follow the exact pattern of the other packages already there.

- [ ] **Step 1: Add import and registration**

Add this import after the existing `NativeTTSMediaControl` import:
```kotlin
import com.rajarsheechatterjee.NativeSherpaOnnxTTS.NativeSherpaOnnxTTSPackage
```

Add this line inside `getPackages()` after `add(NativeTTSMediaControlPackage())`:
```kotlin
add(NativeSherpaOnnxTTSPackage())
```

---

### Task 5: Verify Phase 1 on Device

- [ ] **Step 1: Build and run**

```bash
npx react-native run-android
```

- [ ] **Step 2: Add a temporary test call**

In `TTSTab.tsx`, temporarily add a button that calls the module:

```typescript
import NativeSherpaOnnxTTS from '../../../../../specs/NativeSherpaOnnxTTSSpec';

// Inside component, add temporarily:
<Button
  title="Test Sherpa"
  onPress={() =>
    NativeSherpaOnnxTTS.initEngine('test', '/tmp')
      .then(() => console.log('Phase 1: initEngine OK'))
      .catch((e: Error) => console.error('Phase 1 FAIL:', e))
  }
/>
```

- [ ] **Step 3: Verify**

Open the reader → TTS tab → tap "Test Sherpa". Check Metro logs:
Expected: `Phase 1: initEngine OK`
If "module not found": codegen didn't run — re-run `./gradlew generateCodegenArtifactsFromSchema` and rebuild.

- [ ] **Step 4: Remove the test button** (it's only for Phase 1 verification)

- [ ] **Step 5: Commit**

```bash
git add specs/NativeSherpaOnnxTTSSpec.ts \
  android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/ \
  android/app/src/main/java/com/rajarsheechatterjee/LNReader/MainApplication.kt
git commit -m "feat(tts): scaffold NativeSherpaOnnxTTS TurboModule (Phase 1)"
```

---

## Chunk 2: Phase 2 — AAR Integration + One Voice Speaking

### Task 6: Download the Sherpa-ONNX AAR

> **Context:** Sherpa-ONNX distributes a prebuilt Android AAR containing the C++ ONNX runtime and a Java/Kotlin API. You need to download it and place it in `android/app/libs/` so Gradle can find it.

- [ ] **Step 1: Download the AAR**

Go to: `https://github.com/k2-fsa/sherpa-onnx/releases`

Find the latest release and download: `sherpa-onnx-android.aar`
(Look for assets named `sherpa-onnx-*.aar` — pick the full version, not `-lite`)

- [ ] **Step 2: Create libs directory and place the AAR**

```bash
mkdir -p android/app/libs
# Move the downloaded .aar file here:
# android/app/libs/sherpa-onnx-android.aar
```

---

### Task 7: Update build.gradle

**Files:**
- Modify: `android/app/build.gradle`

> **Context:** The file currently has `android { defaultConfig { ... } externalNativeBuild { ... } }` then `dependencies { }`. Three additions are needed in precise locations. This project uses AGP 8.x (React Native 0.81), so the correct block name is `packaging` (NOT `packagingOptions` — that was renamed in AGP 7.0 and is silently ignored in 8.x).

- [ ] **Step 1: Add `ndk` block inside `defaultConfig`**

Open `android/app/build.gradle`. Find `defaultConfig {` (around line 86). Add the `ndk` block **before** the closing `}` of `defaultConfig`, after the `versionName` line:

```groovy
    defaultConfig {
        applicationId ...
        minSdkVersion ...
        targetSdkVersion ...
        versionCode ...
        versionName ...
        // ADD THIS:
        ndk {
            // Drops x86 emulator support — use x86_64 or arm64-v8a emulators instead.
            abiFilters "arm64-v8a", "x86_64"
        }
    }
```

- [ ] **Step 2: Add `packaging` block inside `android { }` after `externalNativeBuild`**

Find the `externalNativeBuild { cmake { ... } }` block (around line 119). Add the `packaging` block **immediately after** it, still inside the `android { }` block:

```groovy
    externalNativeBuild {
        cmake {
            path "src/main/jni/CMakeLists.txt"
        }
    }
    // ADD THIS (note: AGP 8.x uses "packaging", not "packagingOptions"):
    packaging {
        // The Sherpa-ONNX AAR and the existing CMake appmodules target both
        // ship libc++_shared.so. pickFirst avoids a duplicate .so merge error.
        pickFirst '**/libc++_shared.so'
    }
}  // closes android { }
```

- [ ] **Step 3: Add to `dependencies { }`**

Find `dependencies {` (around line 126). Add two lines after `implementation 'androidx.media:media:1.7.0'`:

```groovy
    implementation 'androidx.media:media:1.7.0'
    // ADD THESE:
    implementation fileTree(dir: 'libs', include: ['*.aar'])  // Sherpa-ONNX AAR
    implementation 'org.apache.commons:commons-compress:1.26.0'  // tar.bz2 extraction
```

- [ ] **Step 4: Sync and verify build**

```bash
cd android && ./gradlew assembleDebug 2>&1 | tail -30
```
Expected: `BUILD SUCCESSFUL`.

Common failures:
- `Duplicate files copied in APK lib/arm64-v8a/libc++_shared.so` → `packaging` block is missing or misspelled
- `Could not find com.k2fsa.sherpa.onnx` at runtime → AAR not in `android/app/libs/` or `fileTree` line is missing
- `Could not resolve org.apache.commons:commons-compress` → no internet or wrong version string; try `1.24.0`

---

### Task 8: Push a Test Voice to the Device

> **Context:** Before implementing download, manually push one voice model to the device using `adb`. This lets you test synthesis in isolation. We'll use a small VITS English voice.
>
> Choose a small VITS voice from `src/assets/sherpa_models.json` (the voice you'll copy from `models.json` in the next task). Look for entries with `model_type: "vits"` and `filesize_mb` under 60. A good choice: any `vits-piper-en_US-*-low` model (~27MB). Download the tar.bz2 from the `url` field, extract it on your computer, then push.

- [ ] **Step 1: Copy and rename the voice manifest**

```bash
cp models.json src/assets/sherpa_models.json
```

- [ ] **Step 2: Pick a voice**

Open `src/assets/sherpa_models.json`, find a `vits` model with a small filesize. Note its `id` and `url`. For example: `vits-piper-en_US-amy-low` (27MB).

- [ ] **Step 3: Download and extract the voice on your computer**

```bash
# Download the .tar.bz2 from the model's url field
curl -L "<url_from_models_json>" -o voice.tar.bz2

# Extract it
mkdir -p /tmp/voice_test
tar xjf voice.tar.bz2 -C /tmp/voice_test
# This creates a directory like /tmp/voice_test/vits-piper-en_US-amy-low/
```

- [ ] **Step 4: Push voice files to device**

```bash
VOICE_ID="vits-piper-en_US-amy-low"  # replace with your chosen id
adb shell mkdir -p /data/data/com.rajarsheechatterjee.LNReader/files/models/$VOICE_ID
adb push /tmp/voice_test/$VOICE_ID/model.onnx /data/data/com.rajarsheechatterjee.LNReader/files/models/$VOICE_ID/
adb push /tmp/voice_test/$VOICE_ID/tokens.txt /data/data/com.rajarsheechatterjee.LNReader/files/models/$VOICE_ID/
# If lexicon.txt exists:
adb push /tmp/voice_test/$VOICE_ID/lexicon.txt /data/data/com.rajarsheechatterjee.LNReader/files/models/$VOICE_ID/
# If espeak-ng-data/ dir exists:
adb push /tmp/voice_test/$VOICE_ID/espeak-ng-data /data/data/com.rajarsheechatterjee.LNReader/files/models/$VOICE_ID/
```

- [ ] **Step 5: Push the voice.json sidecar**

Create a file `/tmp/voice.json`:
```json
{
  "id": "vits-piper-en_US-amy-low",
  "model_type": "vits",
  "sample_rate": 22050,
  "num_speakers": 1
}
```
Push it:
```bash
adb push /tmp/voice.json /data/data/com.rajarsheechatterjee.LNReader/files/models/$VOICE_ID/voice.json
```

---

### Task 9: Implement Real NativeSherpaOnnxTTS.kt

**Files:**
- Modify: `android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTS.kt`

> **Context:** The Sherpa-ONNX AAR exposes a Java/Kotlin API under the `com.k2fsa.sherpa.onnx` package. Key classes: `OfflineTts`, `OfflineTtsConfig`, `OfflineTtsModelConfig`, `OfflineTtsVitsModelConfig`, `OfflineTtsKokoroModelConfig`. All AudioTrack and ONNX inference work runs on `audioHandler` (a `HandlerThread`). Each method posts to `audioHandler`, performs the work, and resolves the Promise on completion.

- [ ] **Step 1: Replace the stub with the full implementation**

```kotlin
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
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

class NativeSherpaOnnxTTS(reactContext: ReactApplicationContext) :
    NativeSherpaOnnxTTSSpec(reactContext) {

    private val audioThread = HandlerThread("SherpaOnnxAudio").also { it.start() }
    private val audioHandler = Handler(audioThread.looper)

    private var tts: OfflineTts? = null
    private var audioTrack: AudioTrack? = null
    @Volatile private var isPaused = false
    @Volatile private var isStopped = false

    // ── Engine lifecycle ──────────────────────────────────────────────────────

    override fun initEngine(voiceId: String, modelDir: String, promise: Promise) {
        audioHandler.post {
            try {
                // Auto-deinit any previously loaded model
                tts?.release()
                tts = null

                val voiceJson = File("$modelDir/voice.json")
                val modelType = if (voiceJson.exists()) {
                    val text = voiceJson.readText()
                    // Simple extraction: find "model_type":"xxx"
                    Regex(""""model_type"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1) ?: "vits"
                } else "vits"

                val modelConfig = when (modelType) {
                    "kokoro" -> OfflineTtsModelConfig(
                        kokoro = OfflineTtsKokoroModelConfig(
                            model = "$modelDir/model.onnx",
                            voices = "$modelDir/voices.bin",
                            tokens = "$modelDir/tokens.txt",
                            dataDir = "$modelDir/espeak-ng-data",
                        ),
                        numThreads = 2,
                        debug = false,
                        provider = "cpu",
                    )
                    else -> { // vits + mms
                        val hasLexicon = File("$modelDir/lexicon.txt").exists()
                        val hasEspeak = File("$modelDir/espeak-ng-data").isDirectory
                        OfflineTtsModelConfig(
                            vits = OfflineTtsVitsModelConfig(
                                model = "$modelDir/model.onnx",
                                lexicon = if (hasLexicon) "$modelDir/lexicon.txt" else "",
                                tokens = "$modelDir/tokens.txt",
                                dataDir = if (hasEspeak) "$modelDir/espeak-ng-data" else "",
                            ),
                            numThreads = 2,
                            debug = false,
                            provider = "cpu",
                        )
                    }
                }

                tts = OfflineTts(config = OfflineTtsConfig(model = modelConfig, maxNumSentences = 1))
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("INIT_ERROR", e.message ?: "initEngine failed", e)
            }
        }
    }

    override fun deinitEngine(promise: Promise) {
        audioHandler.post {
            tts?.release()
            tts = null
            audioTrack?.release()
            audioTrack = null
            promise.resolve(null)
        }
    }

    // ── Synthesis + playback ──────────────────────────────────────────────────

    override fun speak(text: String, promise: Promise) {
        audioHandler.post {
            try {
                val engine = tts ?: run {
                    promise.reject("NOT_INIT", "Engine not initialized — call initEngine first")
                    return@post
                }

                isStopped = false
                isPaused = false

                val audio = engine.generate(text = text, sid = 0, speed = 1.0f)
                val samples = audio.samples   // FloatArray
                val sampleRate = audio.sampleRate

                if (isStopped) { promise.resolve(null); return@post }

                val minBuf = AudioTrack.getMinBufferSize(
                    sampleRate,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_FLOAT
                )

                val track = AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                            .setSampleRate(sampleRate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build()
                    )
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .setBufferSizeInBytes(maxOf(minBuf, samples.size * 4))
                    .build()

                audioTrack?.release()
                audioTrack = track
                track.play()

                // Write in chunks so pause/stop can interrupt
                val chunkSize = sampleRate / 10  // 100ms chunks
                var offset = 0
                while (offset < samples.size && !isStopped) {
                    while (isPaused && !isStopped) Thread.sleep(50)
                    if (isStopped) break
                    val end = minOf(offset + chunkSize, samples.size)
                    track.write(samples, offset, end - offset, AudioTrack.WRITE_BLOCKING)
                    offset = end
                }

                track.stop()
                track.release()
                audioTrack = null
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SPEAK_ERROR", e.message ?: "speak failed", e)
            }
        }
    }

    override fun pause(promise: Promise) {
        isPaused = true
        audioHandler.post {
            audioTrack?.pause()
            promise.resolve(null)
        }
    }

    override fun resume(promise: Promise) {
        isPaused = false
        audioHandler.post {
            audioTrack?.play()
            promise.resolve(null)
        }
    }

    override fun stop(promise: Promise) {
        isStopped = true
        isPaused = false
        audioHandler.post {
            audioTrack?.stop()
            audioTrack?.release()
            audioTrack = null
            promise.resolve(null)
        }
    }

    // ── Voice file utilities ──────────────────────────────────────────────────

    override fun getFilesDir(promise: Promise) {
        promise.resolve(reactApplicationContext.filesDir.absolutePath)
    }

    override fun extractTarBz2(tarPath: String, destDir: String, promise: Promise) {
        audioHandler.post {
            try {
                val dest = File(destDir)
                dest.mkdirs()

                FileInputStream(tarPath).use { fis ->
                    BZip2CompressorInputStream(fis).use { bzip ->
                        TarArchiveInputStream(bzip).use { tar ->
                            var entry = tar.nextEntry
                            while (entry != null) {
                                val outFile = File(dest, entry.name)
                                if (entry.isDirectory) {
                                    outFile.mkdirs()
                                } else {
                                    outFile.parentFile?.mkdirs()
                                    FileOutputStream(outFile).use { out ->
                                        tar.copyTo(out)
                                    }
                                }
                                entry = tar.nextEntry
                            }
                        }
                    }
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("EXTRACT_ERROR", e.message ?: "extractTarBz2 failed", e)
            }
        }
    }

    override fun deleteVoiceDir(voiceId: String, promise: Promise) {
        audioHandler.post {
            try {
                val dir = File(reactApplicationContext.filesDir, "models/$voiceId")
                if (dir.exists()) dir.deleteRecursively()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("DELETE_ERROR", e.message ?: "deleteVoiceDir failed", e)
            }
        }
    }
}
```

---

### Task 10: Verify Phase 2 on Device

- [ ] **Step 1: Add a temporary test button in TTSTab.tsx**

```typescript
import NativeSherpaOnnxTTS from '../../../../../specs/NativeSherpaOnnxTTSSpec';

// Temporarily add to component:
const testSherpa = async () => {
  try {
    const filesDir = await NativeSherpaOnnxTTS.getFilesDir();
    const modelDir = `${filesDir}/models/vits-piper-en_US-amy-low`; // adjust to your pushed voice id
    await NativeSherpaOnnxTTS.initEngine('vits-piper-en_US-amy-low', modelDir);
    console.log('Engine initialized');
    await NativeSherpaOnnxTTS.speak('Hello! This is Sherpa ONNX offline TTS working in LN Reader.');
    console.log('Phase 2: Speech complete');
  } catch (e) {
    console.error('Phase 2 FAIL:', e);
  }
};

<Button title="Test Sherpa Speech" onPress={testSherpa} />
```

- [ ] **Step 2: Run on device and tap the button**

Expected: You hear the sentence spoken aloud. Check Metro logs for `Phase 2: Speech complete`.

Common failure: `ClassNotFoundException: com.k2fsa.sherpa.onnx.OfflineTts` — AAR is not in `libs/` or `fileTree` dep is missing. Verify `android/app/libs/sherpa-onnx-android.aar` exists and re-sync.

Common failure: `UnsatisfiedLinkError` — check `pickFirst '**/libc++_shared.so'` is in `packagingOptions`.

- [ ] **Step 3: Remove the test button**

- [ ] **Step 4: Commit**

```bash
git add android/app/libs/sherpa-onnx-android.aar \
  android/app/build.gradle \
  android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/NativeSherpaOnnxTTS.kt \
  src/assets/sherpa_models.json
git commit -m "feat(tts): integrate Sherpa-ONNX AAR and implement AudioTrack synthesis (Phase 2)"
```

---

## Chunk 3: Phase 3 — Voice Registry + Download Manager

### Task 11: Create the Voice Registry

**Files:**
- Create: `src/utils/sherpaVoiceRegistry.ts`

> **Context:** This module is the single source of truth for voice metadata and disk state. It reads the bundled manifest, tracks installed voices in MMKV, and delegates downloading/extraction to `expo-file-system` (for the download) and `NativeSherpaOnnxTTS.extractTarBz2` (for the archive). All voice files live at `<filesDir>/models/<voiceId>/`.

- [ ] **Step 1: Create the registry file**

```typescript
// src/utils/sherpaVoiceRegistry.ts
// NOTE: createDownloadResumable lives in the legacy subpath — not the new entry point
import * as FileSystem from 'expo-file-system/legacy';
import { MMKVStorage } from '@utils/mmkv/mmkv'; // use the existing MMKV instance
import NativeSherpaOnnxTTS from '../../specs/NativeSherpaOnnxTTSSpec';
import rawManifest from '../assets/sherpa_models.json';

export interface VoiceEntry {
  id: string;
  model_type: 'vits' | 'mms' | 'kokoro';
  name: string;
  developer: string;
  quality: string;
  filesize_mb: number;
  url: string;
  compression: boolean;
  sample_rate: number;
  num_speakers: number;
  language: Array<{ lang_code: string; language_name: string; country: string }>;
}

const INSTALLED_KEY = 'sherpa_installed_voices';

// Filter out unsupported model types (matcha) at module load time
const MANIFEST: Record<string, VoiceEntry> = Object.fromEntries(
  Object.entries(rawManifest as Record<string, any>)
    .filter(([, v]) => ['vits', 'mms', 'kokoro'].includes(v.model_type))
    .map(([k, v]) => [
      k,
      {
        id: v.id ?? k,
        model_type: v.model_type,
        name: v.name ?? k,
        developer: v.developer ?? '',
        quality: v.quality ?? '',
        filesize_mb: v.filesize_mb ?? 0,
        url: v.url ?? '',
        compression: v.compression ?? true,
        sample_rate: v.sample_rate ?? 22050,
        num_speakers: v.num_speakers ?? 1,
        language: v.language ?? [],
      } as VoiceEntry,
    ])
);

// ── Public API ────────────────────────────────────────────────────────────────

export function getVoiceManifest(): VoiceEntry[] {
  return Object.values(MANIFEST);
}

export function isVoiceInstalled(voiceId: string): boolean {
  const stored = MMKVStorage.getString(INSTALLED_KEY);
  if (!stored) return false;
  const ids: string[] = JSON.parse(stored);
  return ids.includes(voiceId);
}

export function listInstalledVoices(): string[] {
  const stored = MMKVStorage.getString(INSTALLED_KEY);
  if (!stored) return [];
  return JSON.parse(stored);
}

export async function getModelDir(voiceId: string): Promise<string> {
  const filesDir = await NativeSherpaOnnxTTS.getFilesDir();
  return `${filesDir}/models/${voiceId}`;
}

export async function downloadVoice(
  voiceId: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  const entry = MANIFEST[voiceId];
  if (!entry) throw new Error(`Voice ${voiceId} not found in manifest`);

  const filesDir = await NativeSherpaOnnxTTS.getFilesDir();
  const voiceDir = `${filesDir}/models/${voiceId}`;
  const tempPath = `${filesDir}/models/${voiceId}.download`;

  // Ensure voice directory exists
  await FileSystem.makeDirectoryAsync(voiceDir, { intermediates: true });

  if (entry.model_type === 'mms') {
    // MMS: download model.onnx and tokens.txt individually (no archive)
    const baseUrl = entry.url; // URL points to the directory
    await downloadFile(`${baseUrl}/model.onnx`, `${voiceDir}/model.onnx`, p => onProgress(p * 0.5));
    await downloadFile(`${baseUrl}/tokens.txt`, `${voiceDir}/tokens.txt`, p => onProgress(50 + p * 0.5));
  } else {
    // VITS / Kokoro: download tar.bz2, extract to a temp dir, then rename to voiceId.
    // Sherpa-ONNX archives extract to a directory named by the archive (e.g. "vits-piper-en_US-amy-low"),
    // but that name may differ from the manifest id. We extract to a temp dir and rename for consistency.
    const extractTempDir = `${filesDir}/models/_extract_tmp`;
    await downloadFile(entry.url, tempPath, p => onProgress(p * 0.7));
    onProgress(70);
    // Extract archive — creates a subdirectory inside extractTempDir
    await NativeSherpaOnnxTTS.extractTarBz2(tempPath, extractTempDir);
    // Delete archive
    await FileSystem.deleteAsync(tempPath, { idempotent: true });
    // Find the single directory that was created inside extractTempDir
    const extracted = await FileSystem.readDirectoryAsync(extractTempDir);
    if (extracted.length === 0) throw new Error('Archive extracted empty');
    const extractedDir = `${extractTempDir}/${extracted[0]}`;
    // Move (rename) it to the canonical voiceId path
    await FileSystem.moveAsync({ from: extractedDir, to: voiceDir });
    await FileSystem.deleteAsync(extractTempDir, { idempotent: true });
    onProgress(95);
  }

  // Write voice.json sidecar
  const sidecar = {
    id: entry.id,
    model_type: entry.model_type,
    sample_rate: entry.sample_rate,
    num_speakers: entry.num_speakers,
  };
  await FileSystem.writeAsStringAsync(
    `${voiceDir}/voice.json`,
    JSON.stringify(sidecar),
  );

  // Mark as installed in MMKV
  const current = listInstalledVoices();
  if (!current.includes(voiceId)) {
    MMKVStorage.set(INSTALLED_KEY, JSON.stringify([...current, voiceId]));
  }

  onProgress(100);
}

export async function deleteVoice(voiceId: string): Promise<void> {
  await NativeSherpaOnnxTTS.deleteVoiceDir(voiceId);
  const current = listInstalledVoices().filter(id => id !== voiceId);
  MMKVStorage.set(INSTALLED_KEY, JSON.stringify(current));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  const download = FileSystem.createDownloadResumable(
    url,
    destPath,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite > 0) {
        onProgress((totalBytesWritten / totalBytesExpectedToWrite) * 100);
      }
    },
  );
  const result = await download.downloadAsync();
  if (!result || result.status !== 200) {
    throw new Error(`Download failed for ${url}: status ${result?.status}`);
  }
}
```

> **Note:** Replace `MMKVStorage` import path with the actual MMKV instance used in the project. Check existing imports in files like `src/hooks/persisted/useSettings.ts` to find the correct path.

---

### Task 12: Verify Phase 3 on Device

- [ ] **Step 1: Add a temporary test in TTSTab.tsx**

```typescript
import { downloadVoice, listInstalledVoices, getModelDir } from '@utils/sherpaVoiceRegistry';

const testDownload = async () => {
  console.log('Starting download...');
  await downloadVoice('vits-piper-en_US-amy-low', pct => console.log(`Progress: ${pct.toFixed(0)}%`));
  console.log('Installed voices:', listInstalledVoices());
  const dir = await getModelDir('vits-piper-en_US-amy-low');
  console.log('Model dir:', dir);
};
<Button title="Test Download" onPress={testDownload} />
```

- [ ] **Step 2: Run on device, tap button, watch Metro logs**

Expected:
```
Starting download...
Progress: 10%
...
Progress: 100%
Installed voices: ["vits-piper-en_US-amy-low"]
Model dir: /data/user/0/com.rajarsheechatterjee.LNReader/files/models/vits-piper-en_US-amy-low
```

- [ ] **Step 3: Verify files on device**

```bash
adb shell ls /data/data/com.rajarsheechatterjee.LNReader/files/models/vits-piper-en_US-amy-low/
```
Expected: `model.onnx  tokens.txt  lexicon.txt  voice.json` (lexicon.txt may be absent for some models)

- [ ] **Step 4: Remove test button, commit**

```bash
git add src/utils/sherpaVoiceRegistry.ts src/assets/sherpa_models.json
git commit -m "feat(tts): add sherpaVoiceRegistry with download and extraction (Phase 3)"
```

---

## Chunk 4: Phase 4 — JS Wrapper + Sentence Streaming

### Task 13: Create the JS Wrapper

**Files:**
- Create: `src/utils/sherpaOnnxTTS.ts`

> **Context:** This module sits between WebViewReader and the native module. It handles: sentence-level chunking (so generation is fast per chunk), sequential awaiting (no overlap), cancellation (stop mid-chapter), and voice initialization. The `startElement(text, onDone)` method is what WebViewReader will call — it processes all sentences from one readable element, then calls `onDone()` which advances the WebView cursor.

- [ ] **Step 1: Create the wrapper**

```typescript
// src/utils/sherpaOnnxTTS.ts
import NativeSherpaOnnxTTS from '../../specs/NativeSherpaOnnxTTSSpec';
import { getModelDir } from './sherpaVoiceRegistry';

let currentVoiceId: string | null = null;
let engineReady = false;
let generation = 0;  // incremented on each startElement call to detect stale runs
let paused = false;

// ── Sentence splitting ────────────────────────────────────────────────────────

/**
 * Split text into synthesis-sized chunks.
 * Step 1: split on sentence-ending punctuation
 * Step 2: split any chunk >200 chars on , or ;
 * Step 3: hard-split any remaining chunk >200 chars at last word boundary
 */
export function splitIntoChunks(text: string): string[] {
  // Step 1: split on . ! ? followed by whitespace or end
  const sentences = text
    .split(/(?<=[.!?])\s+|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= 200) {
      chunks.push(sentence);
    } else {
      // Step 2: split on , or ;
      const subParts = sentence
        .split(/(?<=[,;])\s+/)
        .map(s => s.trim())
        .filter(Boolean);

      for (const part of subParts) {
        if (part.length <= 200) {
          chunks.push(part);
        } else {
          // Step 3: hard-split at last word boundary before 200 chars
          let remaining = part;
          while (remaining.length > 200) {
            const slice = remaining.slice(0, 200);
            const lastSpace = slice.lastIndexOf(' ');
            const cutAt = lastSpace > 0 ? lastSpace : 200;
            chunks.push(remaining.slice(0, cutAt).trim());
            remaining = remaining.slice(cutAt).trim();
          }
          if (remaining) chunks.push(remaining);
        }
      }
    }
  }

  return chunks.filter(Boolean);
}

// ── Voice initialization ──────────────────────────────────────────────────────

export async function setVoice(voiceId: string): Promise<void> {
  if (currentVoiceId === voiceId && engineReady) return;
  const modelDir = await getModelDir(voiceId);
  await NativeSherpaOnnxTTS.initEngine(voiceId, modelDir);
  currentVoiceId = voiceId;
  engineReady = true;
}

// ── Playback control ──────────────────────────────────────────────────────────

export async function pause(): Promise<void> {
  paused = true;
  await NativeSherpaOnnxTTS.pause();
}

export async function resume(): Promise<void> {
  paused = false;
  await NativeSherpaOnnxTTS.resume();
}

export async function stop(): Promise<void> {
  generation++; // invalidate any in-flight _runElement
  paused = false;
  await NativeSherpaOnnxTTS.stop();
}

// ── Primary entry point (called from WebViewReader) ───────────────────────────

/**
 * Process one readable element from the WebView.
 * Splits into chunks, speaks each sequentially, then calls onDone()
 * which advances the WebView cursor to the next element.
 *
 * Uses a generation counter to handle rapid successive calls safely:
 * if a new startElement() arrives before the previous one finishes,
 * the old run detects the stale generation and exits without calling onDone().
 */
export function startElement(text: string, onDone: () => void): void {
  const myGen = ++generation;
  _runElement(text, onDone, myGen).catch(e => {
    console.warn('[SherpaOnnxTTS] startElement error:', e);
  });
}

async function _runElement(text: string, onDone: () => void, gen: number): Promise<void> {
  if (!engineReady) {
    console.warn('[SherpaOnnxTTS] Engine not ready — call setVoice first');
    onDone();
    return;
  }

  const chunks = splitIntoChunks(text);

  for (const chunk of chunks) {
    if (gen !== generation) return; // superseded by a newer call or stop()
    await NativeSherpaOnnxTTS.speak(chunk);
    if (gen !== generation) return;
  }

  // All chunks done — advance WebView cursor
  onDone();
}
```

---

### Task 14: Verify Phase 4 on Device

- [ ] **Step 1: Write a unit test for splitIntoChunks**

Create `src/utils/__tests__/sherpaOnnxTTS.test.ts`:

```typescript
import { splitIntoChunks } from '../sherpaOnnxTTS';

test('short sentence stays as one chunk', () => {
  const result = splitIntoChunks('Hello world.');
  expect(result).toEqual(['Hello world.']);
});

test('splits on sentence boundaries', () => {
  const result = splitIntoChunks('First sentence. Second sentence! Third?');
  expect(result).toHaveLength(3);
});

test('chunks over 200 chars split on comma', () => {
  const long = 'A'.repeat(150) + ', ' + 'B'.repeat(150) + '.';
  const result = splitIntoChunks(long);
  expect(result.every(c => c.length <= 200)).toBe(true);
  expect(result.length).toBeGreaterThan(1);
});

test('no chunk exceeds 200 chars', () => {
  const monstrous = 'word '.repeat(100); // 500 chars, no punctuation
  const result = splitIntoChunks(monstrous);
  expect(result.every(c => c.length <= 200)).toBe(true);
});

test('empty text returns empty array', () => {
  expect(splitIntoChunks('')).toEqual([]);
  expect(splitIntoChunks('   ')).toEqual([]);
});
```

Run tests:
```bash
npx jest src/utils/__tests__/sherpaOnnxTTS.test.ts --no-coverage
```
Expected: all 5 tests pass.

- [ ] **Step 2: Manually test streaming on device**

Add a temporary test button in TTSTab.tsx:

```typescript
import { setVoice, startElement, stop } from '@utils/sherpaOnnxTTS';

const testStreaming = async () => {
  await setVoice('vits-piper-en_US-amy-low');
  const longText = `
    The sun rises in the east and sets in the west. Every day brings new opportunities.
    She walked through the ancient forest, marveling at the towering trees. Birds sang
    in the canopy above. The path wound its way between mossy boulders and fern-covered
    hillsides. She had never felt so at peace. At last, she reached the clearing.
  `.trim();
  startElement(longText, () => console.log('Phase 4: Element done, cursor would advance'));
};

<Button title="Test Streaming" onPress={testStreaming} />
<Button title="Stop" onPress={stop} />
```

Expected: Paragraph reads continuously without noticeable gaps between sentences. "Stop" cuts off immediately.

- [ ] **Step 3: Remove test buttons, commit**

```bash
git add src/utils/sherpaOnnxTTS.ts \
  src/utils/__tests__/sherpaOnnxTTS.test.ts
git commit -m "feat(tts): add sherpaOnnxTTS wrapper with sentence streaming and cancellation (Phase 4)"
```

---

## Chunk 5: Phase 5 — Settings + TTSTab UI

### Task 15: Update Settings

**Files:**
- Modify: `src/hooks/persisted/useSettings.ts`

> **Context:** `ChapterReaderSettings` needs two new fields. They must also appear in `initialChapterReaderSettings` (the default object used on first install) AND in the migration spread inside `useChapterReaderSettings` (so existing users whose stored settings predate this change get valid defaults rather than `undefined`).

- [ ] **Step 1: Add fields to the `ChapterReaderSettings` interface** (around line 111)

Add after the `tts?` block:
```typescript
ttsEngine?: 'system' | 'sherpa';
sherpaTtsVoiceId?: string;
```

- [ ] **Step 2: Add defaults to `initialChapterReaderSettings`** (around line 212, after `epubUseCustomJS`)

Add:
```typescript
ttsEngine: 'system',
sherpaTtsVoiceId: undefined,
```

- [ ] **Step 3: Add to the migration spread in `useChapterReaderSettings`** (around line 282)

The existing spread looks like:
```typescript
const chapterReaderSettings = {
  ...storedSettings,
  tts: {
    ...initialChapterReaderSettings.tts,
    ...storedSettings.tts,
    autoPageAdvance: storedSettings.tts?.autoPageAdvance ?? false,
    scrollToTop: storedSettings.tts?.scrollToTop ?? true,
    rate: storedSettings.tts?.rate ?? 1,
    pitch: storedSettings.tts?.pitch ?? 1,
  },
};
```

Add the two new fields to the spread:
```typescript
const chapterReaderSettings = {
  ...storedSettings,
  tts: {
    ...initialChapterReaderSettings.tts,
    ...storedSettings.tts,
    autoPageAdvance: storedSettings.tts?.autoPageAdvance ?? false,
    scrollToTop: storedSettings.tts?.scrollToTop ?? true,
    rate: storedSettings.tts?.rate ?? 1,
    pitch: storedSettings.tts?.pitch ?? 1,
  },
  ttsEngine: storedSettings.ttsEngine ?? 'system',
  sherpaTtsVoiceId: storedSettings.sherpaTtsVoiceId,
};
```

---

### Task 16: Build the Offline TTS UI in TTSTab

**Files:**
- Modify: `src/screens/reader/components/ReaderBottomSheet/TTSTab.tsx`

> **Context:** The current TTSTab shows system voice picker + speed/pitch/etc. We add a segmented control at the top that switches between "System TTS" and "Offline TTS". When "Offline TTS" is selected, replace the voice picker section with a language filter + scrollable voice list where each voice has Download/Select/Delete actions.

- [ ] **Step 1: Add the engine toggle near the top of the TTSTab component**

Add the new imports at the top of the file (alongside existing imports):
```typescript
import { getVoiceManifest, downloadVoice, deleteVoice, listInstalledVoices } from '@utils/sherpaVoiceRegistry';
import { setVoice } from '@utils/sherpaOnnxTTS';
```

`useChapterReaderSettings` is **already imported** in the file — do NOT add a second import. Instead, add `ttsEngine` and `sherpaTtsVoiceId` to the existing destructure inside the component:

```typescript
// Find the existing line like:
const { tts, setChapterReaderSettings } = useChapterReaderSettings();
// Change it to:
const { tts, ttsEngine, sherpaTtsVoiceId, setChapterReaderSettings } = useChapterReaderSettings();
```

Then add the new state variables and engine toggle UI:
const [langFilter, setLangFilter] = useState<string>('all');
const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
const [installedVoices, setInstalledVoices] = useState<string[]>(() =>
  listInstalledVoices()
);

// Engine toggle UI (add below the existing TTS enable toggle):
<View style={styles.row}>
  <Text style={styles.label}>Engine</Text>
  <View style={styles.segmentedControl}>
    {(['system', 'sherpa'] as const).map(engine => (
      <Pressable
        key={engine}
        style={[
          styles.segment,
          ttsEngine === engine && styles.segmentActive,
        ]}
        onPress={() => setChapterReaderSettings({ ttsEngine: engine })}
      >
        <Text style={[styles.segmentText, ttsEngine === engine && styles.segmentTextActive]}>
          {engine === 'system' ? 'System TTS' : 'Offline TTS'}
        </Text>
      </Pressable>
    ))}
  </View>
</View>
```

- [ ] **Step 2: Conditionally show either system voice picker or offline voice list**

Wrap the existing voice picker in `{ttsEngine !== 'sherpa' && ( ... )}`.

Below it, add the offline section:

```typescript
{ttsEngine === 'sherpa' && (
  <View>
    {/* Language filter */}
    <Picker
      selectedValue={langFilter}
      onValueChange={v => setLangFilter(v)}
    >
      <Picker.Item label="All languages" value="all" />
      {[...new Set(
        getVoiceManifest().flatMap(v => v.language.map(l => l.language_name))
      )].sort().map(lang => (
        <Picker.Item key={lang} label={lang} value={lang} />
      ))}
    </Picker>

    {/* Voice list */}
    <ScrollView style={{ maxHeight: 300 }}>
      {getVoiceManifest()
        .filter(v =>
          langFilter === 'all' ||
          v.language.some(l => l.language_name === langFilter)
        )
        .map(voice => {
          const installed = installedVoices.includes(voice.id);
          const isActive = sherpaTtsVoiceId === voice.id;
          const progress = downloadProgress[voice.id];
          const isDownloading = progress !== undefined && progress < 100;

          return (
            <View key={voice.id} style={styles.voiceRow}>
              <View style={styles.voiceInfo}>
                <Text style={styles.voiceName}>{voice.name}</Text>
                <Text style={styles.voiceMeta}>
                  {voice.language[0]?.language_name} · {voice.developer} · {voice.filesize_mb.toFixed(0)}MB
                </Text>
              </View>
              <View style={styles.voiceActions}>
                {isDownloading ? (
                  <Text>{progress.toFixed(0)}%</Text>
                ) : installed ? (
                  <>
                    {isActive ? (
                      <Text style={styles.activeLabel}>✓ Active</Text>
                    ) : (
                      <Pressable onPress={async () => {
                        await setVoice(voice.id);
                        setChapterReaderSettings({ sherpaTtsVoiceId: voice.id });
                      }}>
                        <Text style={styles.selectButton}>Select</Text>
                      </Pressable>
                    )}
                    <Pressable onPress={async () => {
                      await deleteVoice(voice.id);
                      setInstalledVoices(listInstalledVoices());
                      if (isActive) setChapterReaderSettings({ sherpaTtsVoiceId: undefined });
                    }}>
                      <Text style={styles.deleteButton}>Delete</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable onPress={async () => {
                    await downloadVoice(voice.id, pct => {
                      setDownloadProgress(prev => ({ ...prev, [voice.id]: pct }));
                    });
                    setInstalledVoices(listInstalledVoices());
                    setDownloadProgress(prev => {
                      const next = { ...prev };
                      delete next[voice.id];
                      return next;
                    });
                  }}>
                    <Text style={styles.downloadButton}>
                      Download ({voice.filesize_mb.toFixed(0)}MB)
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
    </ScrollView>
  </View>
)}
```

- [ ] **Step 3: Add the required styles to the StyleSheet**

```typescript
voiceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#555' },
voiceInfo: { flex: 1, marginRight: 8 },
voiceName: { fontWeight: 'bold' },
voiceMeta: { fontSize: 11, color: '#999' },
voiceActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
activeLabel: { color: '#4CAF50' },
selectButton: { color: '#2196F3' },
deleteButton: { color: '#F44336' },
downloadButton: { color: '#FF9800' },
segmentedControl: { flexDirection: 'row', borderWidth: 1, borderColor: '#555', borderRadius: 6, overflow: 'hidden' },
segment: { paddingHorizontal: 12, paddingVertical: 6 },
segmentActive: { backgroundColor: '#2196F3' },
segmentText: { color: '#aaa' },
segmentTextActive: { color: '#fff' },
```

- [ ] **Step 4: Verify Phase 5 on device**

- Open reader → TTS tab
- Toggle to "Offline TTS" — voice list appears, no crash
- Download a voice — progress percentage shows, completes
- Select the voice — checkmark appears
- Toggle back to "System TTS" — original UI returns unchanged
- Delete the voice — it returns to "Download" state

- [ ] **Step 5: Commit**

```bash
git add src/hooks/persisted/useSettings.ts \
  src/screens/reader/components/ReaderBottomSheet/TTSTab.tsx
git commit -m "feat(tts): add settings fields and offline TTS voice picker UI (Phase 5)"
```

---

## Chunk 6: Phase 6 — WebViewReader Integration

### Task 17: Route speakText Through Engine Setting

**Files:**
- Modify: `src/screens/reader/components/WebViewReader.tsx`

> **Context:** `speakText()` currently calls `Speech.speak()` and passes an `onDone` callback that calls `tts.next?.()` in the WebView to advance the cursor. For Sherpa TTS, we call `sherpaOnnxTTS.startElement(text, onDone)` instead — same contract, `onDone` still calls `tts.next?.()`. The pause/resume/stop cases in `onMessage` also need to branch.

- [ ] **Step 1: Add the import at the top of WebViewReader.tsx**

```typescript
import * as sherpaOnnxTTS from '@utils/sherpaOnnxTTS';
```

- [ ] **Step 2: Initialize the Sherpa engine when the engine setting is 'sherpa'**

Inside the component, add a `useEffect` that initializes the voice when `ttsEngine` or `sherpaTtsVoiceId` changes. Use `readerSettings` (the state value) for the dependency array so the effect re-runs on changes, and read from `readerSettingsRef.current` inside the effect body for the up-to-date value:

```typescript
// readerSettings is the useState value; readerSettingsRef.current is the ref kept in sync with it.
// Use readerSettings.* in the dep array (state triggers re-renders),
// but read from readerSettingsRef.current inside the effect (always current).
useEffect(() => {
  const { ttsEngine, sherpaTtsVoiceId } = readerSettingsRef.current;
  if (ttsEngine === 'sherpa' && sherpaTtsVoiceId) {
    sherpaOnnxTTS.setVoice(sherpaTtsVoiceId).catch(e =>
      console.warn('[WebViewReader] Sherpa setVoice failed:', e)
    );
  }
}, [readerSettings.ttsEngine, readerSettings.sherpaTtsVoiceId]);
```

- [ ] **Step 3: Update `speakText()`**

Replace the current `speakText` function body with:

```typescript
const speakText = (text: string) => {
  const settings = readerSettingsRef.current;

  if (settings.ttsEngine === 'sherpa') {
    sherpaOnnxTTS.startElement(text, () => {
      // Same onDone logic as system TTS
      const isBackground =
        appStateRef.current === 'background' ||
        appStateRef.current === 'inactive';

      if (isBackground) {
        isTTSReadingRef.current = false;
        dismissTTSNotification();
        webViewRef.current?.injectJavaScript('tts.stop?.()');
        return;
      }
      webViewRef.current?.injectJavaScript('tts.next?.()');
    });
    return;
  }

  // Original system TTS path — unchanged
  Speech.speak(text, {
    onDone() {
      const isBackground =
        appStateRef.current === 'background' ||
        appStateRef.current === 'inactive';

      if (
        isBackground &&
        ttsQueueRef.current.length > 0 &&
        ttsQueueIndexRef.current + 1 < ttsQueueRef.current.length
      ) {
        const nextIndex = ttsQueueIndexRef.current + 1;
        const nextText = ttsQueueRef.current[nextIndex];
        if (nextText) {
          ttsQueueIndexRef.current = nextIndex;
          speakText(nextText);
          return;
        }
      }

      if (isBackground) {
        isTTSReadingRef.current = false;
        dismissTTSNotification();
        webViewRef.current?.injectJavaScript('tts.stop?.()');
        return;
      }

      webViewRef.current?.injectJavaScript('tts.next?.()');
    },
    voice: settings.tts?.voice?.identifier,
    pitch: settings.tts?.pitch || 1,
    rate: settings.tts?.rate || 1,
  });
};
```

- [ ] **Step 4: Update pause/resume/stop in the `onMessage` handler**

Find where `pause-speak`, `stop-speak` are handled in the `onMessage` callback and add engine routing:

```typescript
// In the onMessage switch/if cases:
// NOTE: Speech.pause() is NOT available on Android (expo-speech limitation).
// The existing code already uses Speech.stop() for pause — keep that unchanged.
case 'pause-speak':
  if (readerSettingsRef.current.ttsEngine === 'sherpa') {
    sherpaOnnxTTS.pause();
  } else {
    Speech.stop(); // intentional: pause is unavailable on Android
  }
  break;

case 'stop-speak':
  if (readerSettingsRef.current.ttsEngine === 'sherpa') {
    sherpaOnnxTTS.stop();
  } else {
    Speech.stop();
  }
  break;
```

And for resume (check the existing resume handling):
```typescript
// In resume handler:
if (readerSettingsRef.current.ttsEngine === 'sherpa') {
  sherpaOnnxTTS.resume();
} else {
  Speech.resume?.();
}
```

- [ ] **Step 5: Verify Phase 6 on device**

- Select "Offline TTS" in TTSTab, pick and download a voice, select it
- Open a novel chapter and start TTS
- Expected: chapter reads aloud using the downloaded voice
- Pause → speech stops; Resume → speech continues
- Stop → speech stops, cursor resets
- Switch back to System TTS → it reads using system voice (regression check)

- [ ] **Step 6: Commit**

```bash
git add src/screens/reader/components/WebViewReader.tsx
git commit -m "feat(tts): route WebViewReader through Sherpa engine when selected (Phase 6)"
```

---

## Chunk 7: Phase 7 — MediaSession Controls

### Task 18: Route MediaSession Events to Sherpa Engine

**Files:**
- Modify: `src/utils/ttsNotification.ts` (or wherever `TTSPause`, `TTSStop`, etc. are consumed)

> **Context:** The existing `NativeTTSMediaControl` native module emits events (`TTSPlay`, `TTSPause`, `TTSStop`, `TTSNext`, `TTSPrev`, `TTSRewind`) to JS when the user taps notification bar buttons. These events are currently handled in `WebViewReader.tsx` or `ttsNotification.ts` and post commands to the WebView. We only need to add Sherpa engine routing — no native module changes.

- [ ] **Step 1: Find where TTSPause/TTSStop/TTSPlay events are handled**

```bash
grep -rn "TTSPause\|TTSStop\|TTSPlay" src/
```

Note the file and line numbers.

> **Important:** The native `NativeTTSMediaControl` module emits `TTSPlay` for **both** play and resume (there is no `TTSResume` event). The existing JS handler for `TTSPlay` calls `tts.resume()` in the WebView. When adding the Sherpa branch, listen for `TTSPlay` — not `TTSResume`.

- [ ] **Step 2: Add engine routing to each event handler**

For each event that controls playback (TTSPause, TTSStop, TTSPlay/TTSResume), add a branch:

```typescript
// Example pattern — adapt to the actual code you find:
const handleTTSPause = () => {
  if (readerSettingsRef.current.ttsEngine === 'sherpa') {
    sherpaOnnxTTS.pause();
  } else {
    // existing system TTS pause (e.g. postMessage to WebView)
  }
};

const handleTTSStop = () => {
  if (readerSettingsRef.current.ttsEngine === 'sherpa') {
    sherpaOnnxTTS.stop();
  } else {
    // existing system TTS stop
  }
};
```

- [ ] **Step 3: Verify Phase 7 on device**

- Start reading a chapter with Offline TTS selected
- Lock the screen — notification bar controls should be visible
- Tap Pause → speech pauses
- Tap Play/Resume → speech resumes
- Tap Stop → speech stops

- [ ] **Step 4: Commit**

```bash
git add src/utils/ttsNotification.ts  # or whatever file you modified
git commit -m "feat(tts): route MediaSession notification controls to Sherpa engine (Phase 7)"
```

---

## Verification Checklist (all phases complete)

- [ ] System TTS still works after all changes (regression test)
- [ ] Switching between System TTS and Offline TTS mid-session does not crash
- [ ] Downloaded voices persist across app restarts (MMKV check)
- [ ] Deleting a voice that is currently selected gracefully falls back (no crash)
- [ ] Long chapters (50+ paragraphs) read end-to-end without memory growth
- [ ] Stop from notification bar works with screen off

## Final Commit

```bash
git add docs/superpowers/specs/2026-03-13-sherpa-onnx-tts-design.md \
  docs/superpowers/plans/2026-03-13-sherpa-onnx-tts.md
git commit -m "docs: add Sherpa-ONNX TTS spec and implementation plan"
```
