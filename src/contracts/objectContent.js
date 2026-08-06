export const VISION_CONTENT_LIMITS = Object.freeze({
  maxCategoryCharacters: 64,
  maxBrandOrTitleCharacters: 128,
  maxDescriptionCharacters: 320,
  maxTextSnippets: 12,
  maxTextSnippetCharacters: 128,
  maxColors: 8,
  maxColorCharacters: 32,
  maxMaterials: 8,
  maxMaterialCharacters: 64,
});

export const PERSONA_CONTENT_LIMITS = Object.freeze({
  maxEmotionalDeliveryCharacters: 240,
  maxToneCharacters: 120,
  quirkCount: 3,
  maxQuirkCharacters: 120,
  oneLinerCount: 3,
  maxOneLinerCharacters: 240,
});

export const SPEECH_INPUT_MAX_CHARACTERS = PERSONA_CONTENT_LIMITS.maxOneLinerCharacters;

const assertWellFormedLength = (value, label, maxCharacters) => {
  let characterCount = 0;
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new TypeError(`${label} must contain well-formed Unicode`);
    }
    if (codePoint > 0xffff) {
      index++;
    }
    characterCount++;
    if (characterCount > maxCharacters) {
      throw new RangeError(`${label} must contain at most ${maxCharacters} characters`);
    }
  }
};

export const readBoundedText = (value, { label, maxCharacters, allowEmpty = false } = {}) => {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new TypeError('Text label must be a non-empty string');
  }
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError('Text maxCharacters must be a positive safe integer');
  }
  if (typeof allowEmpty !== 'boolean') {
    throw new TypeError('Text allowEmpty must be a boolean');
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }

  assertWellFormedLength(value, label, maxCharacters);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new TypeError(`${label} must be non-empty`);
  }
  return normalized;
};
