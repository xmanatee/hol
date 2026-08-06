const VITE_ENV = Object.freeze({
  VITE_LOCAL_AI_BASE_URL: import.meta.env?.VITE_LOCAL_AI_BASE_URL,
  VITE_LOCAL_AI_MODEL: import.meta.env?.VITE_LOCAL_AI_MODEL,
  VITE_LOCAL_AI_VISION_MODEL: import.meta.env?.VITE_LOCAL_AI_VISION_MODEL,
  VITE_LOCAL_AI_PERSONA_MODEL: import.meta.env?.VITE_LOCAL_AI_PERSONA_MODEL,
  VITE_LOCAL_AI_MAX_TOKENS: import.meta.env?.VITE_LOCAL_AI_MAX_TOKENS,
  VITE_LOCAL_AI_TEMPERATURE: import.meta.env?.VITE_LOCAL_AI_TEMPERATURE,
  VITE_LOCAL_AI_TTS_MODEL: import.meta.env?.VITE_LOCAL_AI_TTS_MODEL,
  VITE_LOCAL_AI_TTS_VOICE: import.meta.env?.VITE_LOCAL_AI_TTS_VOICE,
  VITE_LOCAL_AI_REQUEST_TIMEOUT_MS: import.meta.env?.VITE_LOCAL_AI_REQUEST_TIMEOUT_MS,
});

export const readViteEnv = (key) => {
  if (!Object.hasOwn(VITE_ENV, key)) {
    throw new RangeError(`Unsupported Vite environment key: ${key}`);
  }
  return VITE_ENV[key];
};
