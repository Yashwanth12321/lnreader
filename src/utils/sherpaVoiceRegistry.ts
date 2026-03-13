import NativeFile from '@specs/NativeFile';
import NativeSherpaOnnxTTS from '@specs/NativeSherpaOnnxTTS';
import { getMMKVObject, setMMKVObject } from './mmkv/mmkv';

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
 * Downloads and installs a voice.
 * onProgress receives 0 at start and 1.0 at end.
 * Full per-byte progress requires a NativeFile extension (future phase).
 */
export async function downloadVoice(
  voiceId: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const entry = MANIFEST[voiceId];
  if (!entry) throw new Error(`Unknown voice ID: ${voiceId}`);

  const filesDir = await ensureFilesDir();
  const destDir = `${filesDir}/models/${voiceId}`;

  NativeFile.mkdir(destDir);
  onProgress?.(0);

  if (entry.compression === false) {
    // MMS voices: individual files, no archive
    await downloadMmsVoice(entry, destDir);
  } else {
    // VITS / Kokoro voices: tar.bz2 archive
    await downloadArchiveVoice(entry, destDir, filesDir);
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

  // Mark installed
  const installed = listInstalledVoices();
  if (!installed.includes(voiceId)) {
    setMMKVObject(MMKV_INSTALLED_KEY, [...installed, voiceId]);
  }

  onProgress?.(1.0);
}

async function downloadArchiveVoice(
  entry: VoiceEntry,
  destDir: string,
  filesDir: string,
): Promise<void> {
  const tempPath = `${filesDir}/models/${entry.id}.tmp.tar.bz2`;
  try {
    await NativeFile.downloadFile(entry.url, tempPath, 'GET', {});
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
  await NativeFile.downloadFile(`${baseUrl}/model.onnx`, `${destDir}/model.onnx`, 'GET', {});
  await NativeFile.downloadFile(`${baseUrl}/tokens.txt`, `${destDir}/tokens.txt`, 'GET', {});
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
