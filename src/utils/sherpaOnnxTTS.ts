import NativeSherpaOnnxTTS from '@specs/NativeSherpaOnnxTTS';
import { getModelDir, initRegistry } from './sherpaVoiceRegistry';

// ── Text normalisation ────────────────────────────────────────────────────────

/**
 * Converts Unicode punctuation that Piper/VITS models aren't trained on into
 * plain ASCII equivalents. Prevents the model generating huge silence blocks.
 */
function normaliseText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'") // curly single quotes → '
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"') // curly double quotes → "
    .replace(/[\u2013\u2014\u2015]/g, ' - ')                 // en/em dash → -
    .replace(/\u2026/g, '...')                                // ellipsis → ...
    .replace(/[\u00AB\u00BB]/g, '"')                          // « » → "
    .replace(/[^\u0000-\u007F\u00C0-\u024F]/g, ' ')           // other non-latin → space
    .replace(/\s{2,}/g, ' ')                                  // collapse multi-spaces
    .trim();
}

// ── Sentence splitting ────────────────────────────────────────────────────────

const MAX_CHUNK = 600;
const MAX_HARD = 800;

/**
 * Splits a block of text into synthesis chunks small enough for low-latency
 * generation. Three-step algorithm per spec:
 *  1. Split on sentence-ending punctuation (. ! ?) optionally followed by a
 *     closing quote/bracket, then whitespace or EOS
 *  2. For chunks still > MAX_CHUNK, split further on , or ;
 *  3. For chunks still > MAX_CHUNK, hard-split at the last word boundary before MAX_CHUNK
 */
export function splitIntoChunks(text: string): string[] {
  const normalised = normaliseText(text);

  // Step 1 — sentence boundaries (handles `wind."` and `wind.' ` patterns)
  const sentences = normalised
    .split(/(?<=[.!?]["\u2019\u201D)}\]]?)(?=\s|$)/)
    .map(s => s.trim())
    .filter(Boolean);

  // Step 2 — long segments split on , or ;
  const afterComma: string[] = [];
  for (const seg of sentences) {
    if (seg.length <= MAX_CHUNK) {
      afterComma.push(seg);
    } else {
      const parts = seg
        .split(/(?<=[,;])/)
        .map(s => s.trim())
        .filter(Boolean);
      afterComma.push(...parts);
    }
  }

  // Step 3 — hard word-boundary split for anything still too long
  const chunks: string[] = [];
  for (const seg of afterComma) {
    if (seg.length <= MAX_CHUNK) {
      chunks.push(seg);
      continue;
    }
    let remaining = seg;
    while (remaining.length > MAX_CHUNK) {
      const slice = remaining.slice(0, MAX_HARD);
      const lastSpace = slice.lastIndexOf(' ');
      const cutAt = lastSpace > 0 ? lastSpace : MAX_HARD;
      chunks.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }
    if (remaining) chunks.push(remaining);
  }

  return chunks;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _currentVoiceId: string | null = null;
let _engineReady = false;
let _sessionId = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Loads the given voice if it isn't already loaded.
 * Safe to call redundantly — no-op if voiceId matches the current voice.
 */
export async function setVoice(voiceId: string): Promise<void> {
  if (_currentVoiceId === voiceId && _engineReady) return;
  await initRegistry();
  const modelDir = getModelDir(voiceId);
  await NativeSherpaOnnxTTS.initEngine(voiceId, modelDir);
  _currentVoiceId = voiceId;
  _engineReady = true;
}

/**
 * Primary entry point called from WebViewReader.
 * Splits `text` into sentences, speaks them sequentially, then calls `onDone`.
 * `onDone` maps to `tts.next?.()` in the WebView — cursor advances once per element.
 */
export function isEngineReady(): boolean {
  return _engineReady;
}

export function startElement(text: string, speed: number, onDone: () => void): void {
  const session = ++_sessionId;
  const chunks = splitIntoChunks(text);

  (async () => {
    // Always stop first — guarantees the native stop arrives at audioHandler
    // BEFORE any new speak(), preventing the stop from flushing the new paragraph.
    try { await NativeSherpaOnnxTTS.stop(); } catch {}

    if (_sessionId !== session) return; // superseded while stopping

    await NativeSherpaOnnxTTS.speakAll(chunks, speed);
    if (_sessionId === session) onDone();
  })().catch(e => {
    // swallow — error is non-fatal; session may already be superseded
  });
}

export async function pause(): Promise<void> {
  await NativeSherpaOnnxTTS.pause();
}

export async function resume(): Promise<void> {
  await NativeSherpaOnnxTTS.resume();
}

export async function stop(): Promise<void> {
  _sessionId++;
  await NativeSherpaOnnxTTS.stop();
}

export async function deinit(): Promise<void> {
  _sessionId++;
  _engineReady = false;
  _currentVoiceId = null;
  await NativeSherpaOnnxTTS.deinitEngine();
}
