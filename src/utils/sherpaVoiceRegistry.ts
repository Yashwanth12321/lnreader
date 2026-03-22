import { NativeEventEmitter, NativeModules } from 'react-native';
import NativeFile from '@specs/NativeFile';
import NativeSherpaOnnxTTS from '@specs/NativeSherpaOnnxTTS';
import { getMMKVObject, setMMKVObject } from './mmkv/mmkv';

const fileEmitter = new NativeEventEmitter(NativeModules.NativeFile);

// ── Types ──────────────────────────────────────────────────────────────────

export interface VoiceEntry {
  id: string;
  model_type: 'vits' | 'mms' | 'kokoro' | 'matcha';
  developer: string;
  name: string;
  language: { lang_code: string; language_name: string; country: string }[];
  quality: string;
  sample_rate: number;
  num_speakers: number;
  url: string;
  compression: boolean; // false = MMS (direct files), true = tar.bz2 archive
  filesize_mb: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MMKV_INSTALLED_KEY = 'sherpa_installed_voices';
const MMKV_DOWNLOADING_KEY = 'sherpa_downloading_voice';
const MMKV_EXTRACTING_KEY = 'sherpa_extracting_voice';

// Load manifest once at module init; filter unsupported model types
const MANIFEST: Record<string, VoiceEntry> = (() => {
  const raw = require('../assets/sherpa_models.json') as Record<string, VoiceEntry>;
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v.model_type !== 'matcha'),
  );
})();

// ── Manifest ───────────────────────────────────────────────────────────────

/** Returns all supported voices from the bundled manifest. */
export function getVoiceManifest(): VoiceEntry[] {
  return Object.values(MANIFEST);
}

// ── Installed tracking ─────────────────────────────────────────────────────

/** Returns the IDs of all locally installed voices. */
export function listInstalledVoices(): string[] {
  return getMMKVObject<string[]>(MMKV_INSTALLED_KEY) ?? [];
}

/** Returns true if a voice is downloaded and ready to use. */
export function isVoiceInstalled(voiceId: string): boolean {
  return listInstalledVoices().includes(voiceId);
}

/** Returns the voice ID that is currently being downloaded, or null. */
export function getDownloadingVoiceId(): string | null {
  return getMMKVObject<string>(MMKV_DOWNLOADING_KEY) ?? null;
}

/** Returns the voice ID currently being extracted (tar.bz2 → files), or null. */
export function getExtractingVoiceId(): string | null {
  return getMMKVObject<string>(MMKV_EXTRACTING_KEY) ?? null;
}

/**
 * Eagerly clears the MMKV download/extract flags.
 * Called from TTSTab when the user cancels so the flags don't linger
 * while the native call winds down in the background.
 */
export function clearDownloadState(): void {
  setMMKVObject(MMKV_DOWNLOADING_KEY, null);
  setMMKVObject(MMKV_EXTRACTING_KEY, null);
}

// ── Paths ──────────────────────────────────────────────────────────────────

// Cached after first call to ensureFilesDir()
let _filesDir: string | null = null;

async function ensureFilesDir(): Promise<string> {
  if (!_filesDir) {
    _filesDir = await NativeSherpaOnnxTTS.getFilesDir();
  }
  return _filesDir;
}

/**
 * Returns the absolute path to a voice's model directory.
 * Requires initRegistry() to have been called first.
 */
export function getModelDir(voiceId: string): string {
  if (!_filesDir) {
    throw new Error('sherpaVoiceRegistry: call initRegistry() before getModelDir()');
  }
  return `${_filesDir}/models/${voiceId}`;
}

/** Call once at app start (or before any getModelDir() call) to prime the cache. */
export async function initRegistry(): Promise<void> {
  await ensureFilesDir();
}

// ── Download ───────────────────────────────────────────────────────────────

/**
 * Mutable token passed into downloadVoice so the caller can cancel mid-flight.
 * downloadVoice writes removeSubscription onto the token as soon as the listener
 * is registered, so the caller can tear it down immediately on cancel without
 * waiting for the native download to finish.
 */
export type CancelToken = {
  cancelled: boolean;
  removeSubscription?: () => void;
  /** Aborts the in-flight native HTTP download immediately. Written by downloadVoice. */
  cancelNativeDownload?: () => void;
};

/** Returns true if an error was thrown due to user cancellation (not a real failure). */
export function isDownloadCancelled(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as any).__cancelled === true);
}

/**
 * Downloads and installs a voice.
 * onProgress receives values 0–<1 during download (byte fraction),
 * exactly 1.0 when extraction begins, and resolves when fully installed.
 */
export async function downloadVoice(
  voiceId: string,
  onProgress?: (fraction: number) => void,
  cancelToken?: CancelToken,
): Promise<void> {
  const entry = MANIFEST[voiceId];
  if (!entry) throw new Error(`Unknown voice ID: ${voiceId}`);

  const filesDir = await ensureFilesDir();
  const destDir = `${filesDir}/models/${voiceId}`;

  NativeFile.mkdir(destDir);
  setMMKVObject(MMKV_DOWNLOADING_KEY, voiceId); // persist in-progress state across navigation
  onProgress?.(0);

  // Give each archive attempt a unique temp filename using a timestamp so that
  // the NativeFile_downloadProgress destPath filter can distinguish a zombie
  // download from a fresh retry of the same model (same entry.id, same destDir).
  const archiveTempPath = entry.compression === false
    ? null
    : `${filesDir}/models/${entry.id}.${Date.now()}.tmp.tar.bz2`;

  // Each download writes to a unique path. The NativeFile_downloadProgress
  // event payload includes destPath, so we drop events from zombie downloads
  // (cancelled at JS layer but still running natively) by matching on that field.
  const expectedDestPath = archiveTempPath ?? `${destDir}/model.onnx`;

  let subscriptionRemoved = false;
  const subscription = onProgress
    ? fileEmitter.addListener(
        'NativeFile_downloadProgress',
        (e: { destPath: string; loaded: number; total: number }) => {
          // Drop events from other (zombie) downloads still running natively.
          if (e.destPath !== expectedDestPath) return;
          // Cap at 0.99 so the UI never shows 100% during the download phase —
          // 1.0 is reserved to mean "Extracting…" and is set explicitly below.
          if (e.total > 0) onProgress(Math.min(e.loaded / e.total, 0.99));
        },
      )
    : null;
  const removeSubscription = () => {
    if (!subscriptionRemoved) {
      subscriptionRemoved = true;
      subscription?.remove();
    }
  };
  // Expose both the listener removal and native HTTP cancellation on the token
  // so handleCancelDownload can abort everything immediately.
  if (cancelToken) {
    cancelToken.removeSubscription = removeSubscription;
    cancelToken.cancelNativeDownload = () => {
      try { NativeFile.cancelDownload(expectedDestPath); } catch { /* ignore */ }
    };
  }

  const throwIfCancelled = () => {
    if (cancelToken?.cancelled) {
      const e = new Error('Download cancelled') as any;
      e.__cancelled = true;
      throw e;
    }
  };

  try {
    if (entry.compression === false) {
      // MMS voices: individual files, no archive
      await downloadMmsVoice(entry, destDir);
      throwIfCancelled();
    } else {
      // VITS / Kokoro voices: tar.bz2 archive.
      // Signal extraction phase before it starts so the UI can update immediately.
      await downloadArchiveVoice(entry, destDir, archiveTempPath!, () => {
        // Don't start extraction if already cancelled
        if (cancelToken?.cancelled) return;
        setMMKVObject(MMKV_EXTRACTING_KEY, voiceId); // persist phase for remount recovery
        removeSubscription();  // stop download events — we're past the download phase
        onProgress?.(1.0);     // 1.0 → "Extracting…" in the UI
      });
      throwIfCancelled();
    }

    // Write voice.json sidecar
    NativeFile.writeFile(
      `${destDir}/voice.json`,
      JSON.stringify({
        id: entry.id,
        model_type: entry.model_type,
        sample_rate: entry.sample_rate,
        num_speakers: entry.num_speakers,
      }),
    );

    // Mark installed and clear the in-progress flag
    const installed = listInstalledVoices();
    if (!installed.includes(voiceId)) {
      setMMKVObject(MMKV_INSTALLED_KEY, [...installed, voiceId]);
    }
    setMMKVObject(MMKV_DOWNLOADING_KEY, null);
    setMMKVObject(MMKV_EXTRACTING_KEY, null);
  } catch (e) {
    setMMKVObject(MMKV_DOWNLOADING_KEY, null); // clear flags on failure too
    setMMKVObject(MMKV_EXTRACTING_KEY, null);
    throw e;
  } finally {
    removeSubscription();
  }
}

async function downloadArchiveVoice(
  entry: VoiceEntry,
  destDir: string,
  tempPath: string,
  onExtracting?: () => void,
): Promise<void> {
  try {
    await NativeFile.downloadFile(entry.url, tempPath, 'GET', {}, undefined);
    onExtracting?.(); // signal UI before extraction starts (can be slow)
    // Kotlin extractTarBz2 deletes tempPath in its finally block
    await NativeSherpaOnnxTTS.extractTarBz2(tempPath, destDir);
  } finally {
    // Belt-and-suspenders: also try from JS in case Kotlin cleanup failed
    try {
      if (NativeFile.exists(tempPath)) NativeFile.unlink(tempPath);
    } catch { /* ignore */ }
  }
}

async function downloadMmsVoice(
  entry: VoiceEntry,
  destDir: string,
): Promise<void> {
  // MMS models ship as individual files at the same base URL
  const baseUrl = entry.url.substring(0, entry.url.lastIndexOf('/'));
  await NativeFile.downloadFile(`${baseUrl}/model.onnx`, `${destDir}/model.onnx`, 'GET', {}, undefined);
  await NativeFile.downloadFile(`${baseUrl}/tokens.txt`, `${destDir}/tokens.txt`, 'GET', {}, undefined);
}

// ── Delete ─────────────────────────────────────────────────────────────────

/** Deletes a voice and removes it from the installed list. */
export async function deleteVoice(voiceId: string): Promise<void> {
  await NativeSherpaOnnxTTS.deleteVoiceDir(voiceId);
  setMMKVObject(
    MMKV_INSTALLED_KEY,
    listInstalledVoices().filter(id => id !== voiceId),
  );
}
