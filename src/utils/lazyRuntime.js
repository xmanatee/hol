export class LazyRuntime {
  constructor(loadModule, exportName, config) {
    if (typeof loadModule !== 'function') {
      throw new TypeError(`${exportName} runtime loader must be a function`);
    }
    this.loadModule = loadModule;
    this.exportName = exportName;
    this.config = config;
    this.runtime = null;
    this.pendingRuntime = null;
    this.subscriptions = new Map();
    this.disposed = false;
  }

  addListener(listener) {
    if (this.disposed) {
      throw new Error(`${this.exportName} runtime is disposed`);
    }
    const subscription = this.subscriptions.get(listener) ?? {
      remove: this.runtime?.addListener(listener) ?? null,
    };
    this.subscriptions.set(listener, subscription);
    return () => {
      if (this.subscriptions.get(listener) !== subscription) {
        return;
      }
      subscription.remove?.();
      this.subscriptions.delete(listener);
    };
  }

  getRuntime() {
    if (this.disposed) {
      return null;
    }
    if (!this.pendingRuntime) {
      this.pendingRuntime = this.loadModule()
        .then((module) => {
          if (this.disposed) {
            return null;
          }
          const Runtime = module[this.exportName];
          if (typeof Runtime !== 'function') {
            throw new TypeError(`Loaded runtime must export ${this.exportName}`);
          }
          this.runtime = new Runtime(this.config);
          this.subscriptions.forEach((subscription, listener) => {
            subscription.remove = this.runtime.addListener(listener);
          });
          return this.runtime;
        })
        .catch((error) => {
          this.pendingRuntime = null;
          throw error;
        });
    }
    return this.pendingRuntime;
  }

  dispose() {
    if (this.disposed) {
      return undefined;
    }
    this.disposed = true;
    const runtime = this.runtime;
    this.runtime = null;
    this.pendingRuntime = null;
    this.subscriptions.forEach((subscription) => {
      subscription.remove?.();
    });
    this.subscriptions.clear();
    return runtime?.dispose();
  }
}
