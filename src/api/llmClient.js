import { PERSONA_RESPONSE_FORMAT } from './openaiSchemas.js';
import { OpenAIChatClient, readViteEnv } from './openaiChatClient.js';

const parseNumberEnv = (key, defaultValue) => {
  const parsed = Number.parseFloat(readViteEnv(key) || '');
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

export class LLMClient {
  constructor(config = {}) {
    this.config = {
      model: config.model || readViteEnv('VITE_OPENAI_CHAT_MODEL') || 'gpt-4.1-mini',
      maxTokens: config.maxTokens ?? parseNumberEnv('VITE_OPENAI_MAX_TOKENS', 300),
      temperature: config.temperature ?? parseNumberEnv('VITE_OPENAI_TEMPERATURE', 0.8),
      ...config
    };

    this.chatClient = config.chatClient || new OpenAIChatClient({
      apiKey: config.apiKey || readViteEnv('VITE_OPENAI_API_KEY'),
      fetchImpl: config.fetchImpl
    });
  }

  async generatePersona(visionResult) {
    const prompt = this.buildPersonaPrompt(visionResult);
    
    const response = await this.chatClient.create({
      model: this.config.model,
      messages: [
        {
          role: "system",
          content: "You are a creative writer specializing in character personalities for the game 'High on Life'. You create witty, distinctive personalities for everyday objects. Always respond with valid JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      response_format: PERSONA_RESPONSE_FORMAT
    });

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);
    return this.validatePersona(result);
  }

  buildPersonaPrompt(visionResult) {
    return `Based on this object, create a fun personality inspired by the game "High on Life":

Object Details:
- Type: ${visionResult.category}
- Description: ${visionResult.description}
- Brand/Title: ${visionResult.brandOrTitle || 'No brand visible'}
- Visible Text: ${visionResult.textSnippets.length > 0 ? visionResult.textSnippets.join(', ') : 'None'}
- Colors: ${visionResult.colors.length > 0 ? visionResult.colors.join(', ') : 'Unknown'}
- Materials: ${visionResult.materials.length > 0 ? visionResult.materials.join(', ') : 'Unknown'}

Return a JSON object with exactly these fields:
{
  "voiceStyle": "one of: cheerful, sassy, wise, gruff, bubbly, sarcastic, dramatic",
  "facialExpression": "one of: neutral, happy, sassy, wise, gruff, bubbly, sarcastic, dramatic",
  "emotionalDelivery": "specific voice performance direction: emotion, pace, emphasis, and energy for text-to-speech",
  "animationIntensity": 0.0 to 1.0, where calm delivery is 0.25-0.45 and cartoonishly emotional delivery is 0.75-1.0,
  "tone": "brief description of personality tone",
  "quirks": ["unique trait 1", "unique trait 2", "unique trait 3"],
  "oneLiners": ["greeting line", "idle comment", "departure line"]
}

Make it witty, distinctive, and based on the object's specific characteristics. The facial expression, voice style, emotional delivery, punctuation, and animation intensity must describe the same performance. Use higher animation intensity for theatrical, excited, or chaotic lines and lower intensity for calm, wise, or deadpan lines. The personality should feel like it belongs to this specific object.`;
  }

  validatePersona(result) {
    return {
      voiceStyle: result.voiceStyle,
      facialExpression: result.facialExpression,
      emotionalDelivery: result.emotionalDelivery,
      animationIntensity: result.animationIntensity,
      tone: result.tone,
      quirks: (result.quirks || []).slice(0, 3),
      oneLiners: (result.oneLiners || []).slice(0, 3)
    };
  }

}
