/*
 * juhyeonDS - backend that emulates on the server and streams video/audio over WebSocket.
 * Licensed under the GNU General Public License v3 or later.
 */

const MSG_ROM_CHUNK = 0x01;
const MSG_SAVE_CHUNK = 0x02;
const MSG_BIOS9 = 0x03;
const MSG_BIOS7 = 0x04;
const MSG_INPUT = 0x10;
const MSG_VIDEO = 0x20;
const MSG_AUDIO = 0x21;
const MSG_SAVE = 0x22;
const CHUNK = 256 * 1024;
const UPLOAD_WINDOW = 4 * 1024 * 1024;
const PROTOCOL = 'juhyeonds-v2';
const OPEN_TIMEOUT = 8000;
const MESSAGE_TIMEOUT = 20_000;
const START_TIMEOUT = 120_000;

export function serverBaseUrl() {
  const configured = (window.MELONDS_CONFIG && window.MELONDS_CONFIG.serverUrl) || '';
  return (configured || location.origin).replace(/\/+$/, '');
}

/** Asks the server whether it offers emulation. Resolves to null when there is no server. */
export async function probeServer(base) {
  if (!base && location.protocol === 'file:' && !(window.MELONDS_CONFIG && window.MELONDS_CONFIG.serverUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), base ? 6000 : 4000);
  try {
    const res = await fetch((base || serverBaseUrl()) + '/api/info', { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    return info && info.name === 'juhyeonds' ? info : null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lists the servers that are switched on right now.
 * Servers started with --tunnel post their address to a public bulletin board (see server/announce.js);
 * this reads the recent posts and keeps the servers that actually answer.
 * Resolves to [{url, name, info}] (possibly empty), or null when the feature is off or the board is unreachable.
 */
export async function discoverServers() {
  const config = window.MELONDS_CONFIG || {};
  const topic = config.serverDirectory || '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(topic)) return null;
  const host = (config.serverDirectoryHost || 'https://ntfy.sh').replace(/\/+$/, '');
  let text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${host}/${topic}/json?poll=1&since=25m`, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    text = await res.text();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
  // Newest post per address wins; an "off" post removes the server.
  const latest = new Map();
  for (const line of text.split('\n')) {
    try {
      const post = JSON.parse(line);
      if (post.event !== 'message') continue;
      const entry = JSON.parse(post.message);
      const url = new URL(String(entry.u));
      if (url.protocol !== 'https:' || url.origin !== String(entry.u)) continue;
      latest.set(url.origin, { url: url.origin, name: String(entry.n || '').slice(0, 40) || url.hostname, off: !!entry.off });
    } catch (err) {
      /* not one of ours */
    }
  }
  const candidates = [...latest.values()].filter((s) => !s.off).slice(-8);
  const checked = await Promise.all(candidates.map(async (s) => ({ url: s.url, name: s.name, info: await probeServer(s.url) })));
  return checked.filter((s) => s.info && s.info.emulation);
}

/** SHA-256 of a byte array as lowercase hex, without the Web Crypto API (which plain-http pages lack). */
function sha256Fallback(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const length = bytes.length;
  // Message followed by 0x80, zero padding and the 64-bit bit length.
  const tail = new Uint8Array(((length % 64) < 56 ? 64 : 128));
  tail.set(bytes.subarray(length - (length % 64)));
  tail[length % 64] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, Math.floor(length / 0x20000000));
  tv.setUint32(tail.length - 4, (length << 3) >>> 0);

  const block = (view, offset) => {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15];
      const b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = length - (length % 64);
  for (let offset = 0; offset < whole; offset += 64) block(view, offset);
  for (let offset = 0; offset < tail.length; offset += 64) block(tv, offset);
  return Array.from(H, (word) => word.toString(16).padStart(8, '0')).join('');
}

/** SHA-256 of a Blob as lowercase hex. The server uses it to recognise games it already holds. */
export async function hashBlob(blob) {
  const buffer = await blob.arrayBuffer();
  if (window.crypto && window.crypto.subtle) {
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', buffer));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return sha256Fallback(new Uint8Array(buffer));
}

export { sha256Fallback };

export class RemoteBackend {
  constructor(password) {
    this.kind = 'server';
    this.password = password || '';
    this.ws = null;
    this.closedByUs = false;
    this.started = false;
    this.connected = false;
    this.wifi = false;
    this.token = '';
    this.resumeMs = 60_000;
    this.retryDeadline = 0;
    this.retryTimer = null;
    this.retryDelay = 250;
    this.freshConnections = 0;
    this.controls = new Map();
    this.fbBytes = 0; // set once the server reports the picture size
    this.frame = null;
    this.frame32 = null;
    this.scratch = null;
    this.scratch32 = null;
    this.haveKeyframe = false;
    this.saveWaiters = new Map();
    this.saveId = 0;
    this.latestSave = new Uint8Array(0);
    this.latestAutoSave = new Uint8Array(0);
    this.lastInput = '';
    this.input = null;
    this.ping = null;
    this.pingTimer = null;
    this.pendingPing = null;
    this.pingId = 0;
    this.onFrame = this.onAudio = this.onSave = this.onStats = this.onError = this.onStopped = this.onCrashed = () => {};
    this.onConnectionState = this.onWifiSettings = this.onWifiError = () => {};
  }

  async start(opts) {
    const progress0 = opts.onProgress || (() => {});
    progress0('게임 파일 확인 중…', 0);
    let romHash = '';
    try {
      romHash = await hashBlob(opts.rom);
    } catch (err) {
      romHash = ''; // not enough memory to hash: the file is simply uploaded as before
    }
    return this.connect(opts, romHash);
  }

  connect(opts, romHash) {
    const base = serverBaseUrl().replace(/^http/, 'ws');
    this.url = base + '/emu' + (this.password ? '?key=' + encodeURIComponent(this.password) : '');
    this.startOptions = opts;
    this.progress = opts.onProgress || (() => {});
    this.startMessage = {
      t: 'start',
      system: opts.system,
      romSize: opts.rom.size,
      romHash,
      saveSize: opts.save ? opts.save.length : 0,
      bios: !!opts.bios,
      sampleRate: opts.sampleRate,
      language: opts.language,
      datetime: opts.datetime,
      wifi: opts.wifi,
      fpsDivider: Math.max(1, Math.min(4, Number(opts.streamDivider) || 1)),
    };
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.progress('서버에 연결 중…', 0);
      this.openSocket();
    });
  }

  openSocket() {
    if (this.closedByUs) return;
    const resuming = !!this.token;
    if (!resuming) ++this.freshConnections;
    let ws;
    try {
      ws = new WebSocket(this.url, resuming ? [PROTOCOL, this.token] : PROTOCOL);
    } catch (err) {
      this.fail('서버에 연결할 수 없습니다: ' + err.message);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.openTimer = setTimeout(() => this.connectionLost(ws), OPEN_TIMEOUT);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.openTimer);
      this.lastMessage = Date.now();
      if (!resuming) {
        this.progress('서버에 연결됨', 0.05);
        this.sendJSON(this.startMessage);
      }
      this.pingTimer = setInterval(() => {
        if (!document.hidden && Date.now() - this.lastMessage > MESSAGE_TIMEOUT) this.connectionLost(ws);
        else this.sendPing();
      }, 2000);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessage = Date.now();
      if (typeof event.data !== 'string') {
        this.onBinary(event.data);
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(ws, message);
    };
    ws.onclose = () => this.connectionLost(ws);
  }

  onMessage(ws, message) {
    switch (message.t) {
      case 'session':
        if (/^[0-9a-f]{64}$/.test(message.token)) this.token = message.token;
        this.resumeMs = Math.min(60_000, Math.max(1000, Number(message.resumeMs) || 60_000));
        break;
      case 'waiting':
        this.sendJSON(this.startMessage);
        break;
      case 'loading':
        this.progress('서버에서 게임을 시작하는 중…', 0.92);
        this.waitForLoad();
        break;
      case 'upload':
        clearTimeout(this.loadTimer);
        this.retryDeadline = 0;
        this.retryDelay = 250;
        this.upload(ws, message).catch((err) => {
          if (this.ws === ws && ws.readyState === WebSocket.OPEN) this.fail('업로드 실패: ' + err.message);
        });
        break;
      case 'loaded':
        this.loaded(message);
        break;
      case 'stats':
        this.onStats({ fps: message.fps, load: message.load, ping: this.ping });
        break;
      case 'pong': {
        if (this.pendingPing?.id === message.id) {
          this.ping = performance.now() - this.pendingPing.sent;
          this.pendingPing = null;
        }
        break;
      }
      case 'wifiSettings':
        if ((this.wifi || this.startMessage?.wifi) && /^[A-Za-z0-9+/]{1024}$/.test(message.settings))
          this.onWifiSettings(message.settings);
        break;
      case 'wifiError':
        this.onWifiError(message.message);
        break;
      case 'stopped':
        this.onStopped(message.reason);
        break;
      case 'crashed':
        this.onCrashed();
        break;
      case 'error':
        this.fail(message.message || '서버 오류', message.code);
        break;
    }
  }

  loaded(info) {
    clearTimeout(this.loadTimer);
    this.connected = true;
    this.retryDeadline = 0;
    this.retryDelay = 250;
    this.haveKeyframe = false;
    if (this.started) {
      this.lastInput = '';
      for (const control of this.controls.values()) this.sendJSON(control);
      if (this.input) this.setInput(...this.input);
      this.onConnectionState(true);
      return;
    }
    this.started = true;
    this.wifi = !!(info.wifi && this.startMessage.wifi);
    this.fbBytes = info.width * info.height * info.screens * 4;
    this.frame = new Uint8ClampedArray(this.fbBytes);
    this.frame32 = new Uint32Array(this.frame.buffer);
    this.scratch = new Uint8Array(this.fbBytes);
    this.scratch32 = new Uint32Array(this.scratch.buffer);
    this.progress('게임 시작!', 1);
    this.startOptions = this.startMessage = null;
    this.resolveStart({ saveLen: info.saveLen, width: info.width, height: info.height, screens: info.screens });
  }

  connectionLost(ws) {
    if (this.ws !== ws || this.closedByUs) return;
    const wasConnected = this.connected;
    this.ws = null;
    this.connected = false;
    this.haveKeyframe = false;
    this.ping = null;
    this.clearSocketTimers();
    if (ws.readyState < WebSocket.CLOSING) ws.close(4000, 'reconnect');
    if (wasConnected) this.onConnectionState(false);
    if (!this.token && (this.started || this.freshConnections >= 3)) {
      this.fail('서버와의 연결이 끊어졌습니다.');
      return;
    }
    if (!this.retryDeadline) this.retryDeadline = Date.now() + this.resumeMs;
    const remaining = this.retryDeadline - Date.now();
    if (remaining <= 0) {
      this.fail('제한 시간 안에 서버에 다시 연결하지 못했습니다.');
      return;
    }
    if (!this.started) this.progress('서버에 다시 연결하는 중…', null);
    this.retryTimer = setTimeout(() => this.openSocket(), Math.min(remaining, this.retryDelay));
    this.retryDelay = Math.min(4000, this.retryDelay * 2);
  }

  clearSocketTimers() {
    clearTimeout(this.openTimer);
    clearTimeout(this.loadTimer);
    clearInterval(this.pingTimer);
    this.pendingPing = null;
    for (const done of this.saveWaiters.values()) done(this.latestSave);
  }

  fail(message, code) {
    if (this.closedByUs) return;
    this.stop();
    if (this.started) this.onError(message);
    else this.rejectStart(Object.assign(new Error(message), { code: code || '' }));
  }

  waitForLoad() {
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => this.fail('서버에서 게임을 시작하는 시간이 초과되었습니다.'), START_TIMEOUT);
  }

  async upload(ws, upload) {
    const opts = this.startOptions;
    const total = opts.rom.size;
    const send = async (type, part) => {
      while (ws.bufferedAmount > UPLOAD_WINDOW) {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return false;
      const packet = new Uint8Array(part.length + 1);
      packet[0] = type;
      packet.set(part, 1);
      ws.send(packet);
      return true;
    };
    if (upload.haveRom) this.progress('서버에 이미 있는 게임 파일을 사용합니다', 0.9);
    for (let offset = upload.romBytes || 0; !upload.haveRom && offset < total; offset += CHUNK) {
      const part = new Uint8Array(await opts.rom.slice(offset, offset + CHUNK).arrayBuffer());
      if (!await send(MSG_ROM_CHUNK, part)) return;
      this.progress('게임 파일을 서버로 보내는 중…', 0.05 + 0.85 * Math.min(1, (offset + part.length) / total));
    }
    for (let offset = upload.saveBytes || 0; opts.save && offset < opts.save.length; offset += CHUNK) {
      if (!await send(MSG_SAVE_CHUNK, opts.save.subarray(offset, offset + CHUNK))) return;
    }
    if (opts.bios) {
      if (!upload.haveBios9 && !await send(MSG_BIOS9, opts.bios.arm9)) return;
      if (!upload.haveBios7 && !await send(MSG_BIOS7, opts.bios.arm7)) return;
    }
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    this.progress('서버에서 게임을 시작하는 중…', 0.92);
    this.waitForLoad();
    ws.send(JSON.stringify({ t: 'go' }));
  }

  onBinary(buffer) {
    if (!this.connected || buffer.byteLength < 2) return;
    const head = new Uint8Array(buffer, 0, 2);
    const type = head[0];
    const flags = head[1];

    if (type === MSG_VIDEO) {
      if (!this.frame) return;
      let out;
      try {
        out = window.fflate.inflateSync(new Uint8Array(buffer, 2), { out: this.scratch });
      } catch (err) {
        this.requestKeyframe();
        return;
      }
      if (out.length !== this.fbBytes) {
        this.requestKeyframe();
        return;
      }
      if (flags & 1) {
        this.frame32.set(this.scratch32);
        this.haveKeyframe = true;
      } else {
        if (!this.haveKeyframe) return;
        const cur = this.frame32;
        const delta = this.scratch32;
        for (let i = 0; i < cur.length; i++) cur[i] ^= delta[i];
      }
      this.onFrame(this.frame);
    } else if (type === MSG_AUDIO) {
      // The payload starts at byte 2, which is 16-bit aligned.
      this.onAudio(new Int16Array(buffer, 2, (buffer.byteLength - 2) >> 1));
    } else if (type === MSG_SAVE) {
      const identified = (flags & 3) === 3;
      if (identified && buffer.byteLength < 6) return;
      const data = new Uint8Array(buffer, identified ? 6 : 2);
      if (flags & 1) {
        const id = identified ? new DataView(buffer).getUint32(2) : this.saveWaiters.keys().next().value;
        const done = this.saveWaiters.get(id);
        if (done) {
          if (data.length) this.latestSave = data;
          done(data);
        }
      } else {
        const previous = this.latestAutoSave;
        if (!data.length || (data.length === previous.length && data.every((byte, i) => byte === previous[i]))) return;
        this.latestSave = this.latestAutoSave = data;
        this.onSave(data);
      }
    }
  }

  sendJSON(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendPing() {
    if (this.pendingPing && performance.now() - this.pendingPing.sent < 8000) return;
    const id = ++this.pingId;
    this.pendingPing = { id, sent: performance.now() };
    this.sendJSON({ t: 'ping', id });
  }

  requestKeyframe() {
    this.haveKeyframe = false;
    this.sendJSON({ t: 'keyframe' });
  }

  setInput(keys, touching, x, y) {
    this.input = [keys, touching, x, y];
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    const key = keys + ':' + touching + ':' + x + ':' + y;
    if (key === this.lastInput) return;
    this.lastInput = key;
    this.ws.send(new Uint8Array([MSG_INPUT, keys & 0xff, (keys >> 8) & 0xff, touching ? 1 : 0, x & 0xff, y & 0xff]));
  }

  setControl(key, message) {
    this.controls.set(key, message);
    if (this.connected) this.sendJSON(message);
  }

  pause() { this.setControl('pause', { t: 'pause' }); }
  resume() { this.setControl('pause', { t: 'resume' }); }
  reset() { if (this.connected) this.sendJSON({ t: 'reset' }); }
  setLid(closed) { this.setControl('lid', { t: 'lid', closed }); }
  setStreamDivider(divider) { this.setControl('fps', { t: 'fps', divider }); }
  setSpeed(value) { this.setControl('speed', { t: 'speed', value }); }

  getSave() {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(this.latestSave);
    return new Promise((resolve) => {
      const id = this.saveId = this.saveId % 0xffffffff + 1;
      const done = (data) => {
        clearTimeout(timeout);
        this.saveWaiters.delete(id);
        resolve(data);
      };
      const timeout = setTimeout(() => done(this.latestSave), 8000);
      this.saveWaiters.set(id, done);
      this.sendJSON({ t: 'getsave', id });
    });
  }

  stop() {
    this.closedByUs = true;
    this.connected = false;
    clearTimeout(this.retryTimer);
    this.clearSocketTimers();
    if (this.ws) {
      this.sendJSON({ t: 'quit' });
      this.ws.close(1000);
      this.ws = null;
    }
    this.startOptions = this.startMessage = null;
  }
}
