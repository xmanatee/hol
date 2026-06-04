import { VISION_RESPONSE_FORMAT } from './openaiSchemas.js';
import { OpenAIChatClient, readViteEnv } from './openaiChatClient.js';

export class VisionClient {
  constructor(config = {}) {
    this.config = {
      model: config.model || readViteEnv('VITE_OPENAI_VISION_MODEL') || 'gpt-4.1-mini',
      maxTokens: config.maxTokens ?? 300,
      ...config
    };

    this.chatClient = config.chatClient || new OpenAIChatClient({
      apiKey: config.apiKey || readViteEnv('VITE_OPENAI_API_KEY'),
      fetchImpl: config.fetchImpl
    });
  }

  async identifyObject(imageBlob, objectInfo = {}) {
    // Convert blob to base64
    const base64Image = await this.blobToBase64(imageBlob);
    
    const prompt = this.buildVisionPrompt(objectInfo);

    const response = await this.chatClient.create({
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: base64Image,
                detail: "low"
              }
            }
          ]
        }
      ],
      max_tokens: this.config.maxTokens,
      response_format: VISION_RESPONSE_FORMAT
    });

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);
    return this.validateVisionResult(result);
  }

  buildVisionPrompt(objectInfo = {}) {
    return `Analyze this object image and return a JSON object with the following fields:

{
  "category": "specific object type (e.g., 'water_bottle', 'coffee_mug', 'beer_can')",
  "brandOrTitle": "brand name or product title if visible",
  "description": "brief description of the object's appearance",
  "textSnippets": ["array", "of", "visible", "text"],
  "colors": ["primary", "colors", "visible"],
  "materials": ["materials", "the", "object", "appears", "to", "be", "made", "of"],
  "confidence": 0.85
}

${objectInfo.class ? `Detected object class: ${objectInfo.class}` : ''}
${objectInfo.confidence ? `Detection confidence: ${objectInfo.confidence}` : ''}

Focus on details that would help create a unique personality for this object. Return ONLY the JSON object.`;
  }

  validateVisionResult(result) {
    return {
      category: result.category,
      brandOrTitle: result.brandOrTitle || result.brand || result.title,
      textSnippets: result.textSnippets || [],
      confidence: result.confidence || 0,
      description: result.description,
      colors: result.colors || [],
      materials: result.materials || []
    };
  }


  async blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  }
}
