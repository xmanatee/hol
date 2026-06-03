const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const isLocalOrigin = (hostname) => LOCAL_HOSTS.has(hostname);

const normalizePresent = (value) => Boolean(value && String(value).trim());

export const assessRuntimeReadiness = ({
  protocol,
  hostname,
  isSecureContext,
  hasMediaDevices,
  hasGetUserMedia,
  hasWebGL,
  hasAudioContext,
  crossOriginIsolated,
  openAIKey,
  elevenLabsAgentId
}) => {
  const secureContext = Boolean(isSecureContext) || protocol === 'https:' || isLocalOrigin(hostname);
  const cameraChecks = [
    {
      id: 'secureContext',
      label: 'HTTPS or localhost',
      ok: secureContext,
      severity: 'blocker',
      detail: secureContext ? 'Camera origin is valid' : 'Mobile camera requires HTTPS'
    },
    {
      id: 'mediaDevices',
      label: 'MediaDevices API',
      ok: Boolean(hasMediaDevices),
      severity: 'blocker',
      detail: hasMediaDevices ? 'Camera API is available' : 'navigator.mediaDevices is missing'
    },
    {
      id: 'getUserMedia',
      label: 'Camera capture API',
      ok: Boolean(hasGetUserMedia),
      severity: 'blocker',
      detail: hasGetUserMedia ? 'getUserMedia is available' : 'getUserMedia is missing'
    },
    {
      id: 'webgl',
      label: 'WebGL',
      ok: Boolean(hasWebGL),
      severity: 'blocker',
      detail: hasWebGL ? '3D overlay can render' : 'WebGL is unavailable'
    }
  ];
  const serviceChecks = [
    {
      id: 'audioContext',
      label: 'AudioContext',
      ok: Boolean(hasAudioContext),
      severity: 'service',
      detail: hasAudioContext ? 'Audio playback can initialize' : 'AudioContext is unavailable'
    },
    {
      id: 'openAIKey',
      label: 'OpenAI key',
      ok: normalizePresent(openAIKey),
      severity: 'service',
      detail: normalizePresent(openAIKey) ? 'Persona generation configured' : 'Persona generation needs VITE_OPENAI_API_KEY'
    },
    {
      id: 'elevenLabsAgentId',
      label: 'ElevenLabs agent',
      ok: normalizePresent(elevenLabsAgentId),
      severity: 'service',
      detail: normalizePresent(elevenLabsAgentId) ? 'Voice playback configured' : 'Voice playback needs VITE_ELEVENLABS_AGENT_ID'
    }
  ];
  const performanceChecks = [
    {
      id: 'crossOriginIsolated',
      label: 'Cross-origin isolation',
      ok: Boolean(crossOriginIsolated),
      severity: 'performance',
      detail: crossOriginIsolated ? 'WASM threading can be enabled' : 'ONNX will stay single-threaded without COOP/COEP isolation'
    }
  ];
  const checks = [...cameraChecks, ...serviceChecks, ...performanceChecks];
  const cameraReady = cameraChecks.every(check => check.ok);
  const serviceReady = serviceChecks.every(check => check.ok);
  const performanceReady = performanceChecks.every(check => check.ok);

  return {
    status: cameraReady ? (serviceReady ? (performanceReady ? 'ready' : 'performance-limited') : 'service-setup') : 'blocked',
    cameraReady,
    serviceReady,
    performanceReady,
    checks
  };
};

export const collectRuntimeReadiness = () => {
  const viteEnv = import.meta.env || {};
  const hasDocument = typeof document !== 'undefined';
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';
  const canvas = hasDocument ? document.createElement('canvas') : null;
  const hasWebGL = Boolean(canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl')));

  return assessRuntimeReadiness({
    protocol: hasWindow ? window.location.protocol : '',
    hostname: hasWindow ? window.location.hostname : '',
    isSecureContext: hasWindow ? window.isSecureContext : false,
    hasMediaDevices: hasNavigator && Boolean(navigator.mediaDevices),
    hasGetUserMedia: hasNavigator && Boolean(navigator.mediaDevices?.getUserMedia),
    hasWebGL,
    hasAudioContext: hasWindow && Boolean(window.AudioContext || window.webkitAudioContext),
    crossOriginIsolated: hasWindow && Boolean(window.crossOriginIsolated),
    openAIKey: viteEnv.VITE_OPENAI_API_KEY,
    elevenLabsAgentId: viteEnv.VITE_ELEVENLABS_AGENT_ID
  });
};
