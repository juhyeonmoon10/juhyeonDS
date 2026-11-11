/*
 * melonDS Web - keyboard, gamepad, on-screen pad and touch-screen input.
 * Licensed under the GNU General Public License v3 or later.
 */

export const KEY = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  RIGHT: 1 << 4,
  LEFT: 1 << 5,
  UP: 1 << 6,
  DOWN: 1 << 7,
  R: 1 << 8,
  L: 1 << 9,
  X: 1 << 10,
  Y: 1 << 11,
};

const KEYBOARD = {
  ArrowUp: KEY.UP,
  ArrowDown: KEY.DOWN,
  ArrowLeft: KEY.LEFT,
  ArrowRight: KEY.RIGHT,
  KeyX: KEY.A,
  KeyZ: KEY.B,
  KeyS: KEY.X,
  KeyA: KEY.Y,
  KeyQ: KEY.L,
  KeyW: KEY.R,
  Enter: KEY.START,
  NumpadEnter: KEY.START,
  ShiftLeft: KEY.SELECT,
  ShiftRight: KEY.SELECT,
  Backspace: KEY.SELECT,
};

// "Standard" gamepad layout: the bottom face button is DS B, the right one is DS A.
const GAMEPAD_BUTTONS = [
  [0, KEY.B],
  [1, KEY.A],
  [2, KEY.Y],
  [3, KEY.X],
  [4, KEY.L],
  [5, KEY.R],
  [8, KEY.SELECT],
  [9, KEY.START],
  [12, KEY.UP],
  [13, KEY.DOWN],
  [14, KEY.LEFT],
  [15, KEY.RIGHT],
];

const TOUCH_MIN_HOLD_MS = 50; // a tap must span at least a couple of emulated frames

export class Input {
  /**
   * @param opts { bottomCanvas, vpad, onChange(keys, touching, x, y), isBlocked() }
   */
  constructor(opts) {
    this.bottom = opts.bottomCanvas;
    this.vpad = opts.vpad;
    this.onChange = opts.onChange;
    this.isBlocked = opts.isBlocked || (() => false);

    this.kb = 0;
    this.gp = 0;
    this.vp = 0;
    this.vpPointers = new Map(); // pointerId -> bits
    this.touch = { down: false, x: 0, y: 0, pointerId: null, downAt: 0, releaseAt: 0 };
    this.last = '';
    this.raf = 0;
    this.active = false;
    this.gamepadName = '';

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._loop = this._loop.bind(this);
    this._padDown = this._padDown.bind(this);
    this._padMove = this._padMove.bind(this);
    this._padUp = this._padUp.bind(this);
    this._touchDown = this._touchDown.bind(this);
    this._touchMove = this._touchMove.bind(this);
    this._touchUp = this._touchUp.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    this.vpad.addEventListener('pointerdown', this._padDown);
    this.vpad.addEventListener('pointermove', this._padMove);
    this.vpad.addEventListener('pointerup', this._padUp);
    this.vpad.addEventListener('pointercancel', this._padUp);
    this.vpad.addEventListener('contextmenu', (e) => e.preventDefault());

    this.bottom.addEventListener('pointerdown', this._touchDown);
    this.bottom.addEventListener('pointermove', this._touchMove);
    this.bottom.addEventListener('pointerup', this._touchUp);
    this.bottom.addEventListener('pointercancel', this._touchUp);
    this.bottom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  start() {
    this.active = true;
    this.clear();
    if (!this.raf) this.raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clear();
  }

  clear() {
    this.kb = 0;
    this.gp = 0;
    this.vp = 0;
    this.vpPointers.clear();
    this.touch.down = false;
    this.touch.pointerId = null;
    this.touch.releaseAt = 0;
    this._paintPad();
    this.last = '';
  }

  // ------------------------------------------------------------ keyboard
  _onKeyDown(e) {
    if (!this.active || this.isBlocked()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const bit = KEYBOARD[e.code];
    if (!bit) return;
    e.preventDefault();
    this.kb |= bit;
    this._emit();
  }

  _onKeyUp(e) {
    const bit = KEYBOARD[e.code];
    if (!bit) return;
    this.kb &= ~bit;
    if (this.active) this._emit();
  }

  _onBlur() {
    this.kb = 0;
    if (this.active) this._emit();
  }

  // ------------------------------------------------------------ gamepad
  _pollGamepads() {
    let bits = 0;
    let name = '';
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      name = name || pad.id;
      for (const [index, bit] of GAMEPAD_BUTTONS) {
        const button = pad.buttons[index];
        if (button && (button.pressed || button.value > 0.5)) bits |= bit;
      }
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      if (ax < -0.5) bits |= KEY.LEFT;
      if (ax > 0.5) bits |= KEY.RIGHT;
      if (ay < -0.5) bits |= KEY.UP;
      if (ay > 0.5) bits |= KEY.DOWN;
    }
    this.gamepadName = name;
    this.gp = bits;
  }

  // ------------------------------------------------------------ on-screen pad
  _bitsAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !this.vpad.contains(el)) return 0;
    const dpad = el.closest('#dpad');
    if (dpad) {
      const rect = dpad.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const dead = rect.width * 0.11;
      if (Math.hypot(dx, dy) < dead) return 0;
      // Eight directions: each cardinal owns a 135 degree arc so diagonals are easy to hit.
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      let bits = 0;
      if (angle > -67.5 && angle < 67.5) bits |= KEY.RIGHT;
      if (angle > 22.5 && angle < 157.5) bits |= KEY.DOWN;
      if (angle > 112.5 || angle < -112.5) bits |= KEY.LEFT;
      if (angle > -157.5 && angle < -22.5) bits |= KEY.UP;
      return bits;
    }
    const button = el.closest('[data-k]');
    return button ? KEY[button.dataset.k] || 0 : 0;
  }

  _padDown(e) {
    if (!this.active) return;
    e.preventDefault();
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (err) {
      /* not capturable */
    }
    const bits = this._bitsAt(e.clientX, e.clientY);
    this.vpPointers.set(e.pointerId, bits);
    if (bits && navigator.vibrate) navigator.vibrate(8);
    this._recomputePad();
  }

  _padMove(e) {
    if (!this.vpPointers.has(e.pointerId)) return;
    e.preventDefault();
    const bits = this._bitsAt(e.clientX, e.clientY);
    if (bits !== this.vpPointers.get(e.pointerId)) {
      this.vpPointers.set(e.pointerId, bits);
      this._recomputePad();
    }
  }

  _padUp(e) {
    if (!this.vpPointers.has(e.pointerId)) return;
    this.vpPointers.delete(e.pointerId);
    this._recomputePad();
  }

  _recomputePad() {
    let bits = 0;
    for (const b of this.vpPointers.values()) bits |= b;
    this.vp = bits;
    this._paintPad();
    this._emit();
  }

  _paintPad() {
    const bits = this.vp;
    for (const el of this.vpad.querySelectorAll('[data-k]')) {
      el.classList.toggle('on', (bits & KEY[el.dataset.k]) !== 0);
    }
    const dpad = this.vpad.querySelector('#dpad');
    if (dpad) {
      dpad.querySelector('.up').classList.toggle('on', (bits & KEY.UP) !== 0);
      dpad.querySelector('.down').classList.toggle('on', (bits & KEY.DOWN) !== 0);
      dpad.querySelector('.left').classList.toggle('on', (bits & KEY.LEFT) !== 0);
      dpad.querySelector('.right').classList.toggle('on', (bits & KEY.RIGHT) !== 0);
    }
  }

  // ------------------------------------------------------------ touch screen
  _touchPoint(e) {
    const rect = this.bottom.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * 256);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * 192);
    this.touch.x = Math.max(0, Math.min(255, x));
    this.touch.y = Math.max(0, Math.min(191, y));
  }

  _touchDown(e) {
    if (!this.active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.touch.pointerId !== null && this.touch.down) return; // DS screen is single-touch
    e.preventDefault();
    try {
      this.bottom.setPointerCapture(e.pointerId);
    } catch (err) {
      /* not capturable */
    }
    this.touch.pointerId = e.pointerId;
    this.touch.down = true;
    this.touch.downAt = performance.now();
    this.touch.releaseAt = 0;
    this._touchPoint(e);
    this._emit();
  }

  _touchMove(e) {
    if (e.pointerId !== this.touch.pointerId || !this.touch.down || this.touch.releaseAt) return;
    e.preventDefault();
    this._touchPoint(e);
    this._emit();
  }

  _touchUp(e) {
    if (e.pointerId !== this.touch.pointerId) return;
    this.touch.pointerId = null;
    const earliest = this.touch.downAt + TOUCH_MIN_HOLD_MS;
    if (performance.now() >= earliest) {
      this.touch.down = false;
      this._emit();
    } else {
      this.touch.releaseAt = earliest; // released by the frame loop
    }
  }

  // ------------------------------------------------------------ output
  _loop() {
    this.raf = requestAnimationFrame(this._loop);
    if (!this.active) return;
    this._pollGamepads();
    if (this.touch.releaseAt && performance.now() >= this.touch.releaseAt) {
      this.touch.releaseAt = 0;
      this.touch.down = false;
    }
    this._emit();
  }

  _emit() {
    const keys = this.isBlocked() ? 0 : this.kb | this.gp | this.vp;
    const touching = this.touch.down && !this.isBlocked() ? 1 : 0;
    const signature = keys + ':' + touching + ':' + this.touch.x + ':' + this.touch.y;
    if (signature === this.last) return;
    this.last = signature;
    this.onChange(keys, touching, this.touch.x, this.touch.y);
  }
}
