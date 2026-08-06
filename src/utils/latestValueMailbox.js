export class LatestValueMailbox {
  constructor() {
    this.generation = 0;
    this.value = null;
  }

  captureGeneration() {
    return this.generation;
  }

  publish(value, generation) {
    if (generation !== this.generation) {
      return false;
    }

    this.value = value;
    return true;
  }

  take() {
    const value = this.value;
    this.value = null;
    return value;
  }

  reset() {
    this.generation++;
    this.value = null;
  }
}
