import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  FlatList,
  SectionList,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import Slider from '@react-native-community/slider';
import { getAvailableVoicesAsync, Voice } from 'expo-speech';
import { getLocales } from 'expo-localization';
import {
  useTheme,
  useChapterGeneralSettings,
  useChapterReaderSettings,
} from '@hooks/persisted';
import { getString } from '@strings/translations';
import { List, Button } from '@components/index';
import { Portal, Modal, Chip } from 'react-native-paper';
import ReaderSheetPreferenceItem from './ReaderSheetPreferenceItem';
import {
  getVoiceManifest,
  listInstalledVoices,
  getDownloadingVoiceId,
  getExtractingVoiceId,
  clearDownloadState,
  downloadVoice,
  deleteVoice,
  initRegistry,
  isDownloadCancelled,
  CancelToken,
  VoiceEntry,
} from '@utils/sherpaVoiceRegistry';
import { setVoice as sherpaSetVoice, stop as sherpaStop } from '@utils/sherpaOnnxTTS';
import NativeSherpaOnnxTTS from '../../../../../specs/NativeSherpaOnnxTTS';

// ── System TTS voice picker modal ─────────────────────────────────────────────

interface VoicePickerModalProps {
  visible: boolean;
  onDismiss: () => void;
  voices: Voice[];
  onSelect: (voice: Voice) => void;
  currentVoice?: Voice;
}

const VoicePickerModal: React.FC<VoicePickerModalProps> = ({
  visible,
  onDismiss,
  voices,
  onSelect,
  currentVoice,
}) => {
  const theme = useTheme();
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const systemLocale = getLocales()[0]?.languageCode || 'en';

  const availableLanguages = useMemo(() => {
    const languages = new Set<string>();
    voices.forEach(voice => {
      if (voice.language) languages.add(voice.language.split('-')[0]);
    });
    return Array.from(languages).sort((a, b) => {
      if (a === systemLocale) return -1;
      if (b === systemLocale) return 1;
      return a.localeCompare(b);
    });
  }, [voices, systemLocale]);

  const filteredVoices = useMemo(() => {
    if (selectedLanguages.length === 0) {
      return voices.filter(v => {
        if (v.name === 'System') return true;
        return v.language?.split('-')[0] === systemLocale;
      });
    }
    return voices.filter(v => {
      if (v.name === 'System') return true;
      const lang = v.language?.split('-')[0];
      return lang && selectedLanguages.includes(lang);
    });
  }, [voices, selectedLanguages, systemLocale]);

  const toggleLanguage = (lang: string) =>
    setSelectedLanguages(prev =>
      prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang],
    );

  useEffect(() => {
    if (visible) setSelectedLanguages([]);
  }, [visible]);

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[styles.modalContent, { backgroundColor: theme.surface }]}
      >
        <Text style={[styles.modalTitle, { color: theme.onSurface }]}>Select Voice</Text>

        <View style={styles.languageFilterContainer}>
          <Text style={[styles.filterLabel, { color: theme.onSurfaceVariant }]}>
            Filter by language:
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {availableLanguages.map(lang => {
              const isActive =
                selectedLanguages.includes(lang) ||
                (selectedLanguages.length === 0 && lang === systemLocale);
              return (
                <Chip
                  key={lang}
                  selected={isActive}
                  onPress={() => toggleLanguage(lang)}
                  style={[styles.langChip, isActive && { backgroundColor: theme.primary }]}
                  textStyle={{ color: isActive ? theme.onPrimary : theme.onSurface, fontSize: 12 }}
                >
                  {lang.toUpperCase()}
                  {lang === systemLocale && ' (System)'}
                </Chip>
              );
            })}
          </ScrollView>
        </View>

        <FlatList
          data={filteredVoices}
          keyExtractor={(_, i) => String(i)}
          style={styles.voiceList}
          renderItem={({ item: voice }) => (
            <TouchableOpacity
              style={[
                styles.voiceItem,
                currentVoice?.identifier === voice.identifier && {
                  backgroundColor: theme.surfaceVariant,
                },
              ]}
              onPress={() => { onSelect(voice); onDismiss(); }}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.voiceItemText, { color: theme.onSurface }]}>
                  {voice.name}
                </Text>
                {voice.language && (
                  <Text style={[styles.voiceItemLang, { color: theme.onSurfaceVariant }]}>
                    {voice.language}
                  </Text>
                )}
              </View>
              {currentVoice?.identifier === voice.identifier && (
                <Text style={{ color: theme.primary, fontSize: 16 }}>✓</Text>
              )}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={[styles.emptyText, { color: theme.onSurfaceVariant }]}>
              No voices available for selected languages
            </Text>
          }
        />

        <Button title="Cancel" mode="outlined" onPress={onDismiss} style={{ marginTop: 16 }} />
      </Modal>
    </Portal>
  );
};

// ── Sherpa voice picker modal ─────────────────────────────────────────────────

interface SherpaVoicePickerModalProps {
  visible: boolean;
  onDismiss: () => void;
  voices: VoiceEntry[];
  installedVoices: string[];
  activeVoiceId?: string;
  downloadingId: string | null;
  downloadProgress: number;
  downloadQueue: string[];
  loadingModelId: string | null;
  onDownload: (id: string) => void;
  onCancelDownload: () => void;
  onCancelQueued: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

const SherpaVoicePickerModal: React.FC<SherpaVoicePickerModalProps> = ({
  visible,
  onDismiss,
  voices,
  installedVoices,
  activeVoiceId,
  downloadingId,
  downloadProgress,
  downloadQueue,
  loadingModelId,
  onDownload,
  onCancelDownload,
  onCancelQueued,
  onSelect,
  onDelete,
}) => {
  const theme = useTheme();
  const [langFilter, setLangFilter] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  const availableLangs = useMemo(() => {
    const set = new Set<string>();
    voices.forEach(v =>
      v.language.forEach(l => l.lang_code && set.add(l.lang_code.split('_')[0])),
    );
    return Array.from(set).sort();
  }, [voices]);

  const toggleLang = (lang: string) =>
    setLangFilter(prev =>
      prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang],
    );

  useEffect(() => {
    if (visible) {
      setLangFilter([]);
      setSearchQuery('');
    }
  }, [visible]);

  // Filter voices by search query and language chips
  const matchesSearch = useCallback((v: VoiceEntry, q: string) => {
    const lower = q.toLowerCase();
    return (
      v.name.toLowerCase().includes(lower) ||
      v.developer.toLowerCase().includes(lower) ||
      v.language.some(
        l =>
          l.language_name.toLowerCase().includes(lower) ||
          l.lang_code.toLowerCase().includes(lower),
      )
    );
  }, []);

  const sections = useMemo(() => {
    const q = searchQuery.trim();
    const byLang = (v: VoiceEntry) =>
      langFilter.length === 0 ||
      v.language.some(l => l.lang_code && langFilter.includes(l.lang_code.split('_')[0]));
    const bySearch = (v: VoiceEntry) => !q || matchesSearch(v, q);

    const downloaded = voices.filter(
      v => installedVoices.includes(v.id) && byLang(v) && bySearch(v),
    );
    const available = voices.filter(
      v => !installedVoices.includes(v.id) && byLang(v) && bySearch(v),
    );
    const result: { title: string; data: VoiceEntry[] }[] = [];
    if (downloaded.length > 0) result.push({ title: 'Downloaded', data: downloaded });
    if (available.length > 0) result.push({ title: 'Available', data: available });
    return result;
  }, [voices, installedVoices, langFilter, searchQuery, matchesSearch]);

  const renderRow = useCallback(
    ({ item: voice }: { item: VoiceEntry }) => {
      const isInstalled = installedVoices.includes(voice.id);
      const isActive = activeVoiceId === voice.id;
      const isDownloading = downloadingId === voice.id;
      const isQueued = downloadQueue.includes(voice.id);
      const isLoadingModel = loadingModelId === voice.id;
      const langLabel = voice.language.map(l => l.language_name).filter(Boolean).join(', ');

      return (
        <View
          style={[
            styles.sherpaRow,
            { borderBottomColor: theme.outline },
            isActive && { backgroundColor: theme.surfaceVariant },
          ]}
        >
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.sherpaVoiceName, { color: theme.onSurface }]}>
                {voice.name}
              </Text>
              {isActive && (
                <Text style={{ color: theme.primary, fontWeight: 'bold', marginLeft: 4 }}>✓</Text>
              )}
            </View>
            <Text style={[styles.sherpaVoiceMeta, { color: theme.onSurfaceVariant }]}>
              {voice.developer}
              {langLabel ? ` · ${langLabel}` : ''}
              {` · ${voice.quality} · ${voice.filesize_mb} MB`}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}>
            {isDownloading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={styles.progressContainer}>
                  <Text style={[styles.downloadStatus, { color: theme.onSurfaceVariant }]}>
                    {downloadProgress >= 1
                      ? 'Extracting…'
                      : downloadProgress > 0
                      ? `${Math.round(downloadProgress * 100)}%`
                      : `${voice.filesize_mb} MB`}
                  </Text>
                  {downloadProgress < 1 && (
                    <View style={[styles.progressTrack, { backgroundColor: theme.surfaceVariant }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            backgroundColor: theme.primary,
                            width: downloadProgress > 0 ? `${Math.round(downloadProgress * 100)}%` : '0%',
                          },
                        ]}
                      />
                    </View>
                  )}
                </View>
                <TouchableOpacity onPress={onCancelDownload} style={styles.cancelBtn}>
                  <Text style={[styles.cancelBtnText, { color: theme.onSurfaceVariant }]}>✕</Text>
                </TouchableOpacity>
              </View>
            ) : isInstalled ? (
              <>
                {isLoadingModel ? (
                  <Text style={[styles.downloadStatus, { color: theme.onSurfaceVariant }]}>
                    Loading model…
                  </Text>
                ) : (
                  <>
                    {!isActive && (
                      <TouchableOpacity
                        onPress={() => { onSelect(voice.id); onDismiss(); }}
                        style={styles.actionBtn}
                      >
                        <Text style={[styles.actionBtnText, { color: theme.primary }]}>Select</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={() => onDelete(voice.id)} style={styles.actionBtn}>
                      <Text style={[styles.actionBtnText, { color: theme.error }]}>Delete</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            ) : isQueued ? (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.downloadStatus, { color: theme.onSurfaceVariant }]}>
                  Queued
                </Text>
                <TouchableOpacity onPress={() => onCancelQueued(voice.id)} style={styles.cancelBtn}>
                  <Text style={[styles.cancelBtnText, { color: theme.onSurfaceVariant }]}>✕</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => onDownload(voice.id)} style={styles.actionBtn}>
                <Text style={[styles.actionBtnText, { color: theme.primary }]}>Download</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      );
    },
    [installedVoices, activeVoiceId, downloadingId, downloadProgress, downloadQueue, loadingModelId, theme, onDownload, onCancelDownload, onCancelQueued, onSelect, onDelete, onDismiss],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: { title: string; data: VoiceEntry[] } }) => (
      <View style={[styles.sectionHeader, { backgroundColor: theme.surface }]}>
        <Text style={[styles.sectionHeaderText, { color: theme.onSurfaceVariant }]}>
          {section.title}
          <Text style={{ fontWeight: 'normal' }}> ({section.data.length})</Text>
        </Text>
      </View>
    ),
    [theme],
  );

  const isEmpty = sections.length === 0;

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[styles.modalContent, { backgroundColor: theme.surface }]}
      >
        <Text style={[styles.modalTitle, { color: theme.onSurface }]}>Offline Voices</Text>

        {/* Search bar */}
        <View style={[styles.searchContainer, { backgroundColor: theme.surfaceVariant, borderColor: theme.outline }]}>
          <Text style={[styles.searchIcon, { color: theme.onSurfaceVariant }]}>⌕</Text>
          <TextInput
            style={[styles.searchInput, { color: theme.onSurface }]}
            placeholder="Search by name, language…"
            placeholderTextColor={theme.onSurfaceVariant}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.searchClear}>
              <Text style={{ color: theme.onSurfaceVariant, fontSize: 14 }}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Language filter chips */}
        {availableLangs.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.langFilterRow}
          >
            {availableLangs.map(lang => {
              const active = langFilter.includes(lang);
              return (
                <Chip
                  key={lang}
                  selected={active}
                  onPress={() => toggleLang(lang)}
                  style={[styles.langChip, active && { backgroundColor: theme.primary }]}
                  textStyle={{ color: active ? theme.onPrimary : theme.onSurface, fontSize: 12 }}
                >
                  {lang.toUpperCase()}
                </Chip>
              );
            })}
          </ScrollView>
        )}

        {isEmpty ? (
          <Text style={[styles.emptyText, { color: theme.onSurfaceVariant }]}>
            {searchQuery ? 'No voices match your search' : 'No voices found'}
          </Text>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={item => item.id}
            style={styles.voiceList}
            renderItem={renderRow}
            renderSectionHeader={renderSectionHeader}
            stickySectionHeadersEnabled
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            windowSize={5}
          />
        )}

        <Button title="Close" mode="outlined" onPress={onDismiss} style={{ marginTop: 16 }} />
      </Modal>
    </Portal>
  );
};

// ── Engine toggle ─────────────────────────────────────────────────────────────

const EngineToggle: React.FC<{
  value: 'system' | 'sherpa';
  onChange: (v: 'system' | 'sherpa') => void;
}> = ({ value, onChange }) => {
  const theme = useTheme();
  return (
    <View style={[styles.engineToggleRow, { borderColor: theme.outline }]}>
      {(['system', 'sherpa'] as const).map(opt => {
        const active = value === opt;
        return (
          <TouchableOpacity
            key={opt}
            style={[styles.engineToggleBtn, active && { backgroundColor: theme.primary }]}
            onPress={() => onChange(opt)}
          >
            <Text
              style={[
                styles.engineToggleText,
                { color: active ? theme.onPrimary : theme.onSurfaceVariant },
              ]}
            >
              {opt === 'system' ? 'System TTS' : 'Offline TTS'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

const TTSTab: React.FC = () => {
  const theme = useTheme();
  const { TTSEnable = true, setChapterGeneralSettings } = useChapterGeneralSettings();
  const {
    tts,
    ttsEngine = 'system',
    sherpaTtsVoiceId,
    sherpaSpeed = 1.0,
    setChapterReaderSettings,
  } = useChapterReaderSettings();

  // System TTS
  const [systemVoices, setSystemVoices] = useState<Voice[]>([]);
  const [systemModalVisible, setSystemModalVisible] = useState(false);

  useEffect(() => {
    getAvailableVoicesAsync().then(res => {
      res.sort((a, b) => a.name.localeCompare(b.name));
      setSystemVoices([{ name: 'System', language: 'System' } as Voice, ...res]);
    });
  }, []);

  const handleSystemVoiceSelect = useCallback(
    (voice: Voice) => setChapterReaderSettings({ tts: { ...tts, voice } }),
    [tts, setChapterReaderSettings],
  );

  // Sherpa TTS
  const [sherpaVoices, setSherpaVoices] = useState<VoiceEntry[]>([]);
  const [installedVoices, setInstalledVoices] = useState<string[]>([]);
  const [sherpaModalVisible, setSherpaModalVisible] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadQueue, setDownloadQueue] = useState<string[]>([]);
  const downloadingIdRef = useRef<string | null>(null); // ref mirrors state for use inside closures
  const queueRef = useRef<string[]>([]);                // ref mirrors state for use inside closures
  const cancelTokenRef = useRef<CancelToken | null>(null);
  const activeRunRef = useRef<object | null>(null);     // unique object per runDownload call
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    initRegistry().then(() => {
      setSherpaVoices(getVoiceManifest());
      setInstalledVoices(listInstalledVoices());
      // Restore in-progress download/extract state if user navigated away mid-operation
      const inProgress = getDownloadingVoiceId();
      if (inProgress) {
        setDownloadingId(inProgress);
        // If extraction was in progress, restore downloadProgress = 1.0 so the
        // UI shows "Extracting…" instead of the empty file-size state.
        if (getExtractingVoiceId() === inProgress) setDownloadProgress(1.0);
      }
    });
  }, []);

  const refreshInstalled = () => setInstalledVoices(listInstalledVoices());

  // Runs one download to completion, then pops and starts the next in the queue.
  // Using refs so the closure always sees the latest queue without stale captures.
  const runDownload = useCallback(async (voiceId: string) => {
    // Unique object per call — used in finally to detect if THIS run is still
    // the active one, even when the same voiceId is re-downloaded after a cancel.
    const runHandle = {};
    activeRunRef.current = runHandle;

    const token: CancelToken = { cancelled: false };
    cancelTokenRef.current = token;
    downloadingIdRef.current = voiceId;
    setDownloadingId(voiceId);
    setDownloadProgress(0);
    try {
      await downloadVoice(voiceId, p => setDownloadProgress(p), token);
      refreshInstalled();
      // Pre-warm: load the ONNX model immediately after install.
      setLoadingModelId(voiceId);
      try {
        await sherpaSetVoice(voiceId);
      } catch {
        // non-fatal — TTS will retry on first use
      } finally {
        setLoadingModelId(null);
      }
    } catch (e: any) {
      if (!isDownloadCancelled(e)) {
        Alert.alert('Download failed', e?.message ?? String(e));
      }
    } finally {
      // Only clean up if this specific run instance is still the active one.
      // Checking voiceId alone is insufficient — if the same model is re-downloaded
      // after a cancel, the zombie run's finally would fire with the same voiceId
      // and wipe out the new run's state. The runHandle object is unique per call.
      if (activeRunRef.current === runHandle) {
        activeRunRef.current = null;
        downloadingIdRef.current = null;
        setDownloadingId(null);
        setDownloadProgress(0);
        const next = queueRef.current[0];
        if (next) {
          queueRef.current = queueRef.current.slice(1);
          setDownloadQueue([...queueRef.current]);
          runDownload(next);
        }
      }
    }
  }, [refreshInstalled]);

  const handleDownload = useCallback((voiceId: string) => {
    // If a download is already active, add to queue instead of starting concurrently
    if (downloadingIdRef.current !== null) {
      if (!queueRef.current.includes(voiceId)) {
        queueRef.current = [...queueRef.current, voiceId];
        setDownloadQueue([...queueRef.current]);
      }
      return;
    }
    runDownload(voiceId);
  }, [runDownload]);

  const handleCancelDownload = useCallback(() => {
    if (!cancelTokenRef.current) return;
    // Remove the progress listener immediately — prevents the stale download's
    // events from bleeding into the next download's progress bar.
    cancelTokenRef.current.removeSubscription?.();
    // Abort the in-flight OkHttp call so it doesn't hold a connection slot.
    // Without this, repeated cancels exhaust OkHttp's 5-connections-per-host
    // limit, causing new download attempts to be queued and never start.
    cancelTokenRef.current.cancelNativeDownload?.();
    // Signal the token so downloadVoice discards results when it eventually wakes up
    cancelTokenRef.current.cancelled = true;
    cancelTokenRef.current = null;

    // Immediately reset UI — don't wait for the native download/extract to finish.
    // Clearing activeRunRef prevents the zombie run's finally block from wiping
    // out the next download's state (critical when re-downloading the same model).
    activeRunRef.current = null;
    clearDownloadState();
    downloadingIdRef.current = null;
    setDownloadingId(null);
    setDownloadProgress(0);

    // Kick off next queued item right away
    const next = queueRef.current[0];
    if (next) {
      queueRef.current = queueRef.current.slice(1);
      setDownloadQueue([...queueRef.current]);
      runDownload(next);
    }
  }, [runDownload]);

  const handleCancelQueued = useCallback((voiceId: string) => {
    queueRef.current = queueRef.current.filter(id => id !== voiceId);
    setDownloadQueue([...queueRef.current]);
  }, []);

  const handleSelect = useCallback(
    (voiceId: string) => setChapterReaderSettings({ sherpaTtsVoiceId: voiceId }),
    [setChapterReaderSettings],
  );

  const handleDelete = useCallback(
    (voiceId: string) => {
      Alert.alert(
        'Delete voice',
        'This will remove the downloaded model files. You can re-download it later.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteVoice(voiceId);
                if (sherpaTtsVoiceId === voiceId) {
                  setChapterReaderSettings({ sherpaTtsVoiceId: undefined });
                }
                refreshInstalled();
              } catch (e: any) {
                Alert.alert('Delete failed', e?.message ?? String(e));
              }
            },
          },
        ],
      );
    },
    [sherpaTtsVoiceId, setChapterReaderSettings],
  );

  const handleTestVoice = async () => {
    if (!sherpaTtsVoiceId) {
      Alert.alert('No voice selected', 'Select an Offline TTS voice first.');
      return;
    }
    setTesting(true);
    try {
      await sherpaSetVoice(sherpaTtsVoiceId);
      await NativeSherpaOnnxTTS.speak('Hello! This is a preview of the selected offline voice.', sherpaSpeed);
    } catch (e: any) {
      Alert.alert('Test failed', e?.message ?? String(e));
    } finally {
      setTesting(false);
    }
  };

  const activeVoiceName = useMemo(
    () => sherpaVoices.find(v => v.id === sherpaTtsVoiceId)?.name ?? 'None',
    [sherpaVoices, sherpaTtsVoiceId],
  );

  return (
    <>
      <BottomSheetScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.contentContainer}
      >
        <View style={styles.section}>
          <List.SubHeader theme={theme}>Text to Speech</List.SubHeader>

          <ReaderSheetPreferenceItem
            label="Enable TTS"
            value={TTSEnable}
            onPress={() => setChapterGeneralSettings({ TTSEnable: !TTSEnable })}
            theme={theme}
          />

          {TTSEnable && (
            <>
              <View style={styles.engineToggleContainer}>
                <EngineToggle
                  value={ttsEngine}
                  onChange={v => setChapterReaderSettings({ ttsEngine: v })}
                />
              </View>

              {/* ── System TTS ── */}
              {ttsEngine === 'system' && (
                <>
                  <TouchableOpacity
                    style={styles.settingItem}
                    onPress={() => setSystemModalVisible(true)}
                  >
                    <Text style={[styles.label, { color: theme.onSurface }]}>Voice</Text>
                    <Text style={[styles.value, { color: theme.onSurfaceVariant }]}>
                      {tts?.voice?.name || 'System'}
                    </Text>
                  </TouchableOpacity>

                  <View style={styles.sliderSection}>
                    <Text style={[styles.sliderLabel, { color: theme.onSurface }]}>
                      Speed: {tts?.rate?.toFixed(1) || '1.0'}x
                    </Text>
                    <Slider
                      style={styles.slider}
                      value={tts?.rate || 1}
                      minimumValue={0.1}
                      maximumValue={5}
                      step={0.1}
                      minimumTrackTintColor={theme.primary}
                      maximumTrackTintColor={theme.surfaceVariant}
                      thumbTintColor={theme.primary}
                      onSlidingComplete={value =>
                        setChapterReaderSettings({ tts: { ...tts, rate: value } })
                      }
                    />
                  </View>

                  <View style={styles.sliderSection}>
                    <Text style={[styles.sliderLabel, { color: theme.onSurface }]}>
                      Pitch: {tts?.pitch?.toFixed(1) || '1.0'}
                    </Text>
                    <Slider
                      style={styles.slider}
                      value={tts?.pitch || 1}
                      minimumValue={0.1}
                      maximumValue={5}
                      step={0.1}
                      minimumTrackTintColor={theme.primary}
                      maximumTrackTintColor={theme.surfaceVariant}
                      thumbTintColor={theme.primary}
                      onSlidingComplete={value =>
                        setChapterReaderSettings({ tts: { ...tts, pitch: value } })
                      }
                    />
                  </View>

                  <View style={styles.resetButtonContainer}>
                    <Button
                      title={getString('common.reset')}
                      mode="outlined"
                      onPress={() =>
                        setChapterReaderSettings({
                          tts: {
                            pitch: 1,
                            rate: 1,
                            voice: { name: 'System', language: 'System' } as Voice,
                            autoPageAdvance: false,
                            scrollToTop: true,
                          },
                        })
                      }
                      style={styles.resetButton}
                    />
                  </View>
                </>
              )}

              {/* ── Offline TTS ── */}
              {ttsEngine === 'sherpa' && (
                <>
                  <TouchableOpacity
                    style={styles.settingItem}
                    onPress={() => setSherpaModalVisible(true)}
                  >
                    <Text style={[styles.label, { color: theme.onSurface }]}>Voice</Text>
                    <Text style={[styles.value, { color: theme.onSurfaceVariant }]}>
                      {activeVoiceName}
                    </Text>
                  </TouchableOpacity>

                  <View style={styles.sliderSection}>
                    <Text style={[styles.sliderLabel, { color: theme.onSurface }]}>
                      Speed: {sherpaSpeed.toFixed(1)}x
                    </Text>
                    <Slider
                      style={styles.slider}
                      value={sherpaSpeed}
                      minimumValue={0.5}
                      maximumValue={2.0}
                      step={0.1}
                      minimumTrackTintColor={theme.primary}
                      maximumTrackTintColor={theme.surfaceVariant}
                      thumbTintColor={theme.primary}
                      onSlidingComplete={value =>
                        setChapterReaderSettings({ sherpaSpeed: value })
                      }
                    />
                  </View>

                  <View style={styles.testButtonContainer}>
                    <Button
                      title={testing ? 'Playing…' : 'Test Voice'}
                      mode="contained"
                      onPress={handleTestVoice}
                      disabled={testing || !sherpaTtsVoiceId}
                    />
                    {testing && (
                      <Button
                        title="Stop"
                        mode="outlined"
                        onPress={() => sherpaStop()}
                        style={{ marginLeft: 8 }}
                      />
                    )}
                  </View>
                </>
              )}

              {/* Shared */}
              <ReaderSheetPreferenceItem
                label="Auto Page Advance"
                value={tts?.autoPageAdvance === true}
                onPress={() =>
                  setChapterReaderSettings({
                    tts: { ...tts, autoPageAdvance: !(tts?.autoPageAdvance === true) },
                  })
                }
                theme={theme}
              />

              <ReaderSheetPreferenceItem
                label="Scroll to Top"
                value={tts?.scrollToTop !== false}
                onPress={() =>
                  setChapterReaderSettings({
                    tts: { ...tts, scrollToTop: !(tts?.scrollToTop !== false) },
                  })
                }
                theme={theme}
              />
            </>
          )}
        </View>

        <View style={styles.bottomSpacing} />
      </BottomSheetScrollView>

      <VoicePickerModal
        visible={systemModalVisible}
        onDismiss={() => setSystemModalVisible(false)}
        voices={systemVoices}
        onSelect={handleSystemVoiceSelect}
        currentVoice={tts?.voice}
      />

      <SherpaVoicePickerModal
        visible={sherpaModalVisible}
        onDismiss={() => setSherpaModalVisible(false)}
        voices={sherpaVoices}
        installedVoices={installedVoices}
        activeVoiceId={sherpaTtsVoiceId}
        downloadingId={downloadingId}
        downloadProgress={downloadProgress}
        downloadQueue={downloadQueue}
        loadingModelId={loadingModelId}
        onDownload={handleDownload}
        onCancelDownload={handleCancelDownload}
        onCancelQueued={handleCancelQueued}
        onSelect={handleSelect}
        onDelete={handleDelete}
      />
    </>
  );
};

export default React.memo(TTSTab);

const styles = StyleSheet.create({
  container: { flex: 1 },
  contentContainer: { paddingBottom: 24 },
  section: { marginVertical: 8 },

  engineToggleContainer: { paddingHorizontal: 16, paddingVertical: 12 },
  engineToggleRow: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  engineToggleBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  engineToggleText: { fontSize: 14, fontWeight: '500' },

  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  label: { fontSize: 16 },
  value: { fontSize: 14 },

  sliderSection: { paddingHorizontal: 16, paddingVertical: 12 },
  sliderLabel: { fontSize: 16, marginBottom: 8 },
  slider: { height: 40 },

  resetButtonContainer: { paddingHorizontal: 16, paddingVertical: 8 },
  resetButton: { alignSelf: 'flex-start' },

  testButtonContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },

  bottomSpacing: { height: 24 },

  // Shared modal styles
  modalContent: { margin: 20, borderRadius: 8, padding: 20, maxHeight: '80%' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 12 },
  languageFilterContainer: { marginBottom: 12 },
  filterLabel: { fontSize: 12, marginBottom: 8 },
  langChip: { marginEnd: 8, marginBottom: 4 },
  langFilterRow: { marginBottom: 8, flexGrow: 0 },
  voiceList: { maxHeight: 350 },

  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    marginBottom: 10,
    height: 40,
  },
  searchIcon: { fontSize: 18, marginRight: 6 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  searchClear: { padding: 4 },

  sectionHeader: {
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  sectionHeaderText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  voiceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 4,
    marginBottom: 4,
  },
  voiceItemText: { fontSize: 16, marginBottom: 2 },
  voiceItemLang: { fontSize: 12 },
  emptyText: { textAlign: 'center', padding: 20, fontSize: 14 },

  // Sherpa voice rows inside modal
  sherpaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sherpaVoiceName: { fontSize: 15, fontWeight: '500' },
  sherpaVoiceMeta: { fontSize: 12, marginTop: 2 },
  actionBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  actionBtnText: { fontSize: 13, fontWeight: '500' },
  progressContainer: { alignItems: 'flex-end', minWidth: 72 },
  downloadStatus: { fontSize: 11, marginBottom: 4 },
  progressTrack: { width: 72, height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 2 },
  cancelBtn: { paddingHorizontal: 6, paddingVertical: 4, marginLeft: 2 },
  cancelBtnText: { fontSize: 13 },
});
