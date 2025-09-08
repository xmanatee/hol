import OpenAI from 'openai';

export class LLMClient {
  constructor(config = {}) {
    this.config = {
      model: config.model || import.meta.env.VITE_OPENAI_CHAT_MODEL || 'gpt-4',
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
      response_format: { type: "json_object" }
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
  "tone": "brief description of personality tone",
  "quirks": ["unique trait 1", "unique trait 2", "unique trait 3"],
  "oneLiners": ["greeting line", "idle comment", "departure line"]
}

Make it witty, distinctive, and based on the object's specific characteristics. The personality should feel like it belongs to this specific object.`;
  }

  validatePersona(result) {
    return {
      voiceStyle: result.voiceStyle,
      tone: result.tone,
      quirks: result.quirks.slice(0, 3),
      oneLiners: result.oneLiners.slice(0, 3)
    };
  }

}