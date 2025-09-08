import OpenAI from 'openai';

export class VisionClient {
  constructor(config = {}) {
    this.config = {
      model: config.model || import.meta.env.VITE_OPENAI_VISION_MODEL || 'gpt-4-vision-preview',
      maxTokens: config.maxTokens || 300,
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

  async identifyObject(imageBlob, objectInfo = {}) {
    // Convert blob to base64
    const base64Image = await this.blobToBase64(imageBlob);
    
    const prompt = this.buildVisionPrompt(objectInfo);

    const response = await this.openai.chat.completions.create({
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
      textSnippets: result.textSnippets,
      confidence: result.confidence,
      description: result.description,
      colors: result.colors,
      materials: result.materials
    };
  }


  async blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}