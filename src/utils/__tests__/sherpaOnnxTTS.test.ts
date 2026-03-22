/**
 * Tests for sherpaOnnxTTS.ts
 *
 * Covers:
 *  - splitIntoChunks (pure function — no mocks needed)
 *  - text normalisation effects visible through splitIntoChunks
 *  - startElement cancellation via _sessionId
 *  - setVoice no-op / re-init behaviour
 */

// sherpaVoiceRegistry is imported by setVoice; mock it so tests don't hit the filesystem
jest.mock('@utils/sherpaVoiceRegistry', () => ({
  initRegistry: jest.fn().mockResolvedValue(undefined),
  getModelDir: jest.fn().mockReturnValue('/mock/files/models/test-voice'),
}));

import NativeSherpaOnnxTTS from '@specs/NativeSherpaOnnxTTS';
import { splitIntoChunks, setVoice, startElement, stop, deinit, isEngineReady } from '../sherpaOnnxTTS';

// Convenience cast so TypeScript lets us call jest mock helpers
const mockSpeakAll = NativeSherpaOnnxTTS.speakAll as jest.Mock;
const mockStop = NativeSherpaOnnxTTS.stop as jest.Mock;
const mockInitEngine = NativeSherpaOnnxTTS.initEngine as jest.Mock;

// ── splitIntoChunks ───────────────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  it('returns a single chunk for a short sentence', () => {
    const result = splitIntoChunks('Hello world.');
    expect(result).toEqual(['Hello world.']);
  });

  it('splits on sentence-ending punctuation', () => {
    const result = splitIntoChunks('Hello world. How are you? I am fine!');
    expect(result).toEqual(['Hello world.', 'How are you?', 'I am fine!']);
  });

  it('handles sentence ending with closing quote', () => {
    const result = splitIntoChunks('He said "hello." She replied "goodbye."');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('He said "hello."');
    expect(result[1]).toBe('She replied "goodbye."');
  });

  it('splits a long sentence on commas when over MAX_CHUNK', () => {
    // Each segment is ~50 chars; 15 segments joined by ", " = ~780 chars total (> MAX_CHUNK=600)
    const segment = 'a somewhat longer phrase to pad the length here';
    const long = Array(15).fill(segment).join(', ') + '.';
    expect(long.length).toBeGreaterThan(600); // confirm precondition
    const result = splitIntoChunks(long);
    expect(result.length).toBeGreaterThan(1);
    result.forEach(chunk => expect(chunk.length).toBeLessThanOrEqual(800));
  });

  it('hard-splits at word boundary for extremely long runs without punctuation', () => {
    const words = Array(200).fill('word').join(' '); // ~800 chars, no punctuation
    const result = splitIntoChunks(words);
    expect(result.length).toBeGreaterThan(1);
    result.forEach(chunk => expect(chunk.length).toBeLessThanOrEqual(800));
    // Chunks should not split mid-word
    result.forEach(chunk => expect(chunk).not.toMatch(/^-/));
  });

  it('returns empty array for empty string', () => {
    expect(splitIntoChunks('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(splitIntoChunks('   ')).toEqual([]);
  });

  it('normalises curly quotes to ASCII before splitting', () => {
    // Curly quotes would previously cause Piper model runaway — must be converted
    const result = splitIntoChunks('\u201CHello,\u201D she said. \u2018Goodbye,\u2019 he replied.');
    expect(result).toHaveLength(2);
    // Normalised output should contain plain ASCII quotes
    result.forEach(chunk => {
      expect(chunk).not.toMatch(/[\u2018\u2019\u201C\u201D]/);
    });
  });

  it('normalises em-dash to ASCII hyphen', () => {
    const result = splitIntoChunks('He waited\u2014and waited.');
    expect(result[0]).toContain(' - ');
  });

  it('normalises ellipsis to three dots', () => {
    const result = splitIntoChunks('He paused\u2026 then spoke.');
    expect(result.join(' ')).toContain('...');
  });

  it('replaces non-latin unicode with space', () => {
    // Japanese characters should become spaces, not be passed raw to the model
    const result = splitIntoChunks('Hello \u4e16\u754c world.');
    expect(result[0]).not.toMatch(/[\u4e16\u754c]/);
    expect(result[0]).toContain('Hello');
    expect(result[0]).toContain('world');
  });

  it('does not create empty chunks', () => {
    const result = splitIntoChunks('One. Two. Three.');
    result.forEach(chunk => expect(chunk.length).toBeGreaterThan(0));
  });
});

// ── setVoice ─────────────────────────────────────────────────────────────────

describe('setVoice', () => {
  beforeEach(() => {
    // Reset engine state before each test by deiniting
    jest.clearAllMocks();
  });

  it('calls initEngine on first load', async () => {
    await deinit(); // ensure clean state
    jest.clearAllMocks();
    await setVoice('en_US-amy-medium');
    expect(mockInitEngine).toHaveBeenCalledWith('en_US-amy-medium', '/mock/files/models/test-voice');
  });

  it('is a no-op if same voice is already loaded', async () => {
    await deinit();
    jest.clearAllMocks();
    await setVoice('en_US-amy-medium');
    await setVoice('en_US-amy-medium'); // second call — same voice
    expect(mockInitEngine).toHaveBeenCalledTimes(1);
  });

  it('re-initialises when voice changes', async () => {
    await deinit();
    jest.clearAllMocks();
    await setVoice('en_US-amy-medium');
    await setVoice('en_GB-alan-medium');
    expect(mockInitEngine).toHaveBeenCalledTimes(2);
  });

  it('isEngineReady returns true after setVoice and false after deinit', async () => {
    await deinit();
    expect(isEngineReady()).toBe(false);
    await setVoice('en_US-amy-medium');
    expect(isEngineReady()).toBe(true);
    await deinit();
    expect(isEngineReady()).toBe(false);
  });
});

// ── startElement / cancellation ───────────────────────────────────────────────

describe('startElement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: speakAll resolves immediately
    mockSpeakAll.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  it('calls speakAll with chunked text and invokes onDone', async () => {
    const onDone = jest.fn();
    startElement('Hello world. How are you?', 1.0, onDone);
    // Flush the async microtask queue
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSpeakAll).toHaveBeenCalledWith(
      expect.arrayContaining(['Hello world.', 'How are you?']),
      1.0,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('passes speed to speakAll', async () => {
    const onDone = jest.fn();
    startElement('Test sentence.', 1.5, onDone);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSpeakAll).toHaveBeenCalledWith(expect.any(Array), 1.5);
  });

  it('superseding startElement cancels onDone of previous session', async () => {
    const onDone1 = jest.fn();
    const onDone2 = jest.fn();

    // Make speakAll block until manually resolved
    let resolve1!: () => void;
    let resolve2!: () => void;
    mockSpeakAll
      .mockImplementationOnce(() => new Promise<void>(r => { resolve1 = r; }))
      .mockImplementationOnce(() => new Promise<void>(r => { resolve2 = r; }));

    startElement('First paragraph.', 1.0, onDone1);
    // Flush stop() + start of speakAll for session 1
    await Promise.resolve();
    await Promise.resolve();

    // Session 2 starts before session 1 finishes
    startElement('Second paragraph.', 1.0, onDone2);
    await Promise.resolve();
    await Promise.resolve();

    // Session 1 speakAll resolves — onDone1 must NOT fire (session superseded)
    resolve1();
    await Promise.resolve();
    expect(onDone1).not.toHaveBeenCalled();

    // Session 2 speakAll resolves — onDone2 SHOULD fire
    resolve2();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDone2).toHaveBeenCalledTimes(1);
  });

  it('stop() prevents onDone from firing', async () => {
    const onDone = jest.fn();
    let resolveSpeak!: () => void;
    mockSpeakAll.mockImplementationOnce(
      () => new Promise<void>(r => { resolveSpeak = r; }),
    );

    startElement('Some text.', 1.0, onDone);
    await Promise.resolve();
    await Promise.resolve();

    await stop(); // increments _sessionId

    resolveSpeak(); // speakAll finishes, but session is stale
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).not.toHaveBeenCalled();
  });

  it('always calls native stop() before speakAll to prevent overlap', async () => {
    startElement('Text.', 1.0, jest.fn());
    await Promise.resolve();
    await Promise.resolve();
    expect(mockStop).toHaveBeenCalled();
    expect(mockSpeakAll).toHaveBeenCalled();
    // stop must have been called before speakAll
    const stopOrder = mockStop.mock.invocationCallOrder[0];
    const speakOrder = mockSpeakAll.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(speakOrder);
  });
});
