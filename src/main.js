// The app is designed to keep running in the background after its window
// closes (stealth operation). When it was launched from a terminal that is
// later closed, the inherited stdout/stderr pipe breaks, and the next
// console write throws EPIPE/EIO — which Electron surfaces as a fatal
// "JavaScript error in the main process" dialog. Swallow those broken-pipe
// errors so the process survives losing its terminal.
function isBrokenPipeError(error) {
  const code = error && error.code;
  return code === 'EPIPE' || code === 'EIO';
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      return;
    }
    throw error;
  });
}

process.on('uncaughtException', (error) => {
  if (isBrokenPipeError(error)) {
    return;
  }
  try {
    console.error('Uncaught exception:', error);
  } catch (_) {
    // stdout/stderr may itself be gone — nothing more we can safely do.
  }
});

const { startApplication } = require('./main-process/start-application');

startApplication().catch((error) => {
  console.error('Fatal startup failure:', error);
  process.exit(1);
});
