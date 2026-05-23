'use strict';

// Wrap raw little-endian PCM16 mono samples in a minimal RIFF/WAVE header so
// whisper-server can read them without ffmpeg (no --convert needed). The audio
// pipeline already produces 16 kHz / 16-bit / mono, which is exactly what
// whisper.cpp expects.
function buildWavBuffer(pcmBuffer, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm], header.length + dataSize);
}

module.exports = { buildWavBuffer };
