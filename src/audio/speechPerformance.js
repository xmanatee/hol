import { normalizeSpeechPerformance } from '../contracts/objectPerformance.js';

export const buildSpeechInstructions = (voiceStyle, emotionalDelivery) => {
  const speechPerformance = normalizeSpeechPerformance(voiceStyle, emotionalDelivery);
  return `Perform as an animated object. Voice style: ${speechPerformance.voiceStyle}. Delivery: ${speechPerformance.emotionalDelivery}. Speak only the supplied input.`;
};
