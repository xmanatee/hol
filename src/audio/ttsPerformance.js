const EMOTIONAL_DELIVERY_PROFILES = {
  cheerful: {
    tag: '[excited]',
    delivery: 'bright, warm, quick, and playful',
  },
  bubbly: {
    tag: '[excited]',
    delivery: 'sparkly, delighted, and high-energy',
  },
  sassy: {
    tag: '[laughs]',
    delivery: 'confident, teasing, and amused',
  },
  sarcastic: {
    tag: '[laughs]',
    delivery: 'dry, amused, and sharply timed',
  },
  wise: {
    tag: '[sighs]',
    delivery: 'calm, knowing, and gently amused',
  },
  gruff: {
    tag: '[sighs]',
    delivery: 'raspy, impatient, and low-energy',
  },
  dramatic: {
    tag: '[excited]',
    delivery: 'big, theatrical, suspenseful, and emphatic',
  },
  neutral: {
    tag: '',
    delivery: 'natural and conversational',
  },
};

export const buildExpressivePrompt = (text, voiceStyle = 'cheerful', emotionalDelivery = '') => {
  const profile = EMOTIONAL_DELIVERY_PROFILES[voiceStyle] || EMOTIONAL_DELIVERY_PROFILES.neutral;
  const delivery = emotionalDelivery || profile.delivery;
  const expressiveCue = profile.tag || 'none';
  const line = profile.tag ? `${profile.tag} ${text}` : text;

  return `Speak exactly this line as the animated object. Do not explain, paraphrase, or add extra words.
Voice style: ${voiceStyle}.
Emotional delivery: ${delivery}.
Expressive cue: ${expressiveCue}.
The bracketed cue is an ElevenLabs expressive tag for delivery, not a literal spoken word.
Line: "${line}"`;
};
