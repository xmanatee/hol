import OpenAI from 'openai';
import { PERSONA_RESPONSE_FORMAT } from './openaiSchemas.js';

export class LLMClient {
  constructor(config = {}) {
    this.config = {
      model: config.model || import.meta.env.VITE_OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
      maxTokens: config.maxTokens || parseInt(import.meta.env.VITE_OPENAI_MAX_TOKENS) || 300,
      temperature: config.temperature || parseFloat(import.meta.env.VITE_OPENAI_TEMPERATURE) || 0.8,
      ...config
    };

    const apiKey = config.apiKey || import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required. Set VITE_OPENAI_API_KEY in environment variables.');
    }

    this.openai = new OpenAI({
      apiKey: apiKey,
      dangerouslyAllowBrowser: true
    });
  }

  async generatePersona(visionResult) {
    const prompt = this.buildPersonaPrompt(visionResult);
    
    const response = await this.openai.chat.completions.create({
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
  "emotionalDelivery": "short direction for how the line should be performed emotionally",
  "animationIntensity": 0.0 to 1.0, where calm delivery is 0.25-0.45 and cartoonishly emotional delivery is 0.75-1.0,
  "tone": "brief description of personality tone",
  "quirks": ["unique trait 1", "unique trait 2", "unique trait 3"],
  "oneLiners": ["greeting line", "idle comment", "departure line"]
}

Make it witty, distinctive, and based on the object's specific characteristics. The facial expression and emotional delivery should match the one-liners instead of staying neutral. The personality should feel like it belongs to this specific object.`;
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
