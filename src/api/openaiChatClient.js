export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

export const readViteEnv = (key) => import.meta.env?.[key];

export class OpenAIChatClient {
  constructor(config = {}) {
    this.apiKey = config.apiKey;
    const browserFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
    this.fetchImpl = config.fetchImpl ?? browserFetch;

    if (!this.apiKey) {
      throw new Error('OpenAI API key is required. Set VITE_OPENAI_API_KEY in environment variables.');
    }

    if (!this.fetchImpl) {
      throw new Error('Fetch API is required for OpenAI requests.');
    }
  }

  async create(payload) {
    const response = await this.fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `OpenAI request failed with status ${response.status}`);
    }

    return data;
  }
}
