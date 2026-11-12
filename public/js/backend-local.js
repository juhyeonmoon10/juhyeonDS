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
/** Reads a Blob into an ArrayBuffer, reporting progress as a 0..1 fraction. */
async function readBlob(blob, onProgress) {
  if (!blob.stream) return blob.arrayBuffer();
  const out = new Uint8Array(blob.size);
  const reader = blob.stream().getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, offset);
    offset += value.length;
    onProgress(blob.size ? offset / blob.size : 1);
  }
  return out.buffer;
}

export class LocalBackend {
  constructor() {
    this.kind = 'local';
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.onFrame = this.onAudio = this.onSave = this.onStats = this.onError = this.onStopped = this.onCrashed = () => {};
  }

  async start(opts) {
    // Overall progress: reading the ROM 0-35%, downloading the core 35-75%,
    // starting the core 75-85%, loading the game into it 85-100%.
    const progress = opts.onProgress || (() => {});
    progress('게임 파일 읽는 중…', 0);
    const rom = await readBlob(opts.rom, (f) => progress('게임 파일 읽는 중…', f * 0.35));
    const save = opts.save ? opts.save.slice().buffer : null;

    this.worker = new Worker(new URL('./emu-worker.js', import.meta.url));
    progress('에뮬레이터 내려받는 중…', 0.35);

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
          case 'progress':
            if (m.stage === 'core') progress('에뮬레이터 내려받는 중…', 0.35 + m.fraction * 0.4);
            else if (m.stage === 'init') progress('에뮬레이터 준비 중…', 0.75);
            else if (m.stage === 'game') progress('게임 불러오는 중…', 0.85);
            break;
          case 'loaded':
            started = true;
            progress('게임 시작!', 1);
            resolve({ saveLen: m.saveLen, width: m.width, height: m.height, screens: m.screens });
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
          system: opts.system,
          rom,
          save,
          sampleRate: opts.sampleRate,
          language: opts.language,
          datetime: opts.datetime,
          bios9: opts.bios ? opts.bios.arm9.slice().buffer : null,
          bios7: opts.bios ? opts.bios.arm7.slice().buffer : null,
          fpsDivider: opts.streamDivider,
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
  setSpeed(value) { this.post({ t: 'speed', value }); }
  setStreamDivider(divider) { this.post({ t: 'fps', divider }); }

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
