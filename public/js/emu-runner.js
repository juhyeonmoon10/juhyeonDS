/*
 * juhyeonDS - emulation loop shared by the browser worker and the Node server session.
 * Licensed under the GNU General Public License v3 or later.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmuRunner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCREEN_W = 256;
  var SCREEN_H = 192;
  var FB_BYTES = SCREEN_W * SCREEN_H * 2 * 4;
  var FRAME_MS = 1000 / 59.8261;
  var SAVE_SETTLE_MS = 400; // wait for a burst of save writes to finish before reporting
  var MAX_CATCH_UP = 3;

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * @param M   Instantiated Emscripten module (createMelonDS()).
   * @param cb  { onFrame(Uint8Array view), onAudio(Int16Array view, frames),
   *              onSave(Uint8Array copy), onStats({fps, load}), onStop(reason) }
   *            Views point into wasm memory and are only valid during the callback.
   */
  function EmuRunner(M, cb) {
    this.M = M;
    this.cb = cb || {};
    this.loaded = false;
    this.running = false;
    this.keys = 0;
    this.touching = 0;
    this.tx = 0;
    this.ty = 0;
    this.next = 0;
    this.timer = null;
    this.saveDirtyAt = 0;
    this.statFrames = 0;
    this.statBusy = 0;
    this.statSince = 0;
    this._tick = this._tick.bind(this);
  }

  EmuRunner.SCREEN_W = SCREEN_W;
  EmuRunner.SCREEN_H = SCREEN_H;
  EmuRunner.FB_BYTES = FB_BYTES;
  EmuRunner.FRAME_MS = FRAME_MS;

  EmuRunner.prototype.load = function (rom, save, opts) {
    var M = this.M;
    opts = opts || {};
    this.pause();

    var romPtr = M._mds_alloc(rom.length);
    if (!romPtr) throw new Error('메모리가 부족합니다 (ROM ' + rom.length + ' bytes)');
    M.HEAPU8.set(rom, romPtr);

    var savePtr = 0;
    var saveLen = 0;
    if (save && save.length) {
      saveLen = save.length;
      savePtr = M._mds_alloc(saveLen);
      if (!savePtr) {
        M._mds_free(romPtr);
        throw new Error('메모리가 부족합니다 (세이브)');
      }
      M.HEAPU8.set(save, savePtr);
    }

    // Optional console BIOS images (both required together).
    var b9 = opts.bios9, b7 = opts.bios7;
    if (b9 && b7 && b9.length === 0x1000 && b7.length === 0x4000) {
      var p9 = M._mds_alloc(b9.length), p7 = M._mds_alloc(b7.length);
      M.HEAPU8.set(b9, p9);
      M.HEAPU8.set(b7, p7);
      M._mds_set_bios(p9, p7);
      M._mds_free(p9);
      M._mds_free(p7);
    } else {
      M._mds_set_bios(0, 0);
    }

    M._mds_config(opts.sampleRate || 48000, opts.language == null ? 1 : opts.language);
    var d = opts.datetime || [2026, 1, 1, 12, 0, 0];
    M._mds_set_datetime(d[0], d[1], d[2], d[3], d[4], d[5]);

    // mds_load takes ownership of the ROM buffer and copies the save.
    var result = M._mds_load(romPtr, rom.length, savePtr, saveLen);
    if (savePtr) M._mds_free(savePtr);
    if (result === -1 || result === -3) throw new Error('올바른 NDS ROM 파일이 아닙니다. 파일이 손상되었거나 다른 형식일 수 있습니다.');
    if (result === -4) {
      var err = new Error('이 ROM은 암호화된 덤프라서 내장 BIOS로는 실행할 수 없습니다. 복호화된(decrypted) 덤프를 사용하거나, 설정에서 본인 DS의 BIOS 파일(bios9.bin, bios7.bin)을 등록해 주세요.');
      err.code = 'encrypted';
      throw err;
    }
    if (result !== 0) throw new Error('ROM을 불러올 수 없습니다 (코드 ' + result + ')');

    this.loaded = true;
    this.saveDirtyAt = 0;
    this.crashReported = false;
    return { saveLen: M._mds_save_len() };
  };

  EmuRunner.prototype.setInput = function (keys, touching, tx, ty) {
    this.keys = keys & 0xfff;
    this.touching = touching ? 1 : 0;
    this.tx = tx | 0;
    this.ty = ty | 0;
  };

  EmuRunner.prototype.start = function () {
    if (!this.loaded || this.running) return;
    this.running = true;
    this.next = now();
    this.statSince = this.next;
    this.statFrames = 0;
    this.statBusy = 0;
    this._tick();
  };

  EmuRunner.prototype.pause = function () {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._flushSave(true);
  };

  EmuRunner.prototype.reset = function () {
    if (!this.loaded) return;
    this.crashReported = false;
    this.M._mds_reset();
  };

  EmuRunner.prototype.setLid = function (closed) {
    if (this.loaded) this.M._mds_set_lid(closed ? 1 : 0);
  };

  EmuRunner.prototype.getSave = function () {
    var M = this.M;
    if (!this.loaded) return new Uint8Array(0);
    var len = M._mds_save_len();
    var ptr = M._mds_save_ptr();
    if (!len || !ptr) return new Uint8Array(0);
    return M.HEAPU8.slice(ptr, ptr + len);
  };

  EmuRunner.prototype.unload = function () {
    this.pause();
    if (this.loaded) this.M._mds_unload();
    this.loaded = false;
  };

  EmuRunner.prototype._flushSave = function (force) {
    if (!this.saveDirtyAt) return;
    if (!force && now() - this.saveDirtyAt < SAVE_SETTLE_MS) return;
    this.saveDirtyAt = 0;
    if (this.cb.onSave) this.cb.onSave(this.getSave());
  };

  EmuRunner.prototype._runFrame = function () {
    var M = this.M;
    var t0 = now();
    var n = M._mds_run_frame(this.keys, this.touching, this.tx, this.ty);
    if (n < 0) {
      var reason = M._mds_stop_reason();
      this.pause();
      if (this.cb.onStop) this.cb.onStop(reason);
      return false;
    }

    if (this.cb.onFrame) {
      var fb = M._mds_framebuffer();
      this.cb.onFrame(M.HEAPU8.subarray(fb, fb + FB_BYTES));
    }
    if (n > 0 && this.cb.onAudio) {
      var ap = M._mds_audio() >> 1;
      this.cb.onAudio(M.HEAP16.subarray(ap, ap + n * 2), n);
    }

    var t1 = now();
    if (M._mds_save_dirty()) this.saveDirtyAt = t1;
    this._flushSave(false);

    this.statFrames++;
    this.statBusy += t1 - t0;
    if (t1 - this.statSince >= 1000) {
      // Games never execute undefined instructions on purpose. Once one has happened the
      // game has crashed (typically hanging on a white screen); it is not loading.
      if (!this.crashReported && M._mds_fault_count() > 0) {
        this.crashReported = true;
        if (this.cb.onCrash) this.cb.onCrash();
      }
      var span = t1 - this.statSince;
      if (this.cb.onStats) {
        this.cb.onStats({
          fps: (this.statFrames * 1000) / span,
          load: this.statBusy / span,
        });
      }
      this.statSince = t1;
      this.statFrames = 0;
      this.statBusy = 0;
    }
    return true;
  };

  EmuRunner.prototype._tick = function () {
    this.timer = null;
    if (!this.running) return;

    var t = now();
    if (t - this.next > 250) this.next = t; // fell far behind (slow device, suspended tab): resync

    var ran = 0;
    while (this.running && t >= this.next && ran < MAX_CATCH_UP) {
      if (!this._runFrame()) return;
      this.next += FRAME_MS;
      ran++;
      t = now();
    }
    if (!this.running) return;
    this.timer = setTimeout(this._tick, Math.max(0, this.next - now()));
  };

  return EmuRunner;
});
