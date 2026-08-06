import { PERSONA_CONTENT_LIMITS, readBoundedText } from './objectContent.js';

export const PERSONA_VOICE_STYLES = Object.freeze([
  'cheerful',
  'sassy',
  'wise',
  'gruff',
  'bubbly',
  'sarcastic',
  'dramatic',
]);

export const PERSONA_FACIAL_EXPRESSIONS = Object.freeze([
  'neutral',
  'happy',
  'sassy',
  'wise',
  'gruff',
  'bubbly',
  'sarcastic',
  'dramatic',
]);

const VOICE_STYLE_SET = new Set(PERSONA_VOICE_STYLES);

const readRequiredString = (value, label) => {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return normalized;
};

export const normalizeSpeechPerformance = (voiceStyle, emotionalDelivery) => {
  const normalizedVoiceStyle = readRequiredString(voiceStyle, 'Speech voice style');
  if (!VOICE_STYLE_SET.has(normalizedVoiceStyle)) {
    throw new TypeError(`Speech has unsupported voice style: ${normalizedVoiceStyle}.`);
  }

  return Object.freeze({
    voiceStyle: normalizedVoiceStyle,
    emotionalDelivery: readBoundedText(emotionalDelivery, {
      label: 'Speech emotional delivery',
      maxCharacters: PERSONA_CONTENT_LIMITS.maxEmotionalDeliveryCharacters,
    }),
  });
};
