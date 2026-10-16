// One Euro-style filtering with sample-domain velocity smoothing: https://gery.casiez.net/1euro/
// Sample timestamps use performance.now() milliseconds, including zero.
export class OneEuroFilter {
  constructor(freq, minCutOff = 1.0, beta = 0.0, dCutOff = 1.0) {
    if (![freq, minCutOff, dCutOff].every((value) => Number.isFinite(value) && value > 0)) {
      throw new RangeError('Filter frequency and cutoffs must be positive finite numbers.');
    }
    if (!Number.isFinite(beta) || beta < 0) {
      throw new RangeError('Filter speed coefficient must be a non-negative finite number.');
    }
    this.freq = freq;
    this.minCutOff = minCutOff;
    this.beta = beta;
    this.derivativeAlpha = this.alpha(dCutOff);
    this.value = null;
    this.derivative = 0;
    this.lastTime = null;
  }

  alpha(cutOff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2.0 * Math.PI * cutOff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(value, timestamp) {
    if (!Number.isFinite(value) || !Number.isFinite(timestamp) || timestamp < 0) {
      throw new RangeError('Filter samples require a finite value and a non-negative millisecond timestamp.');
    }
    if (this.lastTime !== null) {
      const elapsedMs = timestamp - this.lastTime;
      if (elapsedMs < 0) throw new RangeError('Filter timestamps must not move backwards.');
      if (elapsedMs > 0) this.freq = 1 / (elapsedMs / 1000);
    }
    this.lastTime = timestamp;
    if (this.value === null) {
      this.value = value;
      return value;
    }

    const velocity = (value - this.value) * this.freq;
    this.derivative = this.derivativeAlpha * velocity + (1 - this.derivativeAlpha) * this.derivative;
    const cutOff = this.minCutOff + this.beta * Math.abs(this.derivative);
    const valueAlpha = this.alpha(cutOff);
    this.value = valueAlpha * value + (1 - valueAlpha) * this.value;
    return this.value;
  }
}
