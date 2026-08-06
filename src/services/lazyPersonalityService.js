import { assertPersonalityServiceConfig } from './personalityServiceConfig.js';

const EMPTY_METRICS = Object.freeze({
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  cancelledRequests: 0,
  averageRTT: 0,
  lastRTT: 0,
  successRate: 0,
});

const loadDefaultService = () => import('./PersonalityService.js');

export class LazyPersonalityService {
  constructor(config = {}) {
    assertPersonalityServiceConfig(config);
    const { loadService = loadDefaultService, ...serviceConfig } = config;
    if (typeof loadService !== 'function') {
      throw new TypeError('Personality runtime loader must be a function');
    }

    this.config = serviceConfig;
    this.loadService = loadService;
    this.service = null;
    this.servicePromise = null;
    this.listenerRecords = [];
    this.runtimeGeneration = 0;
    this.subjectGeneration = 0;
    this.disposed = false;
  }

  get isProcessing() {
    return this.service?.isProcessing ?? false;
  }

  get lastPersona() {
    return this.service?.lastPersona ?? null;
  }

  addListener(listener) {
    const record = {
      listener,
      removeServiceListener: this.service ? this.service.addListener(listener) : null,
    };
    this.listenerRecords.push(record);

    return () => {
      record.removeServiceListener?.();
      this.listenerRecords = this.listenerRecords.filter((candidate) => candidate !== record);
    };
  }

  _getService() {
    if (this.disposed) {
      return null;
    }
    if (this.service) {
      return this.service;
    }

    if (!this.servicePromise) {
      const runtimeGeneration = this.runtimeGeneration;
      const servicePromise = this.loadService().then(({ PersonalityService }) => {
        if (
          this.disposed ||
          runtimeGeneration !== this.runtimeGeneration ||
          this.servicePromise !== servicePromise
        ) {
          return null;
        }
        if (typeof PersonalityService !== 'function') {
          throw new TypeError('Personality runtime must export PersonalityService');
        }

        const service = new PersonalityService(this.config);
        this.listenerRecords.forEach((record) => {
          record.removeServiceListener = service.addListener(record.listener);
        });
        this.service = service;
        return service;
      });
      this.servicePromise = servicePromise;
      servicePromise.then(
        () => {},
        () => {
          if (this.servicePromise === servicePromise) {
            this.servicePromise = null;
          }
        },
      );
    }

    return this.servicePromise;
  }

  generatePersonality(imageData, bbox) {
    if (this.disposed) {
      return Promise.resolve(null);
    }

    return this._generatePersonality(imageData, bbox, this.subjectGeneration);
  }

  async _generatePersonality(imageData, bbox, subjectGeneration) {
    const runtimeGeneration = this.runtimeGeneration;
    const service = await this._getService();
    if (
      !service ||
      this.disposed ||
      runtimeGeneration !== this.runtimeGeneration ||
      subjectGeneration !== this.subjectGeneration ||
      this.service !== service
    ) {
      return null;
    }

    return service.generatePersonality(imageData, bbox);
  }

  resetSubject() {
    this.subjectGeneration++;
    this.service?.resetSubject();
  }

  getMetrics() {
    return this.service ? this.service.getMetrics() : { ...EMPTY_METRICS };
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.runtimeGeneration++;
    this.subjectGeneration++;
    const service = this.service;
    const listenerRecords = this.listenerRecords;
    this.service = null;
    this.servicePromise = null;
    this.listenerRecords = [];

    listenerRecords.forEach((record) => {
      record.removeServiceListener?.();
    });
    service?.dispose();
  }
}
