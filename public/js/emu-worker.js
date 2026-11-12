/*
 * juhyeonDS - browser worker that runs the WebAssembly core off the main thread.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

importScripts('systems.js', 'emu-runner.js');

let runner = null;

function fail(err) {
  postMessage({ t: 'error', message: String((err && err.message) || err), code: (err && err.code) || '' });
}

/** Downloads the core, reporting progress, so the loading screen can show a percentage. */
async function fetchCore(core) {
  // The uncompressed size is only used to estimate progress when the host compresses the
  // download and the real size is not known in advance.
  const APPROX_WASM_BYTES = core.wasmBytes;
  const url = new URL('../core/' + core.file + '.wasm', self.location.href).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error('에뮬레이터 파일을 내려받지 못했습니다 (' + res.status + ')');
  if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());

  const length = Number(res.headers.get('Content-Length')) || 0;
  const total = !length || res.headers.get('Content-Encoding') ? APPROX_WASM_BYTES : length;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    postMessage({ t: 'progress', stage: 'core', fraction: Math.min(1, received / total) });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function load(msg) {
  const system = EmuSystems.get(msg.system) || EmuSystems.get('nds');
  const core = EmuSystems.CORES[system.core];
  if (typeof self[core.factory] !== 'function') importScripts('../core/' + core.file + '.js');
  const wasmBinary = await fetchCore(core);
  postMessage({ t: 'progress', stage: 'init' });
  const M = await self[core.factory]({
    wasmBinary,
    locateFile: (file) => new URL('../core/' + file, self.location.href).href,
    print: (text) => console.log('[core]', text),
    printErr: (text) => console.warn('[core]', text),
  });

  runner = new EmuRunner(M, {
    onFrame(view) {
      const copy = new Uint8ClampedArray(view.length);
      copy.set(view);
      postMessage({ t: 'frame', data: copy.buffer }, [copy.buffer]);
    },
    onAudio(view) {
      const copy = new Int16Array(view.length);
      copy.set(view);
      postMessage({ t: 'audio', data: copy.buffer }, [copy.buffer]);
    },
    onSave(data) {
      postMessage({ t: 'save', requested: false, data: data.buffer }, [data.buffer]);
    },
    onStats(stats) {
      postMessage({ t: 'stats', fps: stats.fps, load: stats.load });
    },
    onStop(reason) {
      postMessage({ t: 'stopped', reason });
    },
    onCrash() {
      postMessage({ t: 'crashed' });
    },
  }, system);

  postMessage({ t: 'progress', stage: 'game' });
  runner.setFrameLimit(msg.fpsDivider || 1);
  const info = runner.load(new Uint8Array(msg.rom), msg.save ? new Uint8Array(msg.save) : null, {
    sampleRate: msg.sampleRate,
    language: msg.language,
    datetime: msg.datetime,
    bios9: msg.bios9 ? new Uint8Array(msg.bios9) : null,
    bios7: msg.bios7 ? new Uint8Array(msg.bios7) : null,
  });
  postMessage({ t: 'loaded', saveLen: info.saveLen, width: info.width, height: info.height, screens: info.screens });
  runner.start();
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.t) {
      case 'load':
        load(msg).catch(fail);
        break;
      case 'input':
        if (runner) runner.setInput(msg.keys, msg.touching, msg.x, msg.y);
        break;
      case 'pause':
        if (runner) runner.pause();
        break;
      case 'resume':
        if (runner) runner.start();
        break;
      case 'reset':
        if (runner) runner.reset();
        break;
      case 'lid':
        if (runner) runner.setLid(msg.closed);
        break;
      case 'speed':
        if (runner) runner.setSpeed(msg.value);
        break;
      case 'fps':
        if (runner) runner.setFrameLimit(msg.divider);
        break;
      case 'getsave': {
        const data = runner ? runner.getSave() : new Uint8Array(0);
        postMessage({ t: 'save', requested: true, id: msg.id, data: data.buffer }, [data.buffer]);
        break;
      }
    }
  } catch (err) {
    fail(err);
  }
};
