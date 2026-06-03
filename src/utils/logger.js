const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

class TaggedLogger {
  constructor() {
    this.enabledTags = new Set();
    this.discoveredTags = new Set();
    this.listeners = new Set();
    this.loadSettings();
  }

  loadSettings() {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      const saved = localStorage.getItem('logger-enabled-tags');
      if (saved) {
        const enabledArray = JSON.parse(saved);
        this.enabledTags = new Set(enabledArray);
      }
    } catch (error) {
      console.warn('Failed to load logger settings:', error);
    }
  }

  saveSettings() {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.setItem('logger-enabled-tags', JSON.stringify([...this.enabledTags]));
    } catch (error) {
      console.warn('Failed to save logger settings:', error);
    }
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => {
      try {
        callback([...this.discoveredTags], [...this.enabledTags]);
      } catch (error) {
        console.warn('Logger listener error:', error);
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
      
      console[method](prefix, ...args);
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
}

export const logger = new TaggedLogger();
export default logger;
