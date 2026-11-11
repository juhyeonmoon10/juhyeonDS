/*
 * melonDS Web - audio output.
 * Uses an AudioWorklet where available; falls back to ScriptProcessorNode on pages that are
 * not a secure context (plain http:// on a LAN address), where worklets do not exist.
 * Licensed under the GNU General Public License v3 or later.
 */

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.node = null;
    this.mode = 'none';
    this.volume = 1;
    this.workletLoaded = false;
    // fallback ring buffer
    this.ring = null;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  /** Must be called from a user gesture (the "start" click). */
  async init(targetSeconds) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!this.ctx) {
      try {
        this.ctx = new Ctx({ latencyHint: 'interactive' });
      } catch (err) {
        this.ctx = new Ctx();
      }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        /* will retry on the next gesture */
      }
    }

    this.disconnectNode();
    if (this.ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        if (!this.workletLoaded) {
          await this.ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
          this.workletLoaded = true;
        }
        this.node = new AudioWorkletNode(this.ctx, 'melon-audio', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { targetSeconds },
        });
        this.node.connect(this.gain);
        this.mode = 'worklet';
        return true;
      } catch (err) {
        console.warn('AudioWorklet을 사용할 수 없어 대체 방식을 씁니다.', err);
      }
    }
    this.initFallback(targetSeconds);
    return true;
  }

  initFallback(targetSeconds) {
    const rate = this.ctx.sampleRate;
    const cap = Math.round(rate);
    const ring = {
      left: new Float32Array(cap),
      right: new Float32Array(cap),
      cap,
      w: 0,
      r: 0,
      fill: 0,
      target: Math.round(rate * Math.max(targetSeconds, 0.1)),
      buffering: true,
    };
    this.ring = ring;
    const node = this.ctx.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = (event) => {
      const outL = event.outputBuffer.getChannelData(0);
      const outR = event.outputBuffer.getChannelData(1);
      const n = outL.length;
      if (ring.buffering && ring.fill >= ring.target) ring.buffering = false;
      if (ring.buffering || ring.fill < n) {
        ring.buffering = true;
        outL.fill(0);
        outR.fill(0);
        return;
      }
      for (let i = 0; i < n; i++) {
        outL[i] = ring.left[ring.r];
        outR[i] = ring.right[ring.r];
        ring.r++;
        if (ring.r === ring.cap) ring.r = 0;
      }
      ring.fill -= n;
    };
    node.connect(this.gain);
    this.node = node;
    this.mode = 'script';
  }

  push(pcm) {
    if (!this.node) return;
    if (this.mode === 'worklet') {
      // Copy so the caller's buffer (which may be a view into a network message) stays intact.
      const copy = pcm.slice();
      this.node.port.postMessage({ t: 'samples', data: copy.buffer }, [copy.buffer]);
      return;
    }
    const ring = this.ring;
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      ring.left[ring.w] = pcm[i * 2] / 32768;
      ring.right[ring.w] = pcm[i * 2 + 1] / 32768;
      ring.w++;
      if (ring.w === ring.cap) ring.w = 0;
    }
    ring.fill += frames;
    const limit = Math.min(ring.cap - 4096, ring.target * 4);
    if (ring.fill > limit) {
      const drop = ring.fill - ring.target;
      ring.r = (ring.r + drop) % ring.cap;
      ring.fill -= drop;
    }
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  flush() {
    if (this.mode === 'worklet' && this.node) this.node.port.postMessage({ t: 'flush' });
    else if (this.ring) {
      this.ring.fill = 0;
      this.ring.r = this.ring.w;
      this.ring.buffering = true;
    }
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (err) {
        /* ignored */
      }
    }
  }

  async suspend() {
    this.flush();
    if (this.ctx && this.ctx.state === 'running') {
      try {
        await this.ctx.suspend();
      } catch (err) {
        /* ignored */
      }
    }
  }

  disconnectNode() {
    if (this.node) {
      try {
        this.node.disconnect();
      } catch (err) {
        /* ignored */
      }
      if (this.mode === 'script') this.node.onaudioprocess = null;
      this.node = null;
    }
    this.ring = null;
    this.mode = 'none';
  }
}
