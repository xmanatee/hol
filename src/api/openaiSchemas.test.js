import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_RESPONSE_FORMAT,
  VISION_RESPONSE_FORMAT
} from './openaiSchemas.js';

test('vision response format uses strict JSON schema', () => {
  assert.equal(VISION_RESPONSE_FORMAT.type, 'json_schema');
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.strict, true);
  assert.deepEqual(
    VISION_RESPONSE_FORMAT.json_schema.schema.required,
    ['category', 'brandOrTitle', 'description', 'textSnippets', 'colors', 'materials', 'confidence']
  );
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.schema.additionalProperties, false);
});

test('persona response format uses strict JSON schema', () => {
  assert.equal(PERSONA_RESPONSE_FORMAT.type, 'json_schema');
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.strict, true);
  assert.deepEqual(
    PERSONA_RESPONSE_FORMAT.json_schema.schema.required,
    ['voiceStyle', 'tone', 'quirks', 'oneLiners']
  );
  assert.equal(PERSONA_RESPONSE_FORMAT.json_schema.schema.additionalProperties, false);
});
