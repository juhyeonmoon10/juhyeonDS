/*
 * juhyeonDS - backend that emulates inside this browser (Web Worker + WebAssembly).
 * Licensed under the GNU General Public License v3 or later.
 */

/**
 * Both backends expose the same surface:
 *   start(opts) -> Promise<{saveLen}>   opts: { rom: Blob, save: Uint8Array|null, sampleRate, language, datetime, onProgress }
 *   setInput(keys, touching, x, y), pause(), resume(), reset(), setLid(closed)
 *   getSave() -> Promise<Uint8Array>, stop()
 *   callbacks: onFrame(Uint8ClampedArray), onAudio(Int16Array), onSave(Uint8Array),
 *              onStats({fps, load, ping?}), onError(message), onStopped(reason)
 */
export class LocalBackend {
  constructor() {
    this.kind = 'local';
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.onFrame = this.onAudio = this.onSave = this.onStats = this.onError = this.onStopped = this.onCrashed = () => {};
  }

  async start(opts) {
    if (opts.onProgress) opts.onProgress('ROM 읽는 중…', null);
    const rom = await opts.rom.arrayBuffer();
    const save = opts.save ? opts.save.slice().buffer : null;

    this.worker = new Worker(new URL('./emu-worker.js', import.meta.url));
    if (opts.onProgress) opts.onProgress('에뮬레이터 시작 중…', null);

    return new Promise((resolve, reject) => {
      let started = false;
      this.worker.onerror = (e) => {
        const message = '에뮬레이터를 시작하지 못했습니다: ' + (e.message || '알 수 없는 오류');
        if (!started) reject(new Error(message));
        else this.onError(message);
      };
      this.worker.onmessage = (event) => {
        const m = event.data;
        switch (m.t) {
          case 'loaded':
            started = true;
            resolve({ saveLen: m.saveLen });
            break;
          case 'frame':
            this.onFrame(new Uint8ClampedArray(m.data));
            break;
          case 'audio':
            this.onAudio(new Int16Array(m.data));
            break;
          case 'save': {
            const data = new Uint8Array(m.data);
            if (m.requested) {
              const done = this.pending.get(m.id);
              this.pending.delete(m.id);
              if (done) done(data);
            } else {
              this.onSave(data);
            }
            break;
          }
          case 'stats':
            this.onStats({ fps: m.fps, load: m.load });
            break;
          case 'stopped':
            this.onStopped(m.reason);
            break;
          case 'crashed':
            this.onCrashed();
            break;
          case 'error':
            if (!started) reject(Object.assign(new Error(m.message), { code: m.code }));
            else this.onError(m.message);
            break;
        }
      };
      const transfer = save ? [rom, save] : [rom];
      this.worker.postMessage(
        {
          t: 'load',
          rom,
          save,
          sampleRate: opts.sampleRate,
          language: opts.language,
          datetime: opts.datetime,
          bios9: opts.bios ? opts.bios.arm9.slice().buffer : null,
          bios7: opts.bios ? opts.bios.arm7.slice().buffer : null,
        },
        transfer
      );
    });
  }

  post(msg) {
    if (this.worker) this.worker.postMessage(msg);
  }

  setInput(keys, touching, x, y) {
    this.post({ t: 'input', keys, touching, x, y });
  }
  pause() { this.post({ t: 'pause' }); }
  resume() { this.post({ t: 'resume' }); }
  reset() { this.post({ t: 'reset' }); }
  setLid(closed) { this.post({ t: 'lid', closed }); }
  setStreamDivider() {}

  getSave() {
    if (!this.worker) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.post({ t: 'getsave', id });
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(new Uint8Array(0));
      }, 5000);
    });
  }

  stop() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const done of this.pending.values()) done(new Uint8Array(0));
    this.pending.clear();
  }
}
