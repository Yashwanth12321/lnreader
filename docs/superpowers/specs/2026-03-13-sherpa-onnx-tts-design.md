# Offline TTS via Sherpa-ONNX — Design Spec

**Date:** 2026-03-13
**Branch:** feat/sherpa-tts
**Status:** Approved

---

## Background

LNReader currently uses `expo-speech` (system TTS) for read-aloud functionality. System voices are robotic and limited. This feature adds a second TTS engine — Sherpa-ONNX — enabling high-quality offline voices (Piper, Kokoro, MMS, Coqui VITS) downloaded on-demand to the device. The existing system TTS remains available as the default.

---

## Goals

- Offline, high-quality TTS voices running fully on-device (Android first)
- Sentence-level streaming so speech starts in under 200ms
- Voice download / delete management within the app
- Zero regression to existing system TTS behavior
- Phased delivery so each increment is independently verifiable

---

## Non-Goals

- iOS support (out of scope for this iteration)
- Cloud TTS or any network-dependent synthesis
- Matcha/OnlineTTS models (streaming architecture differs; excluded from this spec)
- Voice training or custom model creation

---

## Architecture

Five layers, each with a single responsibility:

```
┌─────────────────────────────────────┐
│  TTSTab UI                          │  Engine toggle + voice library
├─────────────────────────────────────┤
│  sherpaOnnxTTS.ts                   │  Sentence splitter, streaming coordinator
├─────────────────────────────────────┤
│  sherpaVoiceRegistry.ts             │  Manifest parser, download manager
├─────────────────────────────────────┤
│  NativeSherpaOnnxTTS.kt             │  Model lifecycle, PCM → AudioTrack
├─────────────────────────────────────┤
│  Sherpa-ONNX AAR (C++ runtime)      │  ONNX inference
└─────────────────────────────────────┘
```

### Data Flow (reading a chapter)

1. WebView JS sends one `speak` message per readable element (paragraph / block)
2. `WebViewReader.speakText()` checks `ttsEngine` setting
3. If `'sherpa'`: passes the element text to `sherpaOnnxTTS.startElement(text, onDone)`
4. JS splits the element into synthesis chunks (sentences), `await speak(chunk)` for each sequentially
5. After all chunks in the element complete, `onDone()` calls `tts.next?.()` in the WebView — cursor advances to the next element (same contract as system TTS)
6. Sentence splitting is **synthesis chunking only** — it does not advance the WebView cursor; the cursor advances once per element, exactly as it does today

---

## Component Specifications

### 1. Native Module — `NativeSherpaOnnxTTS.kt`

**Location:** `android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/`

**Two files required, following the exact pattern of `NativeTTSMediaControl`:**
- `NativeSherpaOnnxTTS.kt` — extends `NativeSherpaOnnxTTSSpec`, implements the module
- `NativeSherpaOnnxTTSPackage.kt` — extends **`BaseReactPackage`** (not `ReactPackage`) and implements `getReactModuleInfoProvider()`. Must NOT use the old `createNativeModules()` pattern, which is incompatible with New Architecture TurboModule resolution.

**TurboModule Spec** (`specs/NativeSherpaOnnxTTSSpec.ts`):

```typescript
// @flow strict-local
// @platformOS android

import type {TurboModule} from 'react-native/Libraries/TurboModule/RCTExport';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  initEngine(voiceId: string, modelDir: string): Promise<void>;
  speak(text: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  deinitEngine(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSherpaOnnxTTS');
```

The `@platformOS android` annotation tells the iOS codegen to skip this spec entirely, preventing iOS build warnings and stale-type errors. No entry in `codegenConfig.ios.modulesProvider` is needed.

**Model lifecycle:**
- Model stays loaded in memory between `speak()` calls
- `initEngine()` is called only on voice switch, not per element or sentence
- If `initEngine()` is called while a model is already loaded, it **automatically calls `deinitEngine()` first** — no double-init memory leak, no manual deInit needed before switching voices
- `deinitEngine()` is also exposed explicitly for when the user disables Offline TTS entirely

**Supported model types** (offline only — Matcha/OnlineTTS excluded):

| model_type | Sherpa-ONNX Config |
|---|---|
| `vits` | `OfflineTtsVitsModelConfig` (lexicon + espeak-ng-data) |
| `mms` | `OfflineTtsVitsModelConfig` (tokens only, no lexicon) |
| `kokoro` | `OfflineTtsKokoroModelConfig` |

The native module reads `model_type` from the sidecar `voice.json` stored alongside model files to select the correct config at init time.

**AudioTrack threading:**
All `AudioTrack` calls (`play()`, `pause()`, `stop()`, `write()`) and all ONNX inference run on a single dedicated background `HandlerThread` (named `audioHandler`). Each exposed method posts work to `audioHandler` and resolves its Promise only after the operation completes on that thread. Calling AudioTrack from the React Native JS thread will cause `IllegalStateException` — the handler dispatch model prevents this entirely.

**AAR integration:**

Place `sherpa-onnx-android.aar` in `android/app/libs/`. Add to `android/app/build.gradle`:

```groovy
android {
    defaultConfig {
        ndk {
            // Restrict to ABIs present in the Sherpa-ONNX AAR.
            // NOTE: this drops x86 emulator support. Use x86_64 or arm64-v8a emulators.
            abiFilters "arm64-v8a", "x86_64"
        }
    }

    packagingOptions {
        // Sherpa-ONNX AAR and the existing CMake appmodules target both
        // may ship libc++_shared.so. Pick the first to avoid duplicate .so errors.
        pickFirst '**/libc++_shared.so'
    }
}

dependencies {
    implementation fileTree(dir: 'libs', include: ['*.aar'])
}
```

The `abiFilters` applies to both the AAR's bundled `.so` files and the existing `externalNativeBuild` CMake target (`appmodules`) — this is intentional and keeps both in sync. The `pickFirst` rule resolves the STL conflict at packaging time.

The existing `CMakeLists.txt` must NOT reference or link any Sherpa-ONNX symbols. The Kotlin API surface of the AAR is accessed directly from Kotlin without CMake involvement.

**Codegen prerequisites (Phase 1):**
1. Write `specs/NativeSherpaOnnxTTSSpec.ts` (with `@platformOS android`)
2. Run `./gradlew generateCodegenArtifactsFromSchema` or `npx react-native run-android`
3. Register `NativeSherpaOnnxTTSPackage()` in `MainApplication.kt` inside `getPackages()`

---

### 2. Voice Registry — `sherpaVoiceRegistry.ts`

**Location:** `src/utils/sherpaVoiceRegistry.ts`

**Voice manifest** (`models.json`) bundled at:
`android/app/src/main/assets/models.json`

At startup, the registry reads this file via `require()` and filters out `model_type: 'matcha'` entries (unsupported in this iteration).

**Storage:** `context.filesDir` (internal app-private storage). Chosen over `getExternalFilesDir()` because: no runtime permissions required, backed up with app data, inaccessible to other apps. Trade-off: counts against the app's private storage quota. Voice list UI shows file size in MB before download.

**Storage path:**
```
<filesDir>/models/<voiceId>/
  model.onnx
  tokens.txt
  lexicon.txt         (optional, VITS only)
  espeak-ng-data/     (optional, VITS with espeak)
  voice.json          (sidecar: id, model_type, sample_rate, num_speakers)
```

**API:**

```typescript
getVoiceManifest(): VoiceEntry[]
listInstalledVoices(): string[]
isVoiceInstalled(voiceId: string): boolean
downloadVoice(voiceId: string, onProgress: (pct: number) => void): Promise<void>
deleteVoice(voiceId: string): Promise<void>
getModelDir(voiceId: string): string
```

**Download handling:**
- `tar.bz2` archives: streamed fetch → temp file → extracted, temp deleted
- MMS models: individual `model.onnx` + `tokens.txt` fetched directly (no archive)
- After extraction: writes `voice.json` sidecar from manifest entry
- Installed voice IDs persisted in MMKV for fast startup listing

---

### 3. JS Wrapper — `sherpaOnnxTTS.ts`

**Location:** `src/utils/sherpaOnnxTTS.ts`

**WebView cursor contract:**
`startElement(text, onDone)` is the primary entry point called from `WebViewReader.speakText()`. It splits the element text into synthesis chunks, speaks each sequentially, then calls `onDone()` once all chunks complete. `onDone` maps to `tts.next?.()` in the WebView — cursor advances once per element. Sentence splitting is synthesis-only chunking; it does not affect cursor advancement.

**Sentence splitting algorithm (three-step, in order):**
1. Split on `.`, `!`, `?` followed by whitespace or end-of-string
2. For any segment longer than 200 characters, split further on `,` or `;`
3. For any segment still longer than 200 characters, hard-split at the last word boundary before the 200-character mark (never mid-word)

**Cancellation:**
A `cancelled: boolean` flag is checked between each `await speak(chunk)` call. `stop()` sets this flag. After `stop()`, no further chunks are submitted even if the current `speak()` Promise is in flight.

**API:**

```typescript
startElement(text: string, onDone: () => void): void  // primary entry from WebViewReader
pause(): Promise<void>
resume(): Promise<void>
stop(): Promise<void>
setVoice(voiceId: string): Promise<void>
```

---

### 4. Settings Changes — `useSettings.ts`

New fields added to **both** `ChapterReaderSettings` type **and** `initialChapterReaderSettings` default object **and** the migration guard in `useChapterReaderSettings`:

```typescript
// In ChapterReaderSettings type:
ttsEngine?: 'system' | 'sherpa'   // default: 'system'
sherpaTtsVoiceId?: string          // default: undefined

// In initialChapterReaderSettings:
ttsEngine: 'system',
sherpaTtsVoiceId: undefined,
```

The migration spread in `useChapterReaderSettings` must include these fields with their defaults so existing users whose stored settings predate this change receive valid values rather than `undefined`.

The existing `tts.voice` field remains typed as `expo-speech.Voice` and is only read when `ttsEngine === 'system'`. No union type widening is needed.

---

### 5. UI Changes — `TTSTab.tsx`

**Engine toggle:** Segmented control at top of TTS section
- Options: `System TTS` | `Offline TTS`
- Switching persists to settings immediately

**System TTS section** (unchanged when System TTS selected):
- Existing voice picker, speed, pitch, auto-advance, scroll-to-top

**Offline TTS section** (shown when Offline TTS selected):
- Language filter dropdown
- Voice list rows: name, developer, language, quality badge, file size in MB
- Actions per row: `Download` (with progress bar) → `Select` → active checkmark; `Delete` (with confirmation)
- Speed + pitch controls (fed to Sherpa synthesis parameters)
- Auto-advance + scroll-to-top (unchanged, apply to both engines)

---

### 6. WebViewReader Changes

`speakText()` updated:

```typescript
if (ttsEngine === 'sherpa') {
  sherpaOnnxTTS.startElement(text, onDone)  // onDone → tts.next?.()
} else {
  Speech.speak(text, { voice: tts?.voice?.identifier, pitch, rate, onDone })
}
```

`pause()`, `resume()`, `stop()` in `onMessage` also branch on engine. No changes to WebView JS (`core.js`) or TTS CSS.

---

### 7. MediaSession Integration (Phase 7)

**JS-layer-only change.** `NativeTTSMediaControl.kt` is not modified. The JS event handlers (`TTSPlay`, `TTSPause`, `TTSStop`, `TTSNext`, `TTSPrev`, `TTSRewind`) in `WebViewReader.tsx` / `ttsNotification.ts` are updated to call `sherpaOnnxTTS.pause()` / `stop()` / `resume()` when `ttsEngine === 'sherpa'`.

---

## Delivery Phases

| Phase | Deliverable | Verify on Device |
|---|---|---|
| 1 | `NativeSherpaOnnxTTSSpec.ts` → codegen → empty `NativeSherpaOnnxTTS.kt` + `NativeSherpaOnnxTTSPackage.kt` (BaseReactPackage) registered | `NativeSherpaOnnxTTS.initEngine()` callable from JS test button, no crash |
| 2 | Sherpa-ONNX AAR + `packagingOptions` + one voice `adb push`ed, real `initEngine()` + `speak()` + AudioTrack on HandlerThread | Tap button → hear speech |
| 3 | `sherpaVoiceRegistry.ts` + download + `voice.json` sidecar + MMKV tracking | Download a voice in-app; verify files via `adb shell` |
| 4 | `sherpaOnnxTTS.ts` with `startElement()` + sentence chunking + cancellation | 5-paragraph text reads gap-free; Stop cuts off immediately |
| 5 | `TTSTab` engine toggle + voice list UI + download/select/delete | Switch engines, download, select, delete — no crash |
| 6 | `WebViewReader` routing + settings migration guard | Read a full chapter end-to-end; pause and resume mid-sentence |
| 7 | MediaSession JS handlers route to Sherpa engine | Control from notification bar with screen off |

---

## File Inventory

### New Files
```
specs/NativeSherpaOnnxTTSSpec.ts
src/utils/sherpaVoiceRegistry.ts
src/utils/sherpaOnnxTTS.ts
android/app/libs/sherpa-onnx-android.aar
android/app/src/main/java/com/rajarsheechatterjee/NativeSherpaOnnxTTS/
  NativeSherpaOnnxTTS.kt
  NativeSherpaOnnxTTSPackage.kt
android/app/src/main/assets/models.json
```

### Modified Files
```
android/app/build.gradle                          (fileTree AAR + abiFilters + packagingOptions)
android/app/src/main/java/.../MainApplication.kt  (register NativeSherpaOnnxTTSPackage)
src/hooks/persisted/useSettings.ts                (type + initialSettings + migration guard)
src/screens/reader/components/ReaderBottomSheet/TTSTab.tsx
src/screens/reader/components/WebViewReader.tsx
```

---

## Key Constraints

- Models stay loaded between sentences; no re-init per element or sentence
- `initEngine()` auto-deinits any prior model before loading the new one
- First audio chunk plays within 200ms of element start
- All AudioTrack + ONNX inference on a dedicated `HandlerThread`; all native methods `Promise<void>`
- `@platformOS android` on spec file — iOS codegen ignores this module
- `NativeSherpaOnnxTTSPackage` extends `BaseReactPackage` + implements `getReactModuleInfoProvider()` (New Architecture pattern)
- `packagingOptions { pickFirst '**/libc++_shared.so' }` resolves STL conflict with existing CMake target
- System TTS path unaffected when `ttsEngine === 'system'`
- Matcha excluded; supported types: `vits`, `mms`, `kokoro`
- `abiFilters "arm64-v8a", "x86_64"` — x86 emulator support dropped
- Voice files in `context.filesDir` only
- Settings migration guard required for `ttsEngine` + `sherpaTtsVoiceId` fields
- WebView cursor advances once per element (not per sentence); sentence split is synthesis chunking only
