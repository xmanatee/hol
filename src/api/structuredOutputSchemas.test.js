import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_RESPONSE_FORMAT,
  VISION_RESPONSE_FORMAT,
  validatePersonaResult,
  validateVisionResult,
} from './structuredOutputSchemas.js';
import { PERSONA_FACIAL_EXPRESSIONS, PERSONA_VOICE_STYLES } from '../contracts/objectPerformance.js';
import { PERSONA_CONTENT_LIMITS, VISION_CONTENT_LIMITS } from '../contracts/objectContent.js';

const validVisionResult = () => ({
  category: 'soda_can',
  brandOrTitle: 'Cola',
  description: 'red can',
  textSnippets: ['cola'],
  colors: ['red'],
  materials: ['aluminum'],
  confidence: 0.91,
});

const validPersonaResult = () => ({
  voiceStyle: 'dramatic',
  facialExpression: 'dramatic',
  emotionalDelivery: 'big theatrical delivery',
  animationIntensity: 0.9,
  tone: 'over the top',
  quirks: ['booms', 'poses', 'pauses'],
  oneLiners: ['I have arrived!', 'Still dramatic.', 'Farewell!'],
});

test('vision response format uses strict JSON schema', () => {
  assert.equal(VISION_RESPONSE_FORMAT.type, 'json_schema');
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.strict, true);
  assert.deepEqual(VISION_RESPONSE_FORMAT.json_schema.schema.required, [
    'category',
    'brandOrTitle',
    'description',
    'textSnippets',
    'colors',
    'materials',
    'confidence',
  ]);
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.schema.additionalProperties, false);
  const properties = VISION_RESPONSE_FORMAT.json_schema.schema.properties;
  assert.equal(properties.category.maxLength, VISION_CONTENT_LIMITS.maxCategoryCharacters);
  assert.equal(properties.brandOrTitle.maxLength, VISION_CONTENT_LIMITS.maxBrandOrTitleCharacters);
  assert.equal(properties.description.maxLength, VISION_CONTENT_LIMITS.maxDescriptionCharacters);
  assert.equal(properties.textSnippets.maxItems, VISION_CONTENT_LIMITS.maxTextSnippets);
  assert.equal(properties.textSnippets.items.maxLength, VISION_CONTENT_LIMITS.maxTextSnippetCharacters);
  assert.equal(properties.colors.maxItems, VISION_CONTENT_LIMITS.maxColors);
  assert.equal(properties.colors.items.maxLength, VISION_CONTENT_LIMITS.maxColorCharacters);
  assert.equal(properties.materials.maxItems, VISION_CONTENT_LIMITS.maxMaterials);
  assert.equal(properties.materials.items.maxLength, VISION_CONTENT_LIMITS.maxMaterialCharacters);
});

test('persona response format uses strict JSON schema', () => {
  assert.equal(PERSONA_RESPONSE_FORMAT.type, 'json_schema');
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.strict, true);
  assert.deepEqual(PERSONA_RESPONSE_FORMAT.json_schema.schema.required, [
    'voiceStyle',
    'facialExpression',
    'emotionalDelivery',
    'animationIntensity',
    'tone',
    'quirks',
    'oneLiners',
  ]);
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.schema.additionalProperties, false);
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.schema.properties.voiceStyle.enum, PERSONA_VOICE_STYLES);
  assert.equal(
    PERSONA_RESPONSE_FORMAT.json_schema.schema.properties.facialExpression.enum,
    PERSONA_FACIAL_EXPRESSIONS,
  );
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.schema.properties.quirks.minItems, 3);
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.schema.properties.oneLiners.maxItems, 3);
  const properties = PERSONA_RESPONSE_FORMAT.json_schema.schema.properties;
  assert.equal(properties.emotionalDelivery.maxLength, PERSONA_CONTENT_LIMITS.maxEmotionalDeliveryCharacters);
  assert.equal(properties.tone.maxLength, PERSONA_CONTENT_LIMITS.maxToneCharacters);
  assert.equal(properties.quirks.items.maxLength, PERSONA_CONTENT_LIMITS.maxQuirkCharacters);
  assert.equal(properties.oneLiners.items.maxLength, PERSONA_CONTENT_LIMITS.maxOneLinerCharacters);
});

test('vision result validation rejects missing, extra, and malformed provider fields', () => {
  assert.deepEqual(validateVisionResult(validVisionResult()), validVisionResult());
  assert.throws(() => validateVisionResult({}), /missing required field/);
  assert.throws(
    () => validateVisionResult({ ...validVisionResult(), legacyCategory: 'can' }),
    /unsupported field/,
  );
  assert.throws(() => validateVisionResult({ ...validVisionResult(), confidence: 2 }), /from 0 to 1/);
  assert.throws(() => validateVisionResult({ ...validVisionResult(), colors: [''] }), /must be non-empty/);
});

test('vision validation bounds Unicode text and every model-controlled collection', () => {
  const categoryAtLimit = '😀'.repeat(VISION_CONTENT_LIMITS.maxCategoryCharacters);
  assert.equal(
    validateVisionResult({ ...validVisionResult(), category: categoryAtLimit }).category,
    categoryAtLimit,
  );
  assert.throws(
    () =>
      validateVisionResult({
        ...validVisionResult(),
        category: `${categoryAtLimit}😀`,
      }),
    /category must contain at most 64 characters/,
  );
  assert.throws(
    () =>
      validateVisionResult({
        ...validVisionResult(),
        textSnippets: Array.from({ length: VISION_CONTENT_LIMITS.maxTextSnippets + 1 }, () => 'text'),
      }),
    /textSnippets must contain at most 12 entries/,
  );
  assert.throws(
    () =>
      validateVisionResult({
        ...validVisionResult(),
        materials: ['m'.repeat(VISION_CONTENT_LIMITS.maxMaterialCharacters + 1)],
      }),
    /materials\[0\] must contain at most 64 characters/,
  );
  assert.throws(
    () => validateVisionResult({ ...validVisionResult(), description: '\ud800' }),
    /description must contain well-formed Unicode/,
  );
});

test('persona result validation enforces enums, bounds, and exact performance arrays', () => {
  assert.deepEqual(validatePersonaResult(validPersonaResult()), validPersonaResult());
  assert.throws(
    () => validatePersonaResult({ ...validPersonaResult(), voiceStyle: 'anything' }),
    /unsupported voice style/,
  );
  assert.throws(
    () => validatePersonaResult({ ...validPersonaResult(), animationIntensity: Number.NaN }),
    /finite number/,
  );
  assert.throws(
    () => validatePersonaResult({ ...validPersonaResult(), oneLiners: ['Only one'] }),
    /exactly 3 entries/,
  );
});

test('persona validation bounds every model-controlled performance string', () => {
  assert.throws(
    () =>
      validatePersonaResult({
        ...validPersonaResult(),
        tone: 't'.repeat(PERSONA_CONTENT_LIMITS.maxToneCharacters + 1),
      }),
    /tone must contain at most 120 characters/,
  );
  assert.throws(
    () =>
      validatePersonaResult({
        ...validPersonaResult(),
        quirks: ['q'.repeat(PERSONA_CONTENT_LIMITS.maxQuirkCharacters + 1), 'poses', 'pauses'],
      }),
    /quirks\[0\] must contain at most 120 characters/,
  );
  assert.throws(
    () =>
      validatePersonaResult({
        ...validPersonaResult(),
        oneLiners: [
          '😀'.repeat(PERSONA_CONTENT_LIMITS.maxOneLinerCharacters + 1),
          'Still dramatic.',
          'Farewell!',
        ],
      }),
    /oneLiners\[0\] must contain at most 240 characters/,
  );
});
