const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

export const KNOWN_LOG_TAGS = Object.freeze([
  'AnchorManager',
  'AnchorPersistenceSystem',
  'CameraService',
  'CameraSystem',
  'CameraView',
  'Detection',
  'HeadAnchor',
  'HomographyEstimator',
  'ImageAnchor',
  'KeypointDetector',
  'KeypointTracker',
  'MicrophoneService',
  'MorphController',
  'OpenCVFeatureTest',
  'OverlayScene',
  'TTSClient',
]);

export const LOG_TAG_PRESETS = Object.freeze({
  quiet: {
    label: 'Quiet',
    tags: [],
  },
  core: {
    label: 'Core',
    tags: ['CameraService', 'CameraSystem', 'CameraView', 'AnchorManager', 'ImageAnchor', 'Detection'],
  },
  vision: {
    label: 'Vision',
    tags: [
      'AnchorManager',
      'AnchorPersistenceSystem',
      'Detection',
      'HomographyEstimator',
      'ImageAnchor',
      'KeypointDetector',
      'KeypointTracker',
      'OpenCVFeatureTest',
    ],
  },
  audio: {
    label: 'Audio',
    tags: ['HeadAnchor', 'MicrophoneService', 'MorphController', 'OverlayScene', 'TTSClient'],
  },
});

const getBrowserStorage = () => (typeof localStorage === 'undefined' ? null : localStorage);

export class TaggedLogger {
  constructor({
    storage = getBrowserStorage(),
    consoleTarget = console,
    knownTags = KNOWN_LOG_TAGS,
    now = () => Date.now(),
  } = {}) {
    this.storage = storage;
    this.consoleTarget = consoleTarget;
    this.now = now;
    this.enabledTags = new Set();
    this.discoveredTags = new Set(knownTags);
    this.lastLogSignatures = new Map();
    this.lastLogTimes = new Map();
    this.listeners = new Set();
    this.loadSettings();
  }

  loadSettings() {
    if (!this.storage) {
      return;
    }

    try {
      const saved = this.storage.getItem('logger-enabled-tags');
      if (saved) {
        const enabledArray = JSON.parse(saved);
        this.enabledTags = new Set(enabledArray);
        enabledArray.forEach(tag => this.discoveredTags.add(tag));
      }
    } catch (error) {
      this.consoleTarget.warn('Failed to load logger settings:', error);
    }
  }

  saveSettings() {
    if (!this.storage) {
      return;
    }

    try {
      this.storage.setItem('logger-enabled-tags', JSON.stringify([...this.enabledTags]));
    } catch (error) {
      this.consoleTarget.warn('Failed to save logger settings:', error);
    }
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => {
      try {
        callback(this.getAllTags(), this.getEnabledTags());
      } catch (error) {
        this.consoleTarget.warn('Logger listener error:', error);
      }
    });
  }

  discoverTag(tag) {
    if (!this.discoveredTags.has(tag)) {
      this.discoveredTags.add(tag);
      this.notifyListeners();
    }
  }

  enableTag(tag) {
    this.enabledTags.add(tag);
    this.saveSettings();
    this.notifyListeners();
  }

  disableTag(tag) {
    this.enabledTags.delete(tag);
    this.saveSettings();
    this.notifyListeners();
  }

  isTagEnabled(tag) {
    return this.enabledTags.has(tag);
  }

  toggleTag(tag) {
    if (this.isTagEnabled(tag)) {
      this.disableTag(tag);
    } else {
      this.enableTag(tag);
    }
  }

  setEnabledTags(tags) {
    this.enabledTags = new Set(tags);
    tags.forEach(tag => this.discoveredTags.add(tag));
    this.saveSettings();
    this.notifyListeners();
  }

  applyPreset(presetId) {
    const preset = LOG_TAG_PRESETS[presetId];
    if (!preset) {
      throw new Error(`Unknown log preset: ${presetId}`);
    }

    this.setEnabledTags(preset.tags);
  }

  getAllTags() {
    return [...this.discoveredTags].sort();
  }

  getEnabledTags() {
    return [...this.enabledTags].sort();
  }

  log(level, tag, ...args) {
    this.discoverTag(tag);
    
    if (level === LogLevel.ERROR || this.isTagEnabled(tag)) {
      const prefix = `[${tag}]`;
      const method = level === LogLevel.ERROR ? 'error' :
                   level === LogLevel.WARN ? 'warn' :
                   'log';
      
      this.consoleTarget[method](prefix, ...args);
    }
  }

  error(tag, ...args) {
    this.log(LogLevel.ERROR, tag, ...args);
  }

  warn(tag, ...args) {
    this.log(LogLevel.WARN, tag, ...args);
  }

  info(tag, ...args) {
    this.log(LogLevel.INFO, tag, ...args);
  }

  debug(tag, ...args) {
    this.log(LogLevel.DEBUG, tag, ...args);
  }

  debugChanged(tag, key, signature, ...args) {
    const logKey = `${tag}:${key}`;
    const signatureText = String(signature);
    if (this.lastLogSignatures.get(logKey) === signatureText) {
      return;
    }

    this.debug(tag, ...args);
    if (this.isTagEnabled(tag)) {
      this.lastLogSignatures.set(logKey, signatureText);
    }
  }

  debugEvery(tag, key, intervalMs, ...args) {
    this.discoverTag(tag);
    if (!this.isTagEnabled(tag)) {
      return;
    }

    const logKey = `${tag}:${key}`;
    const now = this.now();
    const previous = this.lastLogTimes.get(logKey) ?? -Infinity;
    if (now - previous < intervalMs) {
      return;
    }

    this.lastLogTimes.set(logKey, now);
    this.log(LogLevel.DEBUG, tag, ...args);
  }
}

export const logger = new TaggedLogger();
export default logger;
