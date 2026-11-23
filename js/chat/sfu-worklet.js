/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* AudioWorklet processors for the group-call SFU (js/chat/68-sfu-call.js).

   poorija-sfu-capture: the microphone, in 20 ms blocks of 960 samples at
   48 kHz (what Opus takes), posted to the page to be encoded.
   poorija-sfu-play: one per person heard, a small jitter buffer the page
   fills with decoded samples; silence when it runs dry, the oldest dropped
   when it runs over (a voice late by a second is worse than a gap). */

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(960);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const take = Math.min(channel.length - at, 960 - this.filled);
      this.block.set(channel.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === 960) {
        this.port.postMessage(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.max = 48000;
    this.buffer = new Float32Array(this.max);
    this.read = 0;
    this.size = 0;
    this.port.onmessage = (event) => {
      const samples = event.data;
      for (let i = 0; i < samples.length; i += 1) {
        if (this.size === this.max) { this.read = (this.read + 1) % this.max; this.size -= 1; }
        this.buffer[(this.read + this.size) % this.max] = samples[i];
        this.size += 1;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    for (let i = 0; i < out.length; i += 1) {
      if (this.size > 0) {
        out[i] = this.buffer[this.read];
        this.read = (this.read + 1) % this.max;
        this.size -= 1;
      } else out[i] = 0;
    }
    return true;
  }
}

registerProcessor('poorija-sfu-capture', Capture);
registerProcessor('poorija-sfu-play', Play);
