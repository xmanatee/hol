import { readViteEnv } from './viteEnv.js';

const present = (value) => typeof value === 'string' && value.trim().length > 0;

export const assessLocalAISetup = ({
  localAIBaseUrl,
  localAIModel,
  localAIPersonaModel,
  localAIVisionModel,
  localTTSModel,
  localTTSVoice,
}) => {
  const endpointReady =
    present(localAIBaseUrl) &&
    URL.canParse(localAIBaseUrl.trim()) &&
    ['http:', 'https:'].includes(new URL(localAIBaseUrl.trim()).protocol);
  return {
    personalityReady:
      endpointReady &&
      present(localAIPersonaModel ?? localAIModel) &&
      present(localAIVisionModel ?? localAIModel),
    speechReady: endpointReady && present(localTTSModel) && present(localTTSVoice),
  };
};

export const readLocalAISetup = () =>
  assessLocalAISetup({
    localAIBaseUrl: readViteEnv('VITE_LOCAL_AI_BASE_URL'),
    localAIModel: readViteEnv('VITE_LOCAL_AI_MODEL'),
    localAIPersonaModel: readViteEnv('VITE_LOCAL_AI_PERSONA_MODEL'),
    localAIVisionModel: readViteEnv('VITE_LOCAL_AI_VISION_MODEL'),
    localTTSModel: readViteEnv('VITE_LOCAL_AI_TTS_MODEL'),
    localTTSVoice: readViteEnv('VITE_LOCAL_AI_TTS_VOICE'),
  });
