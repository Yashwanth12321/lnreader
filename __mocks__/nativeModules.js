// require('react-native-gesture-handler/jestSetup');
// require('react-native-reanimated').setUpTests();

jest.mock('@specs/NativeFile', () => ({
  __esModule: true,
  default: {
    writeFile: jest.fn(),
    readFile: jest.fn(() => ''),
    copyFile: jest.fn(),
    moveFile: jest.fn(),
    exists: jest.fn(() => true),
    mkdir: jest.fn(),
    unlink: jest.fn(),
    readDir: jest.fn(() => []),
    downloadFile: jest.fn().mockResolvedValue(),
    getConstants: jest.fn(() => ({
      ExternalDirectoryPath: '/mock/external',
      ExternalCachesDirectoryPath: '/mock/caches',
    })),
  },
}));

jest.mock('@specs/NativeEpub', () => ({
  __esModule: true,
  default: {
    parseNovelAndChapters: jest.fn(() => ({
      name: 'Mock Novel',
      cover: null,
      summary: null,
      author: null,
      artist: null,
      chapters: [],
      cssPaths: [],
      imagePaths: [],
    })),
  },
}));

jest.mock('@specs/NativeTTSMediaControl', () => ({
  __esModule: true,
  default: {
    showMediaNotification: jest.fn(),
    updatePlaybackState: jest.fn(),
    updateProgress: jest.fn(),
    dismiss: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

jest.mock('@specs/NativeVolumeButtonListener', () => ({
  __esModule: true,
  default: {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

jest.mock('@specs/NativeZipArchive', () => ({
  __esModule: true,
  default: {
    zip: jest.fn().mockResolvedValue(),
    unzip: jest.fn().mockResolvedValue(),
    remoteUnzip: jest.fn().mockResolvedValue(),
    remoteZip: jest.fn().mockResolvedValue(''),
  },
}));

jest.mock('@specs/NativeSherpaOnnxTTS', () => ({
  __esModule: true,
  default: {
    initEngine: jest.fn().mockResolvedValue(undefined),
    deinitEngine: jest.fn().mockResolvedValue(undefined),
    speak: jest.fn().mockResolvedValue(undefined),
    speakAll: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getFilesDir: jest.fn().mockResolvedValue('/mock/files'),
    extractTarBz2: jest.fn().mockResolvedValue(undefined),
    deleteVoiceDir: jest.fn().mockResolvedValue(undefined),
  },
}));
