import { readViteEnv } from '../api/viteEnv.js';
import { assessLocalAISetup } from '../api/localAISetup.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const isLocalOrigin = (hostname) => LOCAL_HOSTS.has(hostname);

export const probeWebGL2Support = (documentObject) => {
  const canvas = documentObject.createElement('canvas');
  const context = canvas.getContext('webgl2');
  if (!context) {
    return false;
  }

  const supported = !context.isContextLost();
  const loseContext = context.getExtension('WEBGL_lose_context');
  if (loseContext) {
    loseContext.loseContext();
  }
  return supported;
};

export const assessRuntimeCapabilities = ({
  protocol,
  hostname,
  isSecureContext,
  hasMediaDevices,
  hasGetUserMedia,
  hasVideoFrameCallbacks,
  hasWebGL2,
  hasAudioContext,
  crossOriginIsolated,
  localAIBaseUrl,
  localAIModel,
  localAIPersonaModel,
  localAIVisionModel,
  localTTSModel,
  localTTSVoice,
}) => {
  const secureContext = Boolean(isSecureContext) || protocol === 'https:' || isLocalOrigin(hostname);
  const { personalityReady, speechReady } = assessLocalAISetup({
    localAIBaseUrl,
    localAIModel,
    localAIPersonaModel,
    localAIVisionModel,
    localTTSModel,
    localTTSVoice,
  });
  const cameraChecks = [
    {
      id: 'secureContext',
      label: 'HTTPS or localhost',
      ok: secureContext,
      severity: 'blocker',
      detail: secureContext ? 'Camera origin is valid' : 'Mobile camera requires HTTPS',
    },
    {
      id: 'mediaDevices',
      label: 'MediaDevices API',
      ok: Boolean(hasMediaDevices),
      severity: 'blocker',
      detail: hasMediaDevices ? 'Camera API is available' : 'navigator.mediaDevices is missing',
    },
    {
      id: 'getUserMedia',
      label: 'Camera capture API',
      ok: Boolean(hasGetUserMedia),
      severity: 'blocker',
      detail: hasGetUserMedia ? 'getUserMedia is available' : 'getUserMedia is missing',
    },
    {
      id: 'videoFrameCallbacks',
      label: 'Video-frame callbacks',
      ok: Boolean(hasVideoFrameCallbacks),
      severity: 'blocker',
      detail: hasVideoFrameCallbacks
        ? 'Camera processing follows presented frames'
        : 'requestVideoFrameCallback is missing',
    },
    {
      id: 'webgl2',
      label: 'WebGL 2',
      ok: Boolean(hasWebGL2),
      severity: 'blocker',
      detail: hasWebGL2 ? 'Required 3D API is available' : 'The 3D face requires WebGL 2',
    },
  ];
  const serviceChecks = [
    {
      id: 'audioContext',
      label: 'AudioContext',
      ok: Boolean(hasAudioContext),
      severity: 'service',
      detail: hasAudioContext ? 'Audio API is available' : 'AudioContext is unavailable',
    },
  ];
  const optionalServiceChecks = [
    {
      id: 'localAI',
      label: 'Local AI',
      ok: personalityReady,
      severity: 'optional',
      detail: personalityReady
        ? 'Self-hosted vision and personality generation configured'
        : 'Set the local AI URL and either one shared model or both stage-specific models',
    },
    {
      id: 'localSpeech',
      label: 'Local speech',
      ok: speechReady,
      severity: 'optional',
      detail: speechReady
        ? 'Self-hosted speech synthesis configured'
        : 'Set VITE_LOCAL_AI_TTS_MODEL and VITE_LOCAL_AI_TTS_VOICE for object speech',
    },
  ];
  const performanceChecks = [
    {
      id: 'crossOriginIsolated',
      label: 'Cross-origin isolation',
      ok: Boolean(crossOriginIsolated),
      severity: 'performance',
      detail: crossOriginIsolated
        ? 'WASM threading can be enabled'
        : 'ONNX will stay single-threaded without COOP/COEP isolation',
    },
  ];
  return [...cameraChecks, ...serviceChecks, ...optionalServiceChecks, ...performanceChecks];
};

export const collectRuntimeCapabilities = () => {
  const hasDocument = typeof document !== 'undefined';
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';
  const hasWebGL2 = hasDocument && probeWebGL2Support(document);

  return assessRuntimeCapabilities({
    protocol: hasWindow ? window.location.protocol : '',
    hostname: hasWindow ? window.location.hostname : '',
    isSecureContext: hasWindow ? window.isSecureContext : false,
    hasMediaDevices: hasNavigator && Boolean(navigator.mediaDevices),
    hasGetUserMedia: hasNavigator && Boolean(navigator.mediaDevices?.getUserMedia),
    hasVideoFrameCallbacks:
      hasWindow &&
      typeof window.HTMLVideoElement?.prototype.requestVideoFrameCallback === 'function' &&
      typeof window.HTMLVideoElement?.prototype.cancelVideoFrameCallback === 'function',
    hasWebGL2,
    hasAudioContext: hasWindow && Boolean(window.AudioContext || window.webkitAudioContext),
    crossOriginIsolated: hasWindow && Boolean(window.crossOriginIsolated),
    localAIBaseUrl: readViteEnv('VITE_LOCAL_AI_BASE_URL'),
    localAIModel: readViteEnv('VITE_LOCAL_AI_MODEL'),
    localAIPersonaModel: readViteEnv('VITE_LOCAL_AI_PERSONA_MODEL'),
    localAIVisionModel: readViteEnv('VITE_LOCAL_AI_VISION_MODEL'),
    localTTSModel: readViteEnv('VITE_LOCAL_AI_TTS_MODEL'),
    localTTSVoice: readViteEnv('VITE_LOCAL_AI_TTS_VOICE'),
  });
};
