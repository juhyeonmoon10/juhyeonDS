/*
 * juhyeonDS - the consoles this build can emulate, shared by the page, the browser worker
 * and the Node server.
 * Licensed under the GNU General Public License v3 or later.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmuSystems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CORES = {
    // file name under core/, factory function it defines, approximate uncompressed wasm size
    melonds: { file: 'melonds', factory: 'createMelonDS', wasmBytes: 1310000 },
    mgba: { file: 'mgba', factory: 'createMGBA', wasmBytes: 750000 },
  };

  var SYSTEMS = {
    nds: { id: 'nds', label: 'Nintendo DS', core: 'melonds', width: 256, height: 192, screens: 2, fps: 59.8261, touch: true, xy: true, exts: ['nds', 'srl', 'dsi', 'ids'] },
    gba: { id: 'gba', label: 'Game Boy Advance', core: 'mgba', width: 240, height: 160, screens: 1, fps: 59.7275, touch: false, xy: false, exts: ['gba', 'agb'] },
    gb: { id: 'gb', label: 'Game Boy / Color', core: 'mgba', width: 160, height: 144, screens: 1, fps: 59.7275, touch: false, xy: false, exts: ['gb', 'gbc'] },
  };

  var ALL_EXTS = [];
  Object.keys(SYSTEMS).forEach(function (id) {
    ALL_EXTS = ALL_EXTS.concat(SYSTEMS[id].exts);
  });

  /** @returns the system for a file name, or null when the extension is not a known ROM type. */
  function forFileName(name) {
    var match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    if (!match) return null;
    var ext = match[1].toLowerCase();
    for (var id in SYSTEMS) {
      if (SYSTEMS[id].exts.indexOf(ext) >= 0) return SYSTEMS[id];
    }
    return null;
  }

  return {
    SYSTEMS: SYSTEMS,
    CORES: CORES,
    ROM_EXTS: ALL_EXTS,
    ROM_PATTERN: new RegExp('\\.(' + ALL_EXTS.join('|') + ')$', 'i'),
    forFileName: forFileName,
    get: function (id) {
      return SYSTEMS[id] || null;
    },
  };
});
