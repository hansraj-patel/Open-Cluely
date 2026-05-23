'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

// Default discovery locations for the whisper.cpp server binary and a model.
const BINARY_CANDIDATES = [
  '/opt/homebrew/bin/whisper-server',
  '/usr/local/bin/whisper-server',
  'whisper-server'
];

const MODEL_CANDIDATES = [
  path.join(os.homedir(), '.local/share/whisper-cpp/ggml-small.en.bin'),
  path.join(os.homedir(), '.local/share/whisper-cpp/ggml-base.en.bin'),
  path.join(os.homedir(), '.local/share/whisper-cpp/ggml-large-v3.bin'),
  '/opt/homebrew/share/whisper-cpp/ggml-small.en.bin'
];

const DEFAULT_PORT = 8917;
const READY_TIMEOUT_MS = 90000;

function firstExisting(candidates) {
  for (const candidate of candidates) {
    // Bare command names (no slash) are resolved by the OS via PATH at spawn time.
    if (!candidate.includes('/')) {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`whisper-server did not open ${host}:${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };

    attempt();
  });
}

function createWhisperServerManager({
  binaryPath = firstExisting(BINARY_CANDIDATES),
  modelPath = firstExisting(MODEL_CANDIDATES),
  host = '127.0.0.1',
  port = DEFAULT_PORT,
  threads = Math.max(4, Math.min(os.cpus().length, 8)),
  language = 'en',
  log = () => {}
} = {}) {
  let child = null;
  let readyPromise = null;

  function isModelAvailable() {
    return Boolean(modelPath && fs.existsSync(modelPath));
  }

  function isBinaryAvailable() {
    return Boolean(binaryPath);
  }

  function getInferenceUrl() {
    return `http://${host}:${port}/inference`;
  }

  function describe() {
    return { binaryPath, modelPath, host, port, running: Boolean(child) };
  }

  async function start() {
    if (readyPromise) {
      return readyPromise;
    }

    if (!isBinaryAvailable()) {
      throw new Error('whisper-server not found. Install it with: brew install whisper-cpp');
    }
    if (!isModelAvailable()) {
      throw new Error('No Whisper model found. Expected a ggml-*.bin under ~/.local/share/whisper-cpp.');
    }

    readyPromise = (async () => {
      const args = [
        '-m', modelPath,
        '--host', host,
        '--port', String(port),
        '-t', String(threads),
        '-l', language,
        '--no-timestamps'
      ];

      log('info', 'whisper-server-spawn', `Starting whisper-server on ${host}:${port}`, { modelPath, threads });
      child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (data) => log('debug', 'whisper-server-out', String(data).trim()));
      child.stderr.on('data', (data) => log('debug', 'whisper-server-err', String(data).trim()));

      child.on('exit', (code, signal) => {
        log('info', 'whisper-server-exit', `whisper-server exited`, { code, signal });
        child = null;
        readyPromise = null;
      });

      child.on('error', (error) => {
        log('error', 'whisper-server-error', error.message);
        child = null;
        readyPromise = null;
      });

      await waitForPort(port, host, READY_TIMEOUT_MS);
      log('info', 'whisper-server-ready', `whisper-server ready on ${host}:${port}`);
    })();

    try {
      await readyPromise;
    } catch (error) {
      stop();
      throw error;
    }

    return readyPromise;
  }

  function stop() {
    readyPromise = null;
    if (!child) {
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch (_) {
      // no-op
    }
    child = null;
  }

  return {
    start,
    stop,
    describe,
    isModelAvailable,
    isBinaryAvailable,
    getInferenceUrl
  };
}

module.exports = { createWhisperServerManager };
