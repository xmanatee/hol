export const assertPersonalityServiceConfig = (config) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Personality service config must be an object');
  }
  if (Object.hasOwn(config, 'createImageBitmap') && typeof config.createImageBitmap !== 'function') {
    throw new TypeError('Personality createImageBitmap must be a function');
  }
  if (Object.hasOwn(config, 'createCanvas') && typeof config.createCanvas !== 'function') {
    throw new TypeError('Personality createCanvas must be a function');
  }
  return config;
};
