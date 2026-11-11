/*
 * juhyeonDS - backend that emulates on the server and streams video/audio over WebSocket.
 * Licensed under the GNU General Public License v3 or later.
 */

const FB_BYTES = 256 * 192 * 2 * 4;
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
export async function probeServer() {
  if (location.protocol === 'file:' && !(window.MELONDS_CONFIG && window.MELONDS_CONFIG.serverUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(serverBaseUrl() + '/api/info', { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    return info && info.name === 'juhyeonds' ? info : null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class RemoteBackend {
  constructor(password) {
    this.kind = 'server';
    this.password = password || '';
    this.ws = null;
    this.closedByUs = false;
    this.started = false;
    this.frame = new Uint8ClampedArray(FB_BYTES);
    this.frame32 = new Uint32Array(this.frame.buffer);
    this.scratch = new Uint8Array(FB_BYTES);
    this.scratch32 = new Uint32Array(this.scratch.buffer);
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

  start(opts) {
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

      progress('서버에 연결 중…', null);
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
        ws.send(
          JSON.stringify({
            t: 'start',
            romSize: opts.rom.size,
            saveSize: opts.save ? opts.save.length : 0,
            bios: !!opts.bios,
            sampleRate: opts.sampleRate,
            language: opts.language,
            datetime: opts.datetime,
            fpsDivider: opts.streamDivider === 2 ? 2 : 1,
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
            this.upload(opts, progress).catch((err) => failStart('업로드 실패: ' + err.message));
            break;
          case 'loaded':
            settled = true;
            this.started = true;
            this.pingTimer = setInterval(() => this.sendPing(), 2000);
            resolve({ saveLen: m.saveLen });
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

  async upload(opts, progress) {
    const ws = this.ws;
    const total = opts.rom.size;
    for (let offset = 0; offset < total; offset += CHUNK) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('연결이 끊어졌습니다');
      const part = new Uint8Array(await opts.rom.slice(offset, offset + CHUNK).arrayBuffer());
      const msg = new Uint8Array(part.length + 1);
      msg[0] = MSG_ROM_CHUNK;
      msg.set(part, 1);
      ws.send(msg);
      progress('ROM을 서버로 보내는 중…', Math.min(1, (offset + part.length) / total));
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
    progress('서버에서 게임을 시작하는 중…', null);
    ws.send(JSON.stringify({ t: 'go' }));
  }

  onBinary(buffer) {
    const head = new Uint8Array(buffer, 0, 2);
    const type = head[0];
    const flags = head[1];

    if (type === MSG_VIDEO) {
      let out;
      try {
        out = window.fflate.inflateSync(new Uint8Array(buffer, 2), { out: this.scratch });
      } catch (err) {
        this.requestKeyframe();
        return;
      }
      if (out.length !== FB_BYTES) {
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
