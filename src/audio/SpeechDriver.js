import { VisemePicker } from './lipSync.js';

export class SpeechDriver {
  constructor() {
    this.microphone = null;
    this.tts = null;
    this.microphonePicker = new VisemePicker();
    this.ttsPicker = new VisemePicker();
    this.microphoneFrame = { currentViseme: 'M', audioEnergy: 0, isVoiceActive: false };
    this.frame = { currentViseme: 'M', audioEnergy: 0, isVoiceActive: false };
  }

  readFrame(microphoneService, ttsService, timeMs) {
    const microphone = microphoneService?.isActive ? microphoneService : null;
    const tts = ttsService?.isPlaying ? ttsService : null;
    if (microphone !== this.microphone) {
      this.microphonePicker.reset();
      this.microphone = microphone;
    }
    if (tts !== this.tts) {
      this.ttsPicker.reset();
      this.tts = tts;
    }

    const microphoneFrame = this.microphoneFrame;
    if (microphone) {
      const microphoneAudio = microphone.readFrame();
      microphoneFrame.currentViseme = this.microphonePicker.pickViseme(
        microphoneAudio.energy,
        microphoneAudio.centroid,
        timeMs,
      );
      microphoneFrame.audioEnergy = microphoneAudio.energy;
      microphoneFrame.isVoiceActive = microphoneAudio.voiceActive;
    } else {
      microphoneFrame.currentViseme = 'M';
      microphoneFrame.audioEnergy = 0;
      microphoneFrame.isVoiceActive = false;
    }

    if (!tts) {
      return microphoneFrame;
    }
    const audio = tts.readFrame();
    this.frame.currentViseme = this.ttsPicker.pickViseme(audio.energy, audio.centroid, timeMs);
    this.frame.audioEnergy = audio.energy;
    this.frame.isVoiceActive = audio.energy >= this.ttsPicker.energyThreshold;
    return this.frame;
  }
}
