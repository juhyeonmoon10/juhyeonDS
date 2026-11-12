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
    this.fbBytes = 0; // set once the server reports the picture size
    this.frame = null;
    this.frame32 = null;
    this.scratch = null;
    this.scratch32 = null;
    this.haveKeyframe = false;
    this.saveWaiters = [];
    this.lastInput = '';
    this.ping = null;
    this.pingTimer = null;
    this.pingSent = new Map();
    this.pingId = 0;
    this.lastStats = { fps: 0, load: 0 };
    this.onFrame = this.onAudio = this.onSave = this.onStats = this.onError = this.onStopped = this.onCrashed = () => {};
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
    const url = base + '/emu' + (this.password ? '?key=' + encodeURIComponent(this.password) : '');
    const progress = opts.onProgress || (() => {});

    return new Promise((resolve, reject) => {
      let settled = false;
      const failStart = (message, code) => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(Object.assign(new Error(message), { code: code || '' }));
      };

      progress('서버에 연결 중…', 0);
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new Error('서버에 연결할 수 없습니다: ' + err.message));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        progress('서버에 연결됨', 0.05);
        ws.send(
          JSON.stringify({
            t: 'start',
            system: opts.system,
            romSize: opts.rom.size,
            romHash,
            saveSize: opts.save ? opts.save.length : 0,
            bios: !!opts.bios,
            sampleRate: opts.sampleRate,
            language: opts.language,
            datetime: opts.datetime,
            fpsDivider: Math.max(1, Math.min(4, Number(opts.streamDivider) || 1)),
          })
        );
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          this.onBinary(event.data);
          return;
        }
        let m;
        try {
          m = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        switch (m.t) {
          case 'upload':
            this.upload(opts, progress, !!m.haveRom).catch((err) => failStart('업로드 실패: ' + err.message));
            break;
          case 'loaded':
            progress('게임 시작!', 1);
            settled = true;
            this.started = true;
            this.fbBytes = m.width * m.height * m.screens * 4;
            this.frame = new Uint8ClampedArray(this.fbBytes);
            this.frame32 = new Uint32Array(this.frame.buffer);
            this.scratch = new Uint8Array(this.fbBytes);
            this.scratch32 = new Uint32Array(this.scratch.buffer);
            this.pingTimer = setInterval(() => this.sendPing(), 2000);
            resolve({ saveLen: m.saveLen, width: m.width, height: m.height, screens: m.screens });
            break;
          case 'stats':
            this.lastStats = { fps: m.fps, load: m.load };
            this.onStats({ fps: m.fps, load: m.load, ping: this.ping });
            break;
          case 'pong': {
            const sent = this.pingSent.get(m.id);
            this.pingSent.delete(m.id);
            if (sent) this.ping = performance.now() - sent;
            break;
          }
          case 'stopped':
            this.onStopped(m.reason);
            break;
          case 'crashed':
            this.onCrashed();
            break;
          case 'error':
            if (!settled) failStart(m.message || '서버 오류', m.code);
            else this.onError(m.message || '서버 오류');
            break;
        }
      };

      ws.onerror = () => {
        if (!settled) failStart('서버에 연결할 수 없습니다.');
      };
      ws.onclose = () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        for (const done of this.saveWaiters.splice(0)) done(new Uint8Array(0));
        if (!settled) failStart('서버가 연결을 닫았습니다.');
        else if (!this.closedByUs) this.onError('서버와의 연결이 끊어졌습니다.');
      };
    });
  }

  async upload(opts, progress, haveRom) {
    const ws = this.ws;
    const total = opts.rom.size;
    if (haveRom) progress('서버에 이미 있는 게임 파일을 사용합니다', 0.9);
    for (let offset = 0; !haveRom && offset < total; offset += CHUNK) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('연결이 끊어졌습니다');
      const part = new Uint8Array(await opts.rom.slice(offset, offset + CHUNK).arrayBuffer());
      const msg = new Uint8Array(part.length + 1);
      msg[0] = MSG_ROM_CHUNK;
      msg.set(part, 1);
      ws.send(msg);
      progress('게임 파일을 서버로 보내는 중…', 0.05 + 0.85 * Math.min(1, (offset + part.length) / total));
      while (ws.bufferedAmount > UPLOAD_WINDOW) {
        await new Promise((r) => setTimeout(r, 20));
        if (ws.readyState !== WebSocket.OPEN) throw new Error('연결이 끊어졌습니다');
      }
    }
    if (opts.save && opts.save.length) {
      for (let offset = 0; offset < opts.save.length; offset += CHUNK) {
        const part = opts.save.subarray(offset, offset + CHUNK);
        const msg = new Uint8Array(part.length + 1);
        msg[0] = MSG_SAVE_CHUNK;
        msg.set(part, 1);
        ws.send(msg);
      }
    }
    if (opts.bios) {
      for (const [type, data] of [[MSG_BIOS9, opts.bios.arm9], [MSG_BIOS7, opts.bios.arm7]]) {
        const msg = new Uint8Array(data.length + 1);
        msg[0] = type;
        msg.set(data, 1);
        ws.send(msg);
      }
    }
    progress('서버에서 게임을 시작하는 중…', 0.92);
    ws.send(JSON.stringify({ t: 'go' }));
  }

  onBinary(buffer) {
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
      const data = new Uint8Array(buffer.slice(2));
      if (flags & 1) {
        const done = this.saveWaiters.shift();
        if (done) done(data);
      } else {
        this.onSave(data);
      }
    }
  }

  sendJSON(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendPing() {
    const id = ++this.pingId;
    this.pingSent.set(id, performance.now());
    if (this.pingSent.size > 8) this.pingSent.clear();
    this.sendJSON({ t: 'ping', id });
  }

  requestKeyframe() {
    this.haveKeyframe = false;
    this.sendJSON({ t: 'keyframe' });
  }

  setInput(keys, touching, x, y) {
    if (!this.started || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const key = keys + ':' + touching + ':' + x + ':' + y;
    if (key === this.lastInput) return;
    this.lastInput = key;
    this.ws.send(new Uint8Array([MSG_INPUT, keys & 0xff, (keys >> 8) & 0xff, touching ? 1 : 0, x & 0xff, y & 0xff]));
  }

  pause() { this.sendJSON({ t: 'pause' }); }
  resume() { this.sendJSON({ t: 'resume' }); }
  reset() { this.sendJSON({ t: 'reset' }); }
  setLid(closed) { this.sendJSON({ t: 'lid', closed }); }
  setStreamDivider(divider) { this.sendJSON({ t: 'fps', divider }); }
  setSpeed(value) { this.sendJSON({ t: 'speed', value }); }

  getSave() {
    if (!this.started || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve) => {
      this.saveWaiters.push(resolve);
      this.sendJSON({ t: 'getsave' });
      setTimeout(() => {
        const i = this.saveWaiters.indexOf(resolve);
        if (i >= 0) {
          this.saveWaiters.splice(i, 1);
          resolve(new Uint8Array(0));
        }
      }, 8000);
    });
  }

  stop() {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        /* already closed */
      }
      this.ws = null;
    }
  }
}
