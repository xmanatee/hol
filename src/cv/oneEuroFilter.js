// =============================================================================
// One-Euro Filter
//
// Source: http://www.lifl.fr/~casiez/1euro/
//
// This implementation accepts either seconds or performance.now() milliseconds.
// =============================================================================

class LowPassFilter {
  constructor(alpha) {
    this.y = 0;
    this.a = alpha;
    this.s = 0;
    this.initialized = false;
  }

  setAlpha(alpha) {
    this.a = alpha;
  }

  filter(value) {
    if (this.initialized) {
      this.s = this.a * value + (1.0 - this.a) * this.s;
    } else {
      this.s = value;
      this.initialized = true;
    }
    return this.s;
  }
}

const timestampDeltaToSeconds = (delta) => (delta > 10 ? delta / 1000 : delta);

export class OneEuroFilter {
  constructor(freq, minCutOff = 1.0, beta = 0.0, dCutOff = 1.0) {
    this.freq = freq;
    this.minCutOff = minCutOff;
    this.beta = beta;
    this.dCutOff = dCutOff;
    this.x = new LowPassFilter(this.alpha(minCutOff));
    this.dx = new LowPassFilter(this.alpha(dCutOff));
    this.lastTime = 0;
    this.initialized = false;
  }

  alpha(cutOff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2.0 * Math.PI * cutOff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(value, timestamp = null) {
    if (this.lastTime && timestamp && this.lastTime !== timestamp) {
      this.freq = 1.0 / timestampDeltaToSeconds(timestamp - this.lastTime);
    }
    this.lastTime = timestamp || this.lastTime + 1.0 / this.freq;

    const previous = this.x.s;
    const dvalue = this.initialized ? (value - previous) * this.freq : 0.0;
    const edvalue = this.dx.filter(dvalue);
    const cutOff = this.minCutOff + this.beta * Math.abs(edvalue);
    this.x.setAlpha(this.alpha(cutOff));
    this.initialized = true;
    return this.x.filter(value);
  }
}
