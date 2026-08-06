import { LazyTTSClient } from '../audio/lazyTTSClient.js';
import { MicrophoneService } from '../audio/MicrophoneService.js';
import { createAnchorRuntimeService } from './AnchorRuntimeService.js';
import { CameraService } from './CameraService.js';
import { LazyPersonalityService } from './lazyPersonalityService.js';

export const createCameraSessionServices = ({ personality, tts } = {}) => ({
  camera: new CameraService(),
  anchor: createAnchorRuntimeService(),
  personality: new LazyPersonalityService(personality),
  microphone: new MicrophoneService(),
  tts: new LazyTTSClient(tts),
});

export const disposeCameraSessionServices = async ({ camera, anchor, personality, microphone, tts }) => {
  camera.stop();
  anchor.dispose();
  personality.dispose();
  await Promise.all([microphone.dispose(), tts.dispose()]);
};
