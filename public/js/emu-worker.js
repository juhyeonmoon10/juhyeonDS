/*
 * juhyeonDS - browser worker that runs the WebAssembly core off the main thread.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

importScripts('../core/melonds.js', 'emu-runner.js');

let runner = null;

function fail(err) {
  postMessage({ t: 'error', message: String((err && err.message) || err), code: (err && err.code) || '' });
}

async function load(msg) {
  const M = await createMelonDS({
    locateFile: (file) => new URL('../core/' + file, self.location.href).href,
    print: (text) => console.log('[melonDS]', text),
    printErr: (text) => console.warn('[melonDS]', text),
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
  });

  const info = runner.load(new Uint8Array(msg.rom), msg.save ? new Uint8Array(msg.save) : null, {
    sampleRate: msg.sampleRate,
    language: msg.language,
    datetime: msg.datetime,
    bios9: msg.bios9 ? new Uint8Array(msg.bios9) : null,
    bios7: msg.bios7 ? new Uint8Array(msg.bios7) : null,
  });
  postMessage({ t: 'loaded', saveLen: info.saveLen });
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
