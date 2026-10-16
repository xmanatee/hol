import { normalizeSpeechPerformance } from '../contracts/objectPerformance.js';
import { SPEECH_INPUT_MAX_CHARACTERS, readBoundedText } from '../contracts/objectContent.js';
import { SILENT_AUDIO_ANALYSIS } from './lipSync.js';
import { LazyRuntime } from '../utils/lazyRuntime.js';

const EMPTY_METRICS = {
  totalRequests: 0,
  successfulRequests: 0,
  averageLatency: 0,
  lastLatency: 0,
  successRate: 0,
};

const loadDefaultClient = () => import('./ttsClient.js');

export class LazyTTSClient extends LazyRuntime {
  constructor(config = {}) {
    const { loadClient = loadDefaultClient, ...clientConfig } = config;
    super(loadClient, 'TTSClient', clientConfig);
    this.speechGeneration = 0;
    this.pendingSynthesis = null;
  }

  initialize() {
    return !this.disposed;
  }

  synthesizeSpeech(text, voiceStyle, emotionalDelivery) {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    const normalizedText = readBoundedText(text, {
      label: 'Speech input',
      maxCharacters: SPEECH_INPUT_MAX_CHARACTERS,
    });
    const speechPerformance = normalizeSpeechPerformance(voiceStyle, emotionalDelivery);
    const synthesisKey = JSON.stringify([normalizedText, speechPerformance]);
    if (this.pendingSynthesis?.key === synthesisKey) {
      return this.pendingSynthesis.promise;
    }

    const speechGeneration = this.speechGeneration;
    const promise = this._synthesizeSpeech(normalizedText, speechPerformance, speechGeneration);
    const pendingSynthesis = { key: synthesisKey, promise };
    this.pendingSynthesis = pendingSynthesis;
    promise.then(
      () => this._releasePendingSynthesis(pendingSynthesis),
      () => this._releasePendingSynthesis(pendingSynthesis),
    );
    return promise;
  }

  async _synthesizeSpeech(text, speechPerformance, speechGeneration) {
    const client = await this.getRuntime();
    if (!client || this.speechGeneration !== speechGeneration) {
      return false;
    }
    return client.synthesizeSpeech(text, speechPerformance.voiceStyle, speechPerformance.emotionalDelivery);
  }

  _releasePendingSynthesis(pendingSynthesis) {
    if (this.pendingSynthesis === pendingSynthesis) {
      this.pendingSynthesis = null;
    }
  }

  stopCurrentAudio() {
    this.speechGeneration++;
    this.pendingSynthesis = null;
    this.runtime?.stopCurrentAudio();
  }

  readFrame() {
    return this.runtime ? this.runtime.readFrame() : SILENT_AUDIO_ANALYSIS;
  }

  getMetrics() {
    return this.runtime ? this.runtime.getMetrics() : { ...EMPTY_METRICS };
  }

  async dispose() {
    this.speechGeneration++;
    this.pendingSynthesis = null;
    await super.dispose();
  }
}
