/*
 * melonDS Web - audio output worklet.
 * Keeps a small jitter buffer and nudges the playback rate by up to 1% so the emulator's
 * clock and the sound card's clock never drift apart audibly.
 * Licensed under the GNU General Public License v3 or later.
 */
class MelonAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.capacity = Math.max(8192, Math.round(sampleRate)); // one second
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.writePos = 0;
    this.readPos = 0; // fractional
    this.fill = 0; // samples available, fractional
    this.target = Math.round(sampleRate * (opts.targetSeconds || 0.07));
    this.buffering = true;

    this.port.onmessage = (event) => {
      const m = event.data;
      if (m.t === 'samples') this.push(new Int16Array(m.data));
      else if (m.t === 'target') this.target = Math.round(sampleRate * m.seconds);
      else if (m.t === 'flush') {
        this.fill = 0;
        this.readPos = this.writePos;
        this.buffering = true;
      }
    };
  }

  push(pcm) {
    const frames = pcm.length >> 1;
    const cap = this.capacity;
    let w = this.writePos;
    for (let i = 0; i < frames; i++) {
      this.left[w] = pcm[i * 2] / 32768;
      this.right[w] = pcm[i * 2 + 1] / 32768;
      w++;
      if (w === cap) w = 0;
    }
    this.writePos = w;
    this.fill += frames;

    // Far too much queued (tab was stalled, or a burst arrived): jump forward to the target.
    const limit = Math.min(cap - 256, this.target * 4);
    if (this.fill > limit) {
      const drop = this.fill - this.target;
      this.readPos = (this.readPos + drop) % cap;
      this.fill -= drop;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;

    if (this.buffering) {
      if (this.fill < this.target) return true; // silence while filling
      this.buffering = false;
    }

    const cap = this.capacity;
    const error = (this.fill - this.target) / this.target;
    const rate = 1 + Math.max(-0.01, Math.min(0.01, error * 0.02));

    let pos = this.readPos;
    let fill = this.fill;
    for (let i = 0; i < n; i++) {
      if (fill < 2) {
        // Underrun: go quiet and rebuild the buffer.
        this.buffering = true;
        for (let j = i; j < n; j++) {
          outL[j] = 0;
          outR[j] = 0;
        }
        break;
      }
      const i0 = pos | 0;
      const i1 = i0 + 1 === cap ? 0 : i0 + 1;
      const frac = pos - i0;
      outL[i] = this.left[i0] + (this.left[i1] - this.left[i0]) * frac;
      outR[i] = this.right[i0] + (this.right[i1] - this.right[i0]) * frac;
      pos += rate;
      fill -= rate;
      if (pos >= cap) pos -= cap;
    }
    this.readPos = pos;
    this.fill = fill;
    return true;
  }
}

registerProcessor('melon-audio', MelonAudioProcessor);
