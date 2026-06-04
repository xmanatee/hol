export const VISION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'object_vision_result',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string' },
        brandOrTitle: { type: 'string' },
        description: { type: 'string' },
        textSnippets: {
          type: 'array',
          items: { type: 'string' }
        },
        colors: {
          type: 'array',
          items: { type: 'string' }
        },
        materials: {
          type: 'array',
          items: { type: 'string' }
        },
        confidence: {
          type: 'number'
        }
      },
      required: ['category', 'brandOrTitle', 'description', 'textSnippets', 'colors', 'materials', 'confidence']
    }
  }
};

export const PERSONA_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'object_persona',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        voiceStyle: {
          type: 'string',
          enum: ['cheerful', 'sassy', 'wise', 'gruff', 'bubbly', 'sarcastic', 'dramatic']
        },
        facialExpression: {
          type: 'string',
          enum: ['neutral', 'happy', 'sassy', 'wise', 'gruff', 'bubbly', 'sarcastic', 'dramatic']
        },
        emotionalDelivery: { type: 'string' },
        animationIntensity: {
          type: 'number',
          minimum: 0,
          maximum: 1
        },
        tone: { type: 'string' },
        quirks: {
          type: 'array',
          items: { type: 'string' }
        },
        oneLiners: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['voiceStyle', 'facialExpression', 'emotionalDelivery', 'animationIntensity', 'tone', 'quirks', 'oneLiners']
    }
  }
};
