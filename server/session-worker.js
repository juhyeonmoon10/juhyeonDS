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
const EmuSystems = require(path.join(PUBLIC_DIR, 'js', 'systems.js'));
const EmuRunner = require(path.join(PUBLIC_DIR, 'js', 'emu-runner.js'));

// Binary message types, server -> client (first byte)
const MSG_VIDEO = 0x20;
const MSG_AUDIO = 0x21;
const MSG_SAVE = 0x22;

let FB_WORDS = 0; // picture size in pixels, known once the game is loaded

let runner = null;
let fpsDivider = 1;
let needKeyframe = true;
let videoPaused = false; // set by the main thread while the socket is backed up
let streamAttached = true;
let paused = false;
let wifiEnabled = false;
let netBuffer = 0;

let prev = null;
let haveFrame = false;
let delta = null;
let deltaBytes = null;
let aligned = null;

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
  if (!streamAttached || videoPaused) {
    needKeyframe = true;
    return;
  }

  // Copy out of wasm memory as 32-bit pixels (alignment is guaranteed by the core's static buffer).
  // View the frame as 32-bit pixels; copy first if the core's buffer is not 4-byte aligned.
  let cur;
  if (view.byteOffset & 3) {
    if (!aligned) aligned = new Uint8Array(FB_WORDS * 4);
    aligned.set(view);
    cur = new Uint32Array(aligned.buffer, 0, FB_WORDS);
  } else {
    cur = new Uint32Array(view.buffer, view.byteOffset, FB_WORDS);
  }
  let payload;
  let flags = 0;
  if (needKeyframe) {
    prev.set(cur);
    payload = zlib.deflateRawSync(Buffer.from(prev.buffer), { level: 1 });
    flags = 1;
    needKeyframe = false;
    haveFrame = true;
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
  if (!streamAttached) return;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.length * 2);
  sendBinary(MSG_AUDIO, 0, bytes);
}

function onSave(data) {
  sendBinary(MSG_SAVE, 0, data);
}

async function load(msg) {
  const system = EmuSystems.get(msg.system) || EmuSystems.get('nds');
  const core = EmuSystems.CORES[system.core];
  const createCore = require(path.join(PUBLIC_DIR, 'core', core.file + '.js'));
  const M = await createCore({
    print: () => {},
    printErr: () => {},
    onNetSend(view) {
      const packet = view.slice();
      parentPort.postMessage({ t: 'net', packet }, [packet.buffer]);
    },
    onWifiSettings(view) {
      sendJSON({ t: 'wifiSettings', settings: Buffer.from(view).toString('base64') });
    },
  });
  if (msg.wifi) {
    if (typeof M._mds_set_wifi !== 'function' || typeof M._mds_net_receive !== 'function') {
      throw new Error('이 melonDS 코어는 DS Wi-Fi를 지원하지 않습니다.');
    }
    netBuffer = M._mds_alloc(2048);
    if (!netBuffer) throw new Error('DS Wi-Fi 버퍼를 만들 수 없습니다.');
    M.HEAPU8.set(msg.wifi.mac, netBuffer);
    if (msg.wifi.settings) M.HEAPU8.set(msg.wifi.settings, netBuffer + 6);
    M._mds_set_wifi(netBuffer, msg.wifi.settings ? netBuffer + 6 : 0);
    wifiEnabled = true;
  }
  runner = new EmuRunner(M, {
    onFrame,
    onAudio,
    onSave,
    onStats: (s) => {
      if (streamAttached) sendJSON({ t: 'stats', fps: s.fps, load: s.load });
    },
    onStop: (reason) => sendJSON({ t: 'stopped', reason }),
    onCrash: () => sendJSON({ t: 'crashed' }),
  }, system);
  fpsDivider = Math.max(1, Math.min(4, msg.fpsDivider | 0 || 1));
  const info = runner.load(new Uint8Array(msg.rom), msg.save ? new Uint8Array(msg.save) : null, {
    sampleRate: msg.sampleRate,
    language: msg.language,
    datetime: msg.datetime,
    bios9: msg.bios9 ? new Uint8Array(msg.bios9) : null,
    bios7: msg.bios7 ? new Uint8Array(msg.bios7) : null,
  });
  runner.setFrameLimit(fpsDivider); // the frame limit: skipped frames are neither drawn nor sent
  FB_WORDS = runner.fbBytes / 4;
  prev = new Uint32Array(FB_WORDS);
  delta = new Uint32Array(FB_WORDS);
  deltaBytes = Buffer.from(delta.buffer);
  sendJSON({ t: 'loaded', saveLen: info.saveLen, width: info.width, height: info.height, screens: info.screens, wifi: wifiEnabled });
  needKeyframe = true;
  updateRunning();
}

function updateRunning() {
  if (!runner) return;
  if (wifiEnabled || (streamAttached && !paused)) runner.start();
  else runner.pause();
}

parentPort.on('message', (msg) => {
  try {
    switch (msg.t) {
      case 'load':
        load(msg).catch((err) => sendJSON({ t: 'error', message: String(err.message || err), code: err.code || '' }));
        break;
      case 'input':
        if (runner) runner.setInput(msg.keys, msg.touching, msg.x, msg.y);
        break;
      case 'pause':
        paused = true;
        updateRunning();
        break;
      case 'resume':
        paused = false;
        needKeyframe = true;
        updateRunning();
        break;
      case 'stream':
        streamAttached = msg.attached;
        needKeyframe = true;
        if (!streamAttached && runner) runner.setInput(0, 0, 0, 0);
        updateRunning();
        if (streamAttached && runner && !runner.running && haveFrame) {
          sendBinary(MSG_VIDEO, 1, zlib.deflateRawSync(Buffer.from(prev.buffer), { level: 1 }));
        }
        break;
      case 'net':
        if (wifiEnabled && runner && msg.packet.length >= 14 && msg.packet.length <= 2048) {
          const { M } = runner;
          M.HEAPU8.set(msg.packet, netBuffer);
          M._mds_net_receive(netBuffer, msg.packet.length);
        }
        break;
      case 'reset':
        if (runner) runner.reset();
        break;
      case 'lid':
        if (runner) runner.setLid(!!msg.closed);
        break;
      case 'fps':
        fpsDivider = Math.max(1, Math.min(4, msg.divider | 0 || 1));
        if (runner) runner.setFrameLimit(fpsDivider);
        break;
      case 'speed':
        if (runner && !wifiEnabled) runner.setSpeed(msg.value);
        break;
      case 'getsave':
        if (runner) {
          const save = runner.getSave();
          if (Number.isInteger(msg.id) && msg.id > 0 && msg.id <= 0xffffffff) {
            const response = Buffer.allocUnsafe(4 + save.length);
            response.writeUInt32BE(msg.id);
            response.set(save, 4);
            sendBinary(MSG_SAVE, 3, response);
          } else {
            sendBinary(MSG_SAVE, 1, save);
          }
        }
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
