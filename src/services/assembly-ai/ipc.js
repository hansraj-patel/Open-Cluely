function registerAssemblyAiIpc({ ipcMain, sttService }) {
  ipcMain.handle('start-voice-recognition', (_event, { source } = {}) => {
    const resolvedSource = source === 'system' ? 'system' : 'mic';
    console.log(`IPC: start-voice-recognition [${resolvedSource}]`);
    sttService.emitSttDebug({
      source: resolvedSource,
      event: 'ipc-start',
      message: 'Renderer requested source start'
    });

    return sttService.startStream(resolvedSource);
  });

  ipcMain.on('audio-chunk', (_event, payload = {}) => {
    sttService.handleAudioChunk(payload);
  });

  ipcMain.handle('stop-voice-recognition', (_event, { source } = {}) => {
    console.log(`IPC: stop-voice-recognition [${source}]`);
    return sttService.stopVoiceRecognition({ source });
  });

  ipcMain.handle('get-desktop-sources', async () => {
    return sttService.getDesktopSources();
  });

  ipcMain.handle('transcribe-audio', async (_event, base64Audio) => {
    console.log('IPC: transcribe-audio called, size:', base64Audio?.length || 0);
    return sttService.transcribeAudio(base64Audio);
  });
}

module.exports = {
  registerAssemblyAiIpc
};
