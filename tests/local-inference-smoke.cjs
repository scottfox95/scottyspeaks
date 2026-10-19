// Optional macOS check: generated speech through the installed local model.
// Never reads the microphone, real transcripts, API keys or client documents.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const ParakeetManager = require('../src/helpers/parakeet');
const { prepareChunks, transcribeChunk, wavInfo } = require('../src/helpers/meetingTranscriber');
(async () => {
  if (process.platform !== 'darwin') throw Error('This optional check needs macOS say and an installed Parakeet model');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-local-inference-'));
  const manager = new ParakeetManager();
  // Explicitly fail before any model provisioning if weights are absent.
  if (!manager.serverManager.isModelDownloaded('parakeet-tdt-0.6b-v3'))
    throw Error('Install the selected Parakeet model before this optional check');
  try {
    const fixture = path.join(temp, 'generated.aiff');
    execFileSync('say', ['-o', fixture, 'This is a synthetic call note. Please review the project on Friday. The budget is forty two dollars. Do not publish the draft.']);
    const [chunk] = await prepareChunks([{ path: fixture, source: 'microphone' }], path.join(temp, 'prepared'));
    const audio = fs.readFileSync(chunk.path);
    const started = Date.now();
    const result = await transcribeChunk({ provider: 'local', audio, source: 'microphone', duration: wavInfo(audio).duration,
      localTranscribe: (buffer) => manager.transcribeLocalParakeet(buffer, { model: 'parakeet-tdt-0.6b-v3' }),
      fetchImpl: () => { throw Error('Local inference attempted remote transport'); }
    });
    assert.match(result.text, /review the project on friday/i);
    assert.match(result.text, /do not publish the draft/i);
    assert.equal(result.segments[0].speaker, 'microphone');
    console.log(JSON.stringify({ success: true, elapsedMs: Date.now()-started, text: result.text, scope: 'Generated speech; actual local Parakeet inference, no microphone or cloud' }));
  } finally {
    await manager.stopServer();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
