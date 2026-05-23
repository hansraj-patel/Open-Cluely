'use strict';

// Facade over the available speech-to-text engines. The renderer and IPC layer
// talk to this single object; it forwards live calls (start/stop/audio) to
// whichever provider is currently active, while history flush/reset fan out to
// every provider so context is never stranded in an inactive engine.
function createSttService({ providers, getActiveProvider }) {
  function active() {
    const name = getActiveProvider();
    return providers[name] || providers.assemblyai;
  }

  function startStream(source) {
    const provider = active();
    return provider.startStream
      ? provider.startStream(source)
      : provider.startAssemblyAiStream(source);
  }

  function handleAudioChunk(payload) {
    return active().handleAudioChunk(payload);
  }

  function stopVoiceRecognition(payload) {
    return active().stopVoiceRecognition(payload);
  }

  function getDesktopSources() {
    return active().getDesktopSources();
  }

  function transcribeAudio(base64Audio) {
    return active().transcribeAudio(base64Audio);
  }

  function emitSttDebug(payload) {
    return active().emitSttDebug(payload);
  }

  function eachProvider(callback) {
    Object.values(providers).forEach((provider) => {
      try {
        callback(provider);
      } catch (error) {
        console.error('STT provider operation failed:', error.message);
      }
    });
  }

  function flushAllSttHistoryBuffers(reason) {
    eachProvider((provider) => provider.flushAllSttHistoryBuffers?.(reason));
  }

  function resetSttHistoryBuffers() {
    eachProvider((provider) => provider.resetSttHistoryBuffers?.());
  }

  function stopAll() {
    eachProvider((provider) => provider.stopVoiceRecognition?.({ source: 'all' }));
  }

  function dispose() {
    eachProvider((provider) => provider.dispose?.());
  }

  return {
    startStream,
    handleAudioChunk,
    stopVoiceRecognition,
    getDesktopSources,
    transcribeAudio,
    emitSttDebug,
    flushAllSttHistoryBuffers,
    resetSttHistoryBuffers,
    stopAll,
    dispose
  };
}

module.exports = { createSttService };
