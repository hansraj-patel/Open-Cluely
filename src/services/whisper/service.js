'use strict';

const { buildWavBuffer } = require('./wav');
const { createWhisperServerManager } = require('./server-manager');
const {
  createSttHistoryManager,
  normalizeSttSource
} = require('../assembly-ai/stt-history');

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// VAD / segmentation tuning. Audio arrives as ~100ms PCM16 frames.
const SILENCE_RMS_THRESHOLD = 400; // int16 RMS below this counts as silence
const SILENCE_HANG_MS = 700; // trailing silence that closes a speech segment
const MIN_SEGMENT_MS = 400; // ignore blips shorter than this
const MAX_SEGMENT_MS = 8000; // force a flush during continuous speech (bounds latency)

function rmsOfPcm16(buffer) {
  const sampleCount = Math.floor(buffer.length / BYTES_PER_SAMPLE);
  if (sampleCount === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = buffer.readInt16LE(i * BYTES_PER_SAMPLE);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function bytesToMs(byteLength) {
  return (byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
}

function createWhisperService({
  desktopCapturer,
  getGeminiService,
  sendToRenderer,
  serverManager = createWhisperServerManager()
}) {
  function emitSttDebug({ source = null, level = 'info', event = 'event', message = '', meta = null } = {}) {
    sendToRenderer('stt-debug', {
      ts: new Date().toISOString(),
      source: source === 'mic' || source === 'system' ? source : null,
      level,
      event,
      message,
      meta
    });
  }

  serverManager = serverManager || createWhisperServerManager({ log: (level, event, message, meta) => emitSttDebug({ level, event, message, meta }) });

  const sttHistoryManager = createSttHistoryManager({
    getGeminiService,
    emitSttDebug,
    mergeWindowMs: 3500
  });

  function makeSourceState() {
    return {
      streaming: false,
      chunks: [],
      bytes: 0,
      voicedMs: 0,
      silenceMs: 0,
      inSpeech: false,
      transcribeChain: Promise.resolve(),
      segmentCounter: 0
    };
  }

  const sources = {
    mic: makeSourceState(),
    system: makeSourceState()
  };

  function getState(source) {
    return sources[normalizeSttSource(source)];
  }

  function resetSegment(state) {
    state.chunks = [];
    state.bytes = 0;
    state.voicedMs = 0;
    state.silenceMs = 0;
    state.inSpeech = false;
  }

  async function transcribeSegment(resolvedSource, pcmBuffer) {
    const wav = buildWavBuffer(pcmBuffer, { sampleRate: SAMPLE_RATE });
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const response = await fetch(serverManager.getInferenceUrl(), { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`whisper-server returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    let text = '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      text = String(payload.text ?? payload.transcription ?? '').trim();
    } else {
      text = (await response.text()).trim();
    }
    return text;
  }

  function flushSegment(resolvedSource, { reason = 'silence' } = {}) {
    const state = sources[resolvedSource];
    if (state.bytes === 0 || state.voicedMs < MIN_SEGMENT_MS) {
      resetSegment(state);
      return;
    }

    const pcmBuffer = Buffer.concat(state.chunks, state.bytes);
    resetSegment(state);
    state.segmentCounter += 1;

    emitSttDebug({
      source: resolvedSource,
      event: 'segment-flush',
      message: `Transcribing ${bytesToMs(pcmBuffer.length).toFixed(0)}ms segment`,
      meta: { reason, segment: state.segmentCounter }
    });

    // Serialize requests per source so transcripts stay in spoken order.
    state.transcribeChain = state.transcribeChain
      .then(async () => {
        if (!state.streaming) {
          return;
        }
        const text = await transcribeSegment(resolvedSource, pcmBuffer);
        if (!text) {
          return;
        }
        sendToRenderer('vosk-final', { source: resolvedSource, text });
        sttHistoryManager.queueSttHistorySegment(resolvedSource, text);
        emitSttDebug({
          source: resolvedSource,
          event: 'turn-final',
          message: 'Final transcript received',
          meta: { chars: text.length }
        });
      })
      .catch((error) => {
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'transcribe-failed',
          message: error.message
        });
        sendToRenderer('vosk-error', {
          source: resolvedSource,
          error: `Whisper transcription failed: ${error.message}`
        });
      });
  }

  async function startStream(source) {
    const resolvedSource = normalizeSttSource(source);
    const state = sources[resolvedSource];

    if (state.streaming) {
      return { success: true, message: 'Already streaming' };
    }

    if (!serverManager.isBinaryAvailable()) {
      const error = 'whisper-server not found. Install it with: brew install whisper-cpp';
      sendToRenderer('vosk-error', { source: resolvedSource, error });
      return { success: false, error };
    }
    if (!serverManager.isModelAvailable()) {
      const error = 'No Whisper model found under ~/.local/share/whisper-cpp.';
      sendToRenderer('vosk-error', { source: resolvedSource, error });
      return { success: false, error };
    }

    resetSegment(state);
    state.transcribeChain = Promise.resolve();
    sttHistoryManager.resetSttHistoryBuffer(resolvedSource);

    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'loading',
      message: 'Starting local Whisper...'
    });

    try {
      await serverManager.start();
    } catch (error) {
      sendToRenderer('vosk-error', { source: resolvedSource, error: error.message });
      return { success: false, error: error.message };
    }

    state.streaming = true;
    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'listening',
      message: `Listening (${resolvedSource === 'system' ? 'Host' : 'You'})...`
    });
    emitSttDebug({ source: resolvedSource, event: 'whisper-listening', message: 'Local Whisper listening' });

    return { success: true };
  }

  function handleAudioChunk({ source, data }) {
    const resolvedSource = normalizeSttSource(source);
    const state = sources[resolvedSource];
    if (!state.streaming || !data) {
      return;
    }

    const chunk = Buffer.from(data);
    const chunkMs = bytesToMs(chunk.length);
    const voiced = rmsOfPcm16(chunk) >= SILENCE_RMS_THRESHOLD;

    if (voiced) {
      state.inSpeech = true;
      state.silenceMs = 0;
      state.voicedMs += chunkMs;
      state.chunks.push(chunk);
      state.bytes += chunk.length;
    } else if (state.inSpeech) {
      // Keep trailing silence in the buffer so word endings aren't clipped.
      state.silenceMs += chunkMs;
      state.chunks.push(chunk);
      state.bytes += chunk.length;
    }

    const segmentMs = bytesToMs(state.bytes);
    if (state.inSpeech && state.silenceMs >= SILENCE_HANG_MS) {
      flushSegment(resolvedSource, { reason: 'silence' });
    } else if (segmentMs >= MAX_SEGMENT_MS) {
      flushSegment(resolvedSource, { reason: 'max-length' });
    }
  }

  function stopVoiceRecognition({ source } = {}) {
    const stopSource = (src) => {
      const resolvedSource = normalizeSttSource(src);
      const state = sources[resolvedSource];
      if (state.streaming) {
        flushSegment(resolvedSource, { reason: 'stop' });
      }
      state.streaming = false;
      sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'stop-request');
      sendToRenderer('vosk-status', { source: resolvedSource, status: 'stopped', message: 'Stopped' });
      emitSttDebug({ source: resolvedSource, event: 'stop-issued', message: 'Local Whisper source stopped' });
    };

    if (source === 'all') {
      stopSource('mic');
      stopSource('system');
    } else {
      stopSource(source === 'system' ? 'system' : 'mic');
    }

    if (!sources.mic.streaming && !sources.system.streaming) {
      serverManager.stop();
    }

    return { success: true };
  }

  async function getDesktopSources() {
    try {
      const found = await desktopCapturer.getSources({ types: ['screen'] });
      return found.map((entry) => ({ id: entry.id, name: entry.name }));
    } catch (error) {
      console.error('Error getting desktop sources:', error.message);
      return [];
    }
  }

  async function transcribeAudio() {
    return {
      success: false,
      error: 'One-shot audio upload is not supported with the local Whisper engine.'
    };
  }

  function resetSttHistoryBuffers() {
    sttHistoryManager.resetSttHistoryBuffer('mic');
    sttHistoryManager.resetSttHistoryBuffer('system');
  }

  function dispose() {
    sttHistoryManager.flushAllSttHistoryBuffers('cleanup');
    sources.mic = makeSourceState();
    sources.system = makeSourceState();
    serverManager.stop();
    sttHistoryManager.dispose();
  }

  return {
    dispose,
    emitSttDebug,
    flushAllSttHistoryBuffers: sttHistoryManager.flushAllSttHistoryBuffers,
    getDesktopSources,
    handleAudioChunk,
    resetSttHistoryBuffers,
    startStream,
    stopVoiceRecognition,
    transcribeAudio,
    describeServer: serverManager.describe
  };
}

module.exports = { createWhisperService };
