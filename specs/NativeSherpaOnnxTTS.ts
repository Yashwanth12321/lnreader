import { TurboModule, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Engine lifecycle
  initEngine(voiceId: string, modelDir: string): Promise<void>;
  deinitEngine(): Promise<void>;

  // Synthesis + playback
  speak(text: string, speed: number): Promise<void>;
  speakAll(sentences: string[], speed: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;

  // Voice file utilities (used by sherpaVoiceRegistry.ts)
  getFilesDir(): Promise<string>;
  extractTarBz2(tarPath: string, destDir: string): Promise<void>;
  deleteVoiceDir(voiceId: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSherpaOnnxTTS');
