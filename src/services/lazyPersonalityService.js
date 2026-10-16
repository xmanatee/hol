import { assertPersonalityServiceConfig } from './personalityServiceConfig.js';
import { LazyRuntime } from '../utils/lazyRuntime.js';

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

export class LazyPersonalityService extends LazyRuntime {
  constructor(config = {}) {
    assertPersonalityServiceConfig(config);
    const { loadService = loadDefaultService, ...serviceConfig } = config;
    super(loadService, 'PersonalityService', serviceConfig);
    this.subjectGeneration = 0;
  }

  get isProcessing() {
    return this.runtime?.isProcessing ?? false;
  }

  get lastPersona() {
    return this.runtime?.lastPersona ?? null;
  }

  async generatePersonality(imageData, bbox) {
    const subjectGeneration = this.subjectGeneration;
    const service = await this.getRuntime();
    if (!service || subjectGeneration !== this.subjectGeneration) {
      return null;
    }

    return service.generatePersonality(imageData, bbox);
  }

  resetSubject() {
    this.subjectGeneration++;
    this.runtime?.resetSubject();
  }

  getMetrics() {
    return this.runtime ? this.runtime.getMetrics() : { ...EMPTY_METRICS };
  }

  dispose() {
    this.subjectGeneration++;
    return super.dispose();
  }
}
