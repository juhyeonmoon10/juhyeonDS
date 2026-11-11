/*
 * juhyeonDS - one emulation session running on the server (worker thread).
 * Runs the same WebAssembly core as the browser and streams video/audio to the client.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');
const zlib = require('zlib');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const createMelonDS = require(path.join(PUBLIC_DIR, 'core', 'melonds.js'));
const EmuRunner = require(path.join(PUBLIC_DIR, 'js', 'emu-runner.js'));

// Binary message types, server -> client (first byte)
const MSG_VIDEO = 0x20;
const MSG_AUDIO = 0x21;
const MSG_SAVE = 0x22;

const FB_BYTES = EmuRunner.FB_BYTES;
const FB_WORDS = FB_BYTES / 4;

let runner = null;
let fpsDivider = 1;
let frameCounter = 0;
let needKeyframe = true;
let videoPaused = false; // set by the main thread while the socket is backed up

const prev = new Uint32Array(FB_WORDS);
const delta = new Uint32Array(FB_WORDS);
const deltaBytes = Buffer.from(delta.buffer);

function sendBinary(type, flags, payload) {
  const out = new Uint8Array(2 + payload.length);
  out[0] = type;
  out[1] = flags;
  out.set(payload, 2);
  parentPort.postMessage({ t: 'bin', kind: type, data: out.buffer }, [out.buffer]);
}

function sendJSON(obj) {
  parentPort.postMessage({ t: 'json', data: obj });
}

function onFrame(view) {
  frameCounter++;
  if (fpsDivider > 1 && frameCounter % fpsDivider !== 0) return;
  if (videoPaused) {
    needKeyframe = true;
    return;
  }

  // Copy out of wasm memory as 32-bit pixels (alignment is guaranteed by the core's static buffer).
  const cur = new Uint32Array(view.buffer, view.byteOffset, FB_WORDS);
  let payload;
  let flags = 0;
  if (needKeyframe) {
    prev.set(cur);
    payload = zlib.deflateRawSync(Buffer.from(prev.buffer), { level: 1 });
    flags = 1;
    needKeyframe = false;
  } else {
    let changed = 0;
    for (let i = 0; i < FB_WORDS; i++) {
      const c = cur[i];
      const d = c ^ prev[i];
      delta[i] = d;
      changed |= d;
      prev[i] = c;
    }
    if (changed === 0) return; // identical frame: nothing to send
    payload = zlib.deflateRawSync(deltaBytes, { level: 1 });
  }
  sendBinary(MSG_VIDEO, flags, payload);
}

function onAudio(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.length * 2);
  sendBinary(MSG_AUDIO, 0, bytes);
}

function onSave(data) {
  sendBinary(MSG_SAVE, 0, data);
}

async function load(msg) {
  const M = await createMelonDS({
    print: () => {},
    printErr: () => {},
  });
  runner = new EmuRunner(M, {
    onFrame,
    onAudio,
    onSave,
    onStats: (s) => sendJSON({ t: 'stats', fps: s.fps, load: s.load }),
    onStop: (reason) => sendJSON({ t: 'stopped', reason }),
  });
  fpsDivider = msg.fpsDivider === 2 ? 2 : 1;
  const info = runner.load(new Uint8Array(msg.rom), msg.save ? new Uint8Array(msg.save) : null, {
    sampleRate: msg.sampleRate,
    language: msg.language,
    datetime: msg.datetime,
  });
  sendJSON({ t: 'loaded', saveLen: info.saveLen });
  needKeyframe = true;
  runner.start();
}

parentPort.on('message', (msg) => {
  try {
    switch (msg.t) {
      case 'load':
        load(msg).catch((err) => sendJSON({ t: 'error', message: String(err.message || err) }));
        break;
      case 'input':
        if (runner) runner.setInput(msg.keys, msg.touching, msg.x, msg.y);
        break;
      case 'pause':
        if (runner) runner.pause();
        break;
      case 'resume':
        if (runner) {
          needKeyframe = true;
          runner.start();
        }
        break;
      case 'reset':
        if (runner) runner.reset();
        break;
      case 'lid':
        if (runner) runner.setLid(!!msg.closed);
        break;
      case 'fps':
        fpsDivider = msg.divider === 2 ? 2 : 1;
        break;
      case 'getsave':
        if (runner) sendBinary(MSG_SAVE, 1, runner.getSave());
        break;
      case 'keyframe':
        needKeyframe = true;
        break;
      case 'videoPaused':
        videoPaused = !!msg.value;
        if (!videoPaused) needKeyframe = true;
        break;
    }
  } catch (err) {
    sendJSON({ t: 'error', message: String(err.message || err) });
  }
});
