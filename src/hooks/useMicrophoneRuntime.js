import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger.js';

const createIdleRuntime = (error = null) => ({
  active: false,
  error,
});

const IDLE_MICROPHONE_TELEMETRY = Object.freeze({
  currentViseme: 'M',
  audioEnergy: 0,
  voiceActive: false,
});

const scheduleTelemetryFlush = (callback) => {
  const timeoutId = globalThis.setTimeout(callback, 100);
  return () => globalThis.clearTimeout(timeoutId);
};

export const createMicrophoneTelemetryStore = (scheduleFlush = scheduleTelemetryFlush) => {
  let snapshot = IDLE_MICROPHONE_TELEMETRY;
  const latest = { ...IDLE_MICROPHONE_TELEMETRY };
  let cancelScheduledFlush = null;
  const listeners = new Set();

  const hasSnapshotChanged = () =>
    snapshot.currentViseme !== latest.currentViseme ||
    snapshot.audioEnergy !== latest.audioEnergy ||
    snapshot.voiceActive !== latest.voiceActive;

  const promoteLatest = () => {
    if (!hasSnapshotChanged()) {
      return false;
    }
    snapshot = {
      currentViseme: latest.currentViseme,
      audioEnergy: latest.audioEnergy,
      voiceActive: latest.voiceActive,
    };
    return true;
  };

  const cancelPendingFlush = () => {
    if (!cancelScheduledFlush) {
      return;
    }
    const cancel = cancelScheduledFlush;
    cancelScheduledFlush = null;
    cancel();
  };

  const flush = () => {
    cancelScheduledFlush = null;
    if (listeners.size === 0 || !promoteLatest()) {
      return;
    }
    listeners.forEach((listener) => {
      listener();
    });
  };

  const reset = () => {
    latest.currentViseme = IDLE_MICROPHONE_TELEMETRY.currentViseme;
    latest.audioEnergy = IDLE_MICROPHONE_TELEMETRY.audioEnergy;
    latest.voiceActive = IDLE_MICROPHONE_TELEMETRY.voiceActive;
    cancelPendingFlush();
    const changed = promoteLatest();
    if (changed) {
      listeners.forEach((listener) => {
        listener();
      });
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        promoteLatest();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cancelPendingFlush();
        }
      };
    },
    publish: (sourceSnapshot) => {
      if (
        latest.currentViseme === sourceSnapshot.currentViseme &&
        latest.audioEnergy === sourceSnapshot.audioEnergy &&
        latest.voiceActive === sourceSnapshot.isVoiceActive
      ) {
        return;
      }
      latest.currentViseme = sourceSnapshot.currentViseme;
      latest.audioEnergy = sourceSnapshot.audioEnergy;
      latest.voiceActive = sourceSnapshot.isVoiceActive;
      if (listeners.size > 0 && !cancelScheduledFlush) {
        cancelScheduledFlush = scheduleFlush(flush);
      }
    },
    reset,
    dispose: () => {
      cancelPendingFlush();
      listeners.clear();
      snapshot = IDLE_MICROPHONE_TELEMETRY;
      latest.currentViseme = IDLE_MICROPHONE_TELEMETRY.currentViseme;
      latest.audioEnergy = IDLE_MICROPHONE_TELEMETRY.audioEnergy;
      latest.voiceActive = IDLE_MICROPHONE_TELEMETRY.voiceActive;
    },
  };
};

export const useMicrophoneRuntime = ({ microphoneService, available, stopTTS, onUnavailable }) => {
  const requestRef = useRef(0);
  const [telemetryStore] = useState(createMicrophoneTelemetryStore);
  const [mode, setMode] = useState(false);
  const [runtime, setRuntime] = useState(createIdleRuntime);
  const [voiceActivityThreshold, setVoiceActivityThreshold] = useState(0.02);
  const [gain, setGain] = useState(3);
  const [debugMode, setDebugMode] = useState(false);

  const deactivate = useCallback(
    async (requestId) => {
      stopTTS();
      try {
        await microphoneService.dispose();
      } catch (error) {
        if (requestId !== requestRef.current) {
          return;
        }
        setMode(false);
        setRuntime(createIdleRuntime(error.message));
        telemetryStore.reset();
        logger.warn('CameraView', `Microphone cleanup failed: ${error.message}`);
        return;
      }

      if (requestId !== requestRef.current) {
        return;
      }
      setMode(false);
      setRuntime(createIdleRuntime());
      telemetryStore.reset();
    },
    [microphoneService, stopTTS, telemetryStore],
  );

  const toggle = useCallback(
    async (enabled) => {
      const requestId = ++requestRef.current;

      if (enabled && !available) {
        onUnavailable();
        return;
      }

      if (!enabled) {
        logger.info('CameraView', 'Microphone mode toggled:', false);
        await deactivate(requestId);
        return;
      }

      setMode(true);
      logger.info('CameraView', 'Microphone mode toggled:', true);
      stopTTS();
      microphoneService.setVoiceActivityThreshold(voiceActivityThreshold);
      microphoneService.setInputGain(gain);
      microphoneService.setDebugMode(debugMode);
      setRuntime(createIdleRuntime());
      telemetryStore.reset();

      try {
        const initialized = await microphoneService.initialize();
        if (requestId !== requestRef.current || !initialized) {
          return;
        }
        setRuntime((current) => ({ ...current, active: true, error: null }));
        logger.info('CameraView', 'Microphone listening activated');
      } catch (error) {
        if (requestId !== requestRef.current) {
          return;
        }
        setMode(false);
        setRuntime(createIdleRuntime(error.message));
        telemetryStore.reset();
        logger.warn('CameraView', `Microphone not started: ${error.message}`);
      }
    },
    [
      available,
      deactivate,
      debugMode,
      gain,
      microphoneService,
      onUnavailable,
      stopTTS,
      telemetryStore,
      voiceActivityThreshold,
    ],
  );

  useEffect(() => {
    if (!available && mode) {
      const requestId = ++requestRef.current;
      deactivate(requestId);
    }
  }, [available, deactivate, mode]);

  useEffect(() => () => telemetryStore.dispose(), [telemetryStore]);

  const updateVoiceActivityThreshold = useCallback(
    (threshold) => {
      setVoiceActivityThreshold(threshold);
      microphoneService.setVoiceActivityThreshold(threshold);
      logger.info('CameraView', 'Voice activity threshold changed:', threshold);
    },
    [microphoneService],
  );

  const updateGain = useCallback(
    (nextGain) => {
      setGain(nextGain);
      microphoneService.setInputGain(nextGain);
      logger.info('CameraView', 'Microphone gain changed:', nextGain);
    },
    [microphoneService],
  );

  const updateDebugMode = useCallback(
    (enabled) => {
      setDebugMode(enabled);
      microphoneService.setDebugMode(enabled);
      logger.info('CameraView', 'Microphone debug mode:', enabled);
    },
    [microphoneService],
  );

  const resetBaseline = useCallback(() => {
    microphoneService.resetBaseline();
    logger.info('CameraView', 'Microphone baseline reset');
  }, [microphoneService]);

  const publishTelemetry = useCallback(
    (snapshot) => {
      telemetryStore.publish(snapshot);
    },
    [telemetryStore],
  );

  return {
    mode,
    runtime,
    telemetryStore,
    voiceActivityThreshold,
    gain,
    debugMode,
    toggle,
    updateVoiceActivityThreshold,
    updateGain,
    updateDebugMode,
    resetBaseline,
    publishTelemetry,
  };
};
