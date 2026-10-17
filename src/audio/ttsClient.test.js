import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSClient } from './ttsClient.js';
import { LazyTTSClient } from './lazyTTSClient.js';
import { SpeechDriver } from './SpeechDriver.js';
import { SPEECH_INPUT_MAX_CHARACTERS } from '../contracts/objectContent.js';

class FakeAnalyser {
  constructor() {
    this.frequencyBinCount = 4;
    this.frequencyReads = 0;
  }

  connect() {}

  getByteFrequencyData(target) {
    this.frequencyReads++;
    target.set([24, 64, 112, 32]);
  }
}

class FakeSource {
  connect() {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = {};
    this.source = new FakeSource();
    this.analyser = new FakeAnalyser();
  }

  createBufferSource() {
    return this.source;
  }
  createAnalyser() {
    return this.analyser;
  }
  async decodeAudioData(buffer) {
    return { byteLength: buffer.byteLength };
  }
  async close() {
    this.state = 'closed';
  }
}

const audioResponse = () =>
  new Response(new Uint8Array([82, 73, 70, 70]), {
    status: 200,
    headers: { 'Content-Type': 'audio/wav' },
  });

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail(message);
};

const createManualScheduler = () => {
  let callback = null;
  return {
    schedule(nextCallback) {
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    expire() {
      assert.notEqual(callback, null);
      callback();
    },
  };
};

const createClient = (overrides = {}) =>
  new TTSClient({
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'kokoro-local',
    voice: 'af_heart',
    AudioContextClass: FakeAudioContext,
    fetchImpl: async () => audioResponse(),
    ...overrides,
  });

const synthesizeTestSpeech = (client, text) =>
  client.synthesizeSpeech(text, 'cheerful', 'bright and playful');

for (const completion of ['ended', 'cancelled']) {
  test(`speech owns animation over the microphone until playback is ${completion}`, async () => {
    const response = createDeferred();
    const client = new LazyTTSClient({
      loadClient: async () => ({ TTSClient }),
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'kokoro-local',
      voice: 'af_heart',
      AudioContextClass: FakeAudioContext,
      fetchImpl: () => response.promise,
    });
    const driver = new SpeechDriver();
    const microphoneAudio = { energy: 0.8, centroid: 0.1, voiceActive: true };
    let microphoneReads = 0;
    const microphone = {
      isActive: true,
      readFrame() {
        microphoneReads++;
        return microphoneAudio;
      },
    };
    assert.equal(client.isPlaying, false);
    const pending = synthesizeTestSpeech(client, 'Hello');
    driver.readFrame(microphone, client, 100);
    assert.deepEqual(driver.readFrame(microphone, client, 160), {
      currentViseme: 'U',
      audioEnergy: 0.8,
      isVoiceActive: true,
    });

    response.resolve(audioResponse());
    assert.equal(await pending, true);
    assert.equal(client.isPlaying, true);
    driver.readFrame(microphone, client, 200);
    const speechFrame = driver.readFrame(microphone, client, 260);
    assert.equal(speechFrame.currentViseme, 'E');
    assert.equal(speechFrame.isVoiceActive, true);
    assert.equal(microphoneReads, 4);
    assert.equal(client.runtime.audioContext.analyser.frequencyReads, 2);
    assert.deepEqual(driver.microphoneFrame, {
      currentViseme: 'U',
      audioEnergy: 0.8,
      isVoiceActive: true,
    });

    if (completion === 'ended') {
      client.runtime.audioContext.source.onended();
    } else {
      client.stopCurrentAudio();
    }
    assert.equal(client.isPlaying, false);
    assert.deepEqual(driver.readFrame(microphone, client, 276), driver.microphoneFrame);
    assert.equal(driver.microphoneFrame.currentViseme, 'U');
    assert.equal(client.runtime.audioContext.analyser.frequencyReads, 2);

    microphone.isActive = false;
    assert.deepEqual(driver.readFrame(microphone, client, 292), {
      currentViseme: 'M',
      audioEnergy: 0,
      isVoiceActive: false,
    });
    await client.dispose();
    assert.equal(client.isPlaying, false);
  });
}

test('speech driver respects microphone VAD and resets history when the input changes', () => {
  const driver = new SpeechDriver();
  const microphone = {
    isActive: true,
    readFrame: () => ({ energy: 0.8, centroid: 0.1, voiceActive: true }),
  };
  driver.readFrame(microphone, null, 100);
  assert.equal(driver.readFrame(microphone, null, 160).currentViseme, 'U');
  const replacement = {
    isActive: true,
    readFrame: () => ({ energy: 0.7, centroid: 0.9, voiceActive: false }),
  };
  driver.readFrame(replacement, null, 176);
  assert.deepEqual(driver.readFrame(replacement, null, 192), {
    currentViseme: 'I',
    audioEnergy: 0.7,
    isVoiceActive: false,
  });
  replacement.isActive = false;
  driver.readFrame(replacement, null, 208);
  replacement.isActive = true;
  assert.equal(driver.readFrame(replacement, null, 224).currentViseme, 'M');
});

test('silent TTS keeps ownership and a later playback starts with fresh viseme history', () => {
  const driver = new SpeechDriver();
  const microphone = {
    isActive: true,
    readFrame: () => ({ energy: 0.8, centroid: 0.1, voiceActive: true }),
  };
  const audio = { energy: 0, centroid: 0 };
  const tts = { isPlaying: true, readFrame: () => audio };
  driver.readFrame(microphone, tts, 100);
  assert.deepEqual(driver.readFrame(microphone, tts, 160), {
    currentViseme: 'M',
    audioEnergy: 0,
    isVoiceActive: false,
  });
  audio.energy = 0.7;
  audio.centroid = 0.9;
  driver.readFrame(microphone, tts, 200);
  assert.equal(driver.readFrame(microphone, tts, 260).currentViseme, 'I');
  tts.isPlaying = false;
  assert.equal(driver.readFrame(microphone, tts, 276).currentViseme, 'U');
  tts.isPlaying = true;
  audio.centroid = 0.4;
  driver.readFrame(microphone, tts, 292);
  assert.equal(driver.readFrame(microphone, tts, 308).currentViseme, 'A');
});

test('local speech client posts the standard speech contract and starts analysed playback', async () => {
  let request = null;
  const events = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return audioResponse();
    },
  });
  client.addListener({
    onAudioStart: (event) => events.push(['start', event.latencyToFirstAudio]),
  });

  assert.equal(await client.synthesizeSpeech('Hello object!', 'dramatic', 'theatrical'), true);

  const payload = JSON.parse(request.options.body);
  assert.equal(request.url, 'http://127.0.0.1:8080/v1/audio/speech');
  assert.equal(payload.model, 'kokoro-local');
  assert.equal(payload.voice, 'af_heart');
  assert.equal(payload.input, 'Hello object!');
  assert.match(payload.instructions, /dramatic/);
  assert.equal(payload.response_format, 'wav');
  assert.equal(client.audioContext.source.started, true);
  assert.equal(client.isPlaying, true);
  assert.equal(client.audioContext.analyser.frequencyReads, 0);
  const firstFrame = client.readFrame();
  const secondFrame = client.readFrame();
  assert.equal(firstFrame, secondFrame);
  assert.deepEqual(Object.keys(firstFrame), ['energy', 'centroid']);
  assert.equal(client.audioContext.analyser.frequencyReads, 2);
  assert.equal(events[0][0], 'start');
  assert.equal(events.length, 1);
});

test('completed local playback updates metrics and returns facial animation to rest', async () => {
  const events = [];
  const client = createClient();
  client.addListener({
    onPlaybackComplete: () => events.push('complete'),
    onSynthesisComplete: () => events.push('synthesized'),
  });

  await synthesizeTestSpeech(client, 'Hello');
  const activeFrame = client.readFrame();
  client.audioContext.source.onended();

  assert.equal(client.isPlaying, false);
  assert.equal(client.readFrame(), activeFrame);
  assert.deepEqual(activeFrame, { energy: 0, centroid: 0 });
  assert.deepEqual(events, ['complete', 'synthesized']);
  assert.equal(client.getMetrics().successfulRequests, 1);
  assert.equal(client.getMetrics().successRate, 100);
});

test('stopping local playback is idempotent and completes the active request once', async () => {
  const events = [];
  const client = createClient();
  client.addListener({ onPlaybackComplete: () => events.push('complete') });
  await synthesizeTestSpeech(client, 'Stop me');

  client.stopCurrentAudio();
  client.stopCurrentAudio();

  assert.equal(client.audioContext.source.stopped, true);
  assert.deepEqual(events, ['complete']);
  assert.equal(client.getMetrics().successfulRequests, 0);
});

test('stopping speech during audio startup prevents late synthesis and allows a new request', async () => {
  const ready = createDeferred();
  let resuming = false;
  let requests = 0;
  class SuspendedAudioContext extends FakeAudioContext {
    constructor() {
      super();
      this.state = 'suspended';
    }
    async resume() {
      resuming = true;
      await ready.promise;
      this.state = 'running';
    }
  }
  const client = createClient({
    AudioContextClass: SuspendedAudioContext,
    fetchImpl: async () => {
      requests++;
      return audioResponse();
    },
  });
  const speech = synthesizeTestSpeech(client, 'cancel startup');
  await waitFor(() => resuming, 'audio startup did not begin');
  client.stopCurrentAudio();
  ready.resolve();
  assert.equal(await speech, false);
  assert.equal(requests, 0);
  assert.equal(client.isPlaying, false);
  assert.equal(await synthesizeTestSpeech(client, 'new speech'), true);
  await client.dispose();
});

test('stopping speech discards late download and decode completion without reporting errors', async () => {
  for (const stage of ['download', 'decode']) {
    const pending = createDeferred();
    const reachedStage = createDeferred();
    let signal = null;
    const errors = [];
    class DecodingAudioContext extends FakeAudioContext {
      async decodeAudioData(buffer) {
        if (stage === 'decode') {
          reachedStage.resolve();
          return await pending.promise;
        }
        return super.decodeAudioData(buffer);
      }
    }
    const client = createClient({
      AudioContextClass: DecodingAudioContext,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        if (stage === 'download') {
          reachedStage.resolve();
          return await pending.promise;
        }
        return audioResponse();
      },
    });
    client.addListener({ onError: ({ error }) => errors.push(error) });
    const speech = synthesizeTestSpeech(client, 'cancel pending speech');
    await reachedStage.promise;
    client.stopCurrentAudio();
    if (stage === 'download') assert.equal(signal.aborted, true);
    pending.resolve(stage === 'download' ? audioResponse() : { byteLength: 4 });
    assert.equal(await speech, false);
    assert.equal(client.isPlaying, false);
    assert.equal(client.audioContext.source.started, undefined);
    assert.equal(client.getMetrics().successfulRequests, 0);
    assert.deepEqual(errors, []);
    await client.dispose();
  }
});

test('local speech configuration and provider failures are explicit', async () => {
  assert.throws(
    () =>
      new TTSClient({
        baseUrl: 'http://127.0.0.1:8080/v1',
        AudioContextClass: FakeAudioContext,
        fetchImpl: async () => audioResponse(),
      }),
    /VITE_LOCAL_AI_TTS_MODEL/,
  );

  const events = [];
  const failed = createClient({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: 'voice missing' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  failed.addListener({ onError: ({ error }) => events.push(error) });
  await assert.rejects(() => synthesizeTestSpeech(failed, 'Hello'), /voice missing/);
  assert.deepEqual(events, ['voice missing']);
});

test('local speech rejects ambiguous input and configuration before runtime work', async () => {
  const client = createClient();

  await assert.rejects(() => client.synthesizeSpeech(undefined), /must be a string/);
  await assert.rejects(() => client.synthesizeSpeech('  '), /must be non-empty/);
  await assert.rejects(() => client.synthesizeSpeech('hello'), /voice style must be a string/);
  await assert.rejects(() => client.synthesizeSpeech('hello', ''), /voice style must be non-empty/);
  await assert.rejects(() => client.synthesizeSpeech('hello', 'unknown', 'calm'), /unsupported voice style/);
  await assert.rejects(() => client.synthesizeSpeech('hello', 'wise'), /emotional delivery must be a string/);
  await assert.rejects(() => client.synthesizeSpeech('hello', 'wise', null), /emotional delivery/);
  await assert.rejects(
    () => client.synthesizeSpeech('hello', 'wise', '  '),
    /emotional delivery must be non-empty/,
  );
  await assert.rejects(
    () => client.synthesizeSpeech('😀'.repeat(SPEECH_INPUT_MAX_CHARACTERS + 1), 'wise', 'calm and measured'),
    /Speech input must contain at most 240 characters/,
  );

  assert.throws(() => createClient({ fetchImpl: null }), /Fetch API/);
  assert.throws(() => createClient({ requestTimeoutMs: Number.NaN }), /positive finite number/);
  assert.equal(client.audioContext, null);
});

test('local speech deadline covers stalled audio body reads and clears active ownership', async () => {
  const scheduler = createManualScheduler();
  const errors = [];
  let requestSignal = null;
  const client = createClient({
    requestTimeoutMs: 750,
    scheduleRequestTimeout: scheduler.schedule,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Response(new ReadableStream(), {
        headers: { 'Content-Type': 'audio/wav' },
      });
    },
  });
  client.addListener({ onError: ({ error }) => errors.push(error) });

  const speech = synthesizeTestSpeech(client, 'slow voice');
  await waitFor(() => requestSignal !== null, 'speech transport did not start');
  scheduler.expire();

  await assert.rejects(speech, /Local speech request timed out after 750ms/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(client.currentRequest, null);
  assert.equal(client.currentAbortController, null);
  assert.deepEqual(errors, ['Local speech request timed out after 750ms']);
});

test('disposing local speech releases playback, listeners, and AudioContext', async () => {
  const client = createClient();
  await synthesizeTestSpeech(client, 'Goodbye');
  const context = client.audioContext;
  await client.dispose();

  assert.equal(context.state, 'closed');
  assert.equal(client.audioContext, null);
  assert.equal(client.listeners.size, 0);
});

test('a stale provider failure cannot cancel or report over a newer speech request', async () => {
  const requests = [];
  const errors = [];
  const client = createClient({
    fetchImpl: (url, options) => {
      const response = createDeferred();
      requests.push({ url, options, response });
      return response.promise;
    },
  });
  client.addListener({ onError: ({ error }) => errors.push(error) });

  const firstSpeech = synthesizeTestSpeech(client, 'first');
  await waitFor(() => requests.length === 1, 'first speech transport did not start');
  const secondSpeech = synthesizeTestSpeech(client, 'second');
  await waitFor(() => requests.length === 2, 'second speech transport did not start');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal.aborted, true);
  requests[0].response.resolve(
    new Response(
      JSON.stringify({
        error: { message: 'stale provider failure' },
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );

  assert.equal(await firstSpeech, false);
  assert.equal(client.currentRequest.text, 'second');
  assert.deepEqual(errors, []);

  requests[1].response.resolve(audioResponse());
  assert.equal(await secondSpeech, true);
  assert.equal(client.isPlaying, true);
  assert.equal(client.currentRequest.text, 'second');
});

test('disposal wins speech initialization suspended in AudioContext resume', async () => {
  const resume = createDeferred();
  let resumeStarted = false;
  let fetchCount = 0;
  class SuspendedAudioContext extends FakeAudioContext {
    constructor() {
      super();
      this.state = 'suspended';
    }

    async resume() {
      resumeStarted = true;
      await resume.promise;
      if (this.state === 'closed') {
        throw new DOMException('Cannot resume a closed AudioContext', 'InvalidStateError');
      }
      this.state = 'running';
    }
  }
  const client = createClient({
    AudioContextClass: SuspendedAudioContext,
    fetchImpl: async () => {
      fetchCount++;
      return audioResponse();
    },
  });

  const speech = synthesizeTestSpeech(client, 'late speech');
  await Promise.resolve();
  await Promise.resolve();
  const context = client.audioContext;
  assert.equal(resumeStarted, true);

  await client.dispose();
  resume.resolve();

  assert.equal(await speech, false);
  assert.equal(fetchCount, 0);
  assert.equal(context.state, 'closed');
  assert.equal(client.audioContext, null);
});

test('disposed local speech cannot recreate AudioContext or issue network work', async () => {
  let contextCount = 0;
  let fetchCount = 0;
  class CountingAudioContext extends FakeAudioContext {
    constructor() {
      super();
      contextCount++;
    }
  }
  const client = createClient({
    AudioContextClass: CountingAudioContext,
    fetchImpl: async () => {
      fetchCount++;
      return audioResponse();
    },
  });

  await client.dispose();

  assert.equal(await synthesizeTestSpeech(client, 'after disposal'), false);
  assert.equal(contextCount, 0);
  assert.equal(fetchCount, 0);
});

test('active AudioContext resume failures remain explicit', async () => {
  let fetchCount = 0;
  class RejectedResumeAudioContext extends FakeAudioContext {
    constructor() {
      super();
      this.state = 'suspended';
    }

    async resume() {
      throw new Error('audio resume rejected');
    }
  }
  const client = createClient({
    AudioContextClass: RejectedResumeAudioContext,
    fetchImpl: async () => {
      fetchCount++;
      return audioResponse();
    },
  });

  await assert.rejects(() => synthesizeTestSpeech(client, 'current request'), /audio resume rejected/);
  assert.equal(fetchCount, 0);
});
