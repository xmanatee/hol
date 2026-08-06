import { readViteEnv } from '../api/viteEnv.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const isLocalOrigin = (hostname) => LOCAL_HOSTS.has(hostname);

const normalizePresent = (value) => Boolean(value && String(value).trim());

export const probeWebGLSupport = (documentObject) => {
  const canvas = documentObject.createElement('canvas');
  const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!context) {
    return false;
  }

  const loseContext = context.getExtension('WEBGL_lose_context');
  if (loseContext) {
    loseContext.loseContext();
  }
  return true;
};

export const assessRuntimeReadiness = ({
  protocol,
  hostname,
  isSecureContext,
  hasMediaDevices,
  hasGetUserMedia,
  hasVideoFrameCallbacks,
  hasWebGL,
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
  const hasLocalAIModels =
    normalizePresent(localAIModel) ||
    (normalizePresent(localAIPersonaModel) && normalizePresent(localAIVisionModel));
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
      id: 'webgl',
      label: 'WebGL',
      ok: Boolean(hasWebGL),
      severity: 'blocker',
      detail: hasWebGL ? '3D overlay can render' : 'WebGL is unavailable',
    },
  ];
  const serviceChecks = [
    {
      id: 'audioContext',
      label: 'AudioContext',
      ok: Boolean(hasAudioContext),
      severity: 'service',
      detail: hasAudioContext ? 'Audio playback can initialize' : 'AudioContext is unavailable',
    },
  ];
  const optionalServiceChecks = [
    {
      id: 'localAI',
      label: 'Local AI',
      ok: normalizePresent(localAIBaseUrl) && hasLocalAIModels,
      severity: 'optional',
      detail:
        normalizePresent(localAIBaseUrl) && hasLocalAIModels
          ? 'Self-hosted vision and personality generation configured'
          : 'Set the local AI URL and either one shared model or both stage-specific models',
    },
    {
      id: 'localSpeech',
      label: 'Local speech',
      ok:
        normalizePresent(localAIBaseUrl) &&
        normalizePresent(localTTSModel) &&
        normalizePresent(localTTSVoice),
      severity: 'optional',
      detail:
        normalizePresent(localAIBaseUrl) && normalizePresent(localTTSModel) && normalizePresent(localTTSVoice)
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
  const checks = [...cameraChecks, ...serviceChecks, ...optionalServiceChecks, ...performanceChecks];
  const cameraReady = cameraChecks.every((check) => check.ok);
  const serviceReady = serviceChecks.every((check) => check.ok);
  const optionalServicesReady = optionalServiceChecks.every((check) => check.ok);
  const performanceReady = performanceChecks.every((check) => check.ok);

  return {
    status: cameraReady
      ? serviceReady
        ? performanceReady
          ? 'ready'
          : 'performance-limited'
        : 'service-setup'
      : 'blocked',
    cameraReady,
    serviceReady,
    optionalServicesReady,
    performanceReady,
    checks,
  };
};

export const collectRuntimeReadiness = () => {
  const hasDocument = typeof document !== 'undefined';
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';
  const hasWebGL = hasDocument && probeWebGLSupport(document);

  return assessRuntimeReadiness({
    protocol: hasWindow ? window.location.protocol : '',
    hostname: hasWindow ? window.location.hostname : '',
    isSecureContext: hasWindow ? window.isSecureContext : false,
    hasMediaDevices: hasNavigator && Boolean(navigator.mediaDevices),
    hasGetUserMedia: hasNavigator && Boolean(navigator.mediaDevices?.getUserMedia),
    hasVideoFrameCallbacks:
      hasWindow &&
      typeof window.HTMLVideoElement?.prototype.requestVideoFrameCallback === 'function' &&
      typeof window.HTMLVideoElement?.prototype.cancelVideoFrameCallback === 'function',
    hasWebGL,
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
