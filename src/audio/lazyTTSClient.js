const EMPTY_METRICS = {
  totalRequests: 0,
  successfulRequests: 0,
  averageLatency: 0,
  lastLatency: 0,
  successRate: 0
};

const readAgentId = () => import.meta.env?.VITE_ELEVENLABS_AGENT_ID;

const loadDefaultClient = () => import('./ttsClient.js');

export class LazyTTSClient {
  constructor(config = {}) {
    this.config = {
      ...config,
      agentId: config.agentId ?? readAgentId()
    };
    this.loadClient = config.loadClient ?? loadDefaultClient;
    this.client = null;
    this.clientPromise = null;
    this.listenerRecords = [];
  }

  addListener(listener) {
    const record = {
      listener,
      removeRealListener: this.client ? this.client.addListener(listener) : null
    };
    this.listenerRecords.push(record);

    return () => {
      if (record.removeRealListener) {
        record.removeRealListener();
      }
      this.listenerRecords = this.listenerRecords.filter(candidate => candidate !== record);
    };
  }

  async initialize() {}

  async _getClient() {
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      this.clientPromise = this.loadClient().then(({ TTSClient }) => {
        const client = new TTSClient(this.config);
        this.listenerRecords.forEach(record => {
          record.removeRealListener = client.addListener(record.listener);
        });
        this.client = client;
        return client;
      });
    }

    return this.clientPromise;
  }

  async startConversation() {
    const client = await this._getClient();
    return client.startConversation();
  }

  async synthesizeSpeech(text, voiceStyle, emotionalDelivery) {
    const client = await this._getClient();
    return client.synthesizeSpeech(text, voiceStyle, emotionalDelivery);
  }

  stopCurrentAudio() {
    if (this.client) {
      this.client.stopCurrentAudio();
    }
  }

  async endConversation() {
    if (this.client) {
      await this.client.endConversation();
    }
  }

  getMetrics() {
    return this.client ? this.client.getMetrics() : { ...EMPTY_METRICS };
  }

  async dispose() {
    if (this.client) {
      await this.client.dispose();
    }
    this.listenerRecords = [];
  }
}
