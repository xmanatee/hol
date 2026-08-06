import {
  PERSONA_FACIAL_EXPRESSIONS,
  PERSONA_VOICE_STYLES,
  normalizeSpeechPerformance,
} from '../contracts/objectPerformance.js';
import {
  PERSONA_CONTENT_LIMITS,
  VISION_CONTENT_LIMITS,
  readBoundedText,
} from '../contracts/objectContent.js';

export const VISION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'object_vision_result',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: {
          type: 'string',
          minLength: 1,
          maxLength: VISION_CONTENT_LIMITS.maxCategoryCharacters,
        },
        brandOrTitle: {
          type: 'string',
          maxLength: VISION_CONTENT_LIMITS.maxBrandOrTitleCharacters,
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: VISION_CONTENT_LIMITS.maxDescriptionCharacters,
        },
        textSnippets: {
          type: 'array',
          maxItems: VISION_CONTENT_LIMITS.maxTextSnippets,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: VISION_CONTENT_LIMITS.maxTextSnippetCharacters,
          },
        },
        colors: {
          type: 'array',
          maxItems: VISION_CONTENT_LIMITS.maxColors,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: VISION_CONTENT_LIMITS.maxColorCharacters,
          },
        },
        materials: {
          type: 'array',
          maxItems: VISION_CONTENT_LIMITS.maxMaterials,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: VISION_CONTENT_LIMITS.maxMaterialCharacters,
          },
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
      },
      required: [
        'category',
        'brandOrTitle',
        'description',
        'textSnippets',
        'colors',
        'materials',
        'confidence',
      ],
    },
  },
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
          enum: PERSONA_VOICE_STYLES,
        },
        facialExpression: {
          type: 'string',
          enum: PERSONA_FACIAL_EXPRESSIONS,
        },
        emotionalDelivery: {
          type: 'string',
          minLength: 1,
          maxLength: PERSONA_CONTENT_LIMITS.maxEmotionalDeliveryCharacters,
        },
        animationIntensity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        tone: {
          type: 'string',
          minLength: 1,
          maxLength: PERSONA_CONTENT_LIMITS.maxToneCharacters,
        },
        quirks: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: PERSONA_CONTENT_LIMITS.maxQuirkCharacters,
          },
          minItems: PERSONA_CONTENT_LIMITS.quirkCount,
          maxItems: PERSONA_CONTENT_LIMITS.quirkCount,
        },
        oneLiners: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: PERSONA_CONTENT_LIMITS.maxOneLinerCharacters,
          },
          minItems: PERSONA_CONTENT_LIMITS.oneLinerCount,
          maxItems: PERSONA_CONTENT_LIMITS.oneLinerCount,
        },
      },
      required: [
        'voiceStyle',
        'facialExpression',
        'emotionalDelivery',
        'animationIntensity',
        'tone',
        'quirks',
        'oneLiners',
      ],
    },
  },
};

const assertRecord = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
};

const assertExactKeys = (value, keys, label) => {
  const expectedKeys = new Set(keys);
  const unexpectedKey = Object.keys(value).find((key) => !expectedKeys.has(key));
  if (unexpectedKey) {
    throw new TypeError(`${label} contains unsupported field: ${unexpectedKey}`);
  }
  const missingKey = keys.find((key) => !Object.hasOwn(value, key));
  if (missingKey) {
    throw new TypeError(`${label} is missing required field: ${missingKey}`);
  }
};

const readStringArray = (value, label, { exactLength = null, maxItems = null, maxCharacters }) => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (exactLength !== null && value.length !== exactLength) {
    throw new RangeError(`${label} must contain exactly ${exactLength} entries`);
  }
  if (maxItems !== null && value.length > maxItems) {
    throw new RangeError(`${label} must contain at most ${maxItems} entries`);
  }
  return value.map((entry, index) =>
    readBoundedText(entry, {
      label: `${label}[${index}]`,
      maxCharacters,
    }),
  );
};

const VISION_RESULT_KEYS = Object.freeze([
  'category',
  'brandOrTitle',
  'description',
  'textSnippets',
  'colors',
  'materials',
  'confidence',
]);
const PERSONA_RESULT_KEYS = Object.freeze([
  'voiceStyle',
  'facialExpression',
  'emotionalDelivery',
  'animationIntensity',
  'tone',
  'quirks',
  'oneLiners',
]);
const FACIAL_EXPRESSIONS = new Set(PERSONA_FACIAL_EXPRESSIONS);

export const validateVisionResult = (result) => {
  assertRecord(result, 'Vision result');
  assertExactKeys(result, VISION_RESULT_KEYS, 'Vision result');
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    throw new RangeError('Vision result confidence must be a finite number from 0 to 1');
  }
  return {
    category: readBoundedText(result.category, {
      label: 'Vision result category',
      maxCharacters: VISION_CONTENT_LIMITS.maxCategoryCharacters,
    }),
    brandOrTitle: readBoundedText(result.brandOrTitle, {
      label: 'Vision result brandOrTitle',
      maxCharacters: VISION_CONTENT_LIMITS.maxBrandOrTitleCharacters,
      allowEmpty: true,
    }),
    description: readBoundedText(result.description, {
      label: 'Vision result description',
      maxCharacters: VISION_CONTENT_LIMITS.maxDescriptionCharacters,
    }),
    textSnippets: readStringArray(result.textSnippets, 'Vision result textSnippets', {
      maxItems: VISION_CONTENT_LIMITS.maxTextSnippets,
      maxCharacters: VISION_CONTENT_LIMITS.maxTextSnippetCharacters,
    }),
    colors: readStringArray(result.colors, 'Vision result colors', {
      maxItems: VISION_CONTENT_LIMITS.maxColors,
      maxCharacters: VISION_CONTENT_LIMITS.maxColorCharacters,
    }),
    materials: readStringArray(result.materials, 'Vision result materials', {
      maxItems: VISION_CONTENT_LIMITS.maxMaterials,
      maxCharacters: VISION_CONTENT_LIMITS.maxMaterialCharacters,
    }),
    confidence: result.confidence,
  };
};

export const validatePersonaResult = (result) => {
  assertRecord(result, 'Persona result');
  assertExactKeys(result, PERSONA_RESULT_KEYS, 'Persona result');
  const speechPerformance = normalizeSpeechPerformance(result.voiceStyle, result.emotionalDelivery);
  if (!FACIAL_EXPRESSIONS.has(result.facialExpression)) {
    throw new TypeError(`Persona result has unsupported facialExpression: ${result.facialExpression}`);
  }
  if (
    !Number.isFinite(result.animationIntensity) ||
    result.animationIntensity < 0 ||
    result.animationIntensity > 1
  ) {
    throw new RangeError('Persona result animationIntensity must be a finite number from 0 to 1');
  }
  return {
    voiceStyle: speechPerformance.voiceStyle,
    facialExpression: result.facialExpression,
    emotionalDelivery: speechPerformance.emotionalDelivery,
    animationIntensity: result.animationIntensity,
    tone: readBoundedText(result.tone, {
      label: 'Persona result tone',
      maxCharacters: PERSONA_CONTENT_LIMITS.maxToneCharacters,
    }),
    quirks: readStringArray(result.quirks, 'Persona result quirks', {
      exactLength: PERSONA_CONTENT_LIMITS.quirkCount,
      maxCharacters: PERSONA_CONTENT_LIMITS.maxQuirkCharacters,
    }),
    oneLiners: readStringArray(result.oneLiners, 'Persona result oneLiners', {
      exactLength: PERSONA_CONTENT_LIMITS.oneLinerCount,
      maxCharacters: PERSONA_CONTENT_LIMITS.maxOneLinerCharacters,
    }),
  };
};
