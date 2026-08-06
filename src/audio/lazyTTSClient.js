import { normalizeSpeechPerformance } from '../contracts/objectPerformance.js';
import { SPEECH_INPUT_MAX_CHARACTERS, readBoundedText } from '../contracts/objectContent.js';
import { SILENT_AUDIO_ANALYSIS } from './lipSync.js';

const EMPTY_METRICS = {
  totalRequests: 0,
  successfulRequests: 0,
  averageLatency: 0,
  lastLatency: 0,
  successRate: 0,
};

const loadDefaultClient = () => import('./ttsClient.js');

export class LazyTTSClient {
  constructor(config = {}) {
    this.config = { ...config };
    this.loadClient = config.loadClient ?? loadDefaultClient;
    this.client = null;
    this.clientPromise = null;
    this.listenerRecords = [];
    this.runtimeGeneration = 0;
    this.speechGeneration = 0;
    this.pendingSynthesis = null;
    this.disposed = false;
  }

  addListener(listener) {
    const record = {
      listener,
      removeRealListener: this.client ? this.client.addListener(listener) : null,
    };
    this.listenerRecords.push(record);

    return () => {
      if (record.removeRealListener) {
        record.removeRealListener();
      }
      this.listenerRecords = this.listenerRecords.filter((candidate) => candidate !== record);
    };
  }

  initialize() {
    return !this.disposed;
  }

  _getClient() {
    if (this.disposed) {
      return null;
    }
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      const runtimeGeneration = this.runtimeGeneration;
      const clientPromise = this.loadClient().then(({ TTSClient }) => {
        if (
          this.disposed ||
          runtimeGeneration !== this.runtimeGeneration ||
          this.clientPromise !== clientPromise
        ) {
          return null;
        }
        const client = new TTSClient(this.config);
        this.listenerRecords.forEach((record) => {
          record.removeRealListener = client.addListener(record.listener);
        });
        this.client = client;
        return client;
      });
      this.clientPromise = clientPromise;
      clientPromise.then(
        () => {},
        () => {
          if (this.clientPromise === clientPromise) {
            this.clientPromise = null;
          }
        },
      );
    }

    return this.clientPromise;
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
    const runtimeGeneration = this.runtimeGeneration;
    const client = await this._getClient();
    if (
      !client ||
      this.disposed ||
      this.speechGeneration !== speechGeneration ||
      this.runtimeGeneration !== runtimeGeneration ||
      this.client !== client
    ) {
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
    if (this.client) {
      this.client.stopCurrentAudio();
    }
  }

  readFrame() {
    return this.client ? this.client.readFrame() : SILENT_AUDIO_ANALYSIS;
  }

  getMetrics() {
    return this.client ? this.client.getMetrics() : { ...EMPTY_METRICS };
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.runtimeGeneration++;
    this.speechGeneration++;
    const client = this.client;
    const listenerRecords = this.listenerRecords;
    this.client = null;
    this.clientPromise = null;
    this.pendingSynthesis = null;
    this.listenerRecords = [];

    listenerRecords.forEach((record) => {
      record.removeRealListener?.();
    });

    if (client) {
      await client.dispose();
    }
  }
}
