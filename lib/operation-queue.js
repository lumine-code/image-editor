module.exports = class OperationQueue {
  #pending = [];
  #active = null;
  #idleWaiters = [];
  #disposed = false;
  #onDidChange;

  constructor(onDidChange) {
    this.#onDidChange = onDidChange;
  }

  get running() {
    return this.#active?.context ?? null;
  }

  get waiting() {
    return this.#pending.map(({ label }) => label);
  }

  get hasPendingChanges() {
    return (
      (this.#active?.affectsFile === true && !this.#active.context.signal.aborted) ||
      this.#pending.some((task) => task.affectsFile)
    );
  }

  enqueue({ label, run, isValid = () => true, affectsFile = false }) {
    if (this.#disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#pending.push({ label, run, isValid, affectsFile, resolve, reject });
      if (this.#active) this.#notify();
      else this.#startNext();
    });
  }

  whenIdle() {
    if (!this.#active) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  discardInvalid() {
    const valid = [];
    for (const task of this.#pending) {
      if (task.isValid()) valid.push(task);
      else task.resolve();
    }
    if (valid.length === this.#pending.length) return;
    this.#pending = valid;
    this.#notify();
  }

  cancel() {
    const active = this.#active;
    if (!this.#pending.length && !active?.context.canCancel) return false;

    // Abort listeners are synchronous and may submit new work.
    const pending = this.#pending;
    this.#pending = [];
    for (const task of pending) task.resolve();
    if (active?.context.canCancel) active.controller.abort();
    this.#notify();
    return true;
  }

  dispose() {
    this.#disposed = true;
    this.cancel();
    this.#onDidChange = null;
  }

  #startNext() {
    const task = this.#pending.shift();
    if (!task) {
      const idleWaiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of idleWaiters) resolve();
      this.#notify();
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const active = { controller, committed: false, affectsFile: task.affectsFile };
    active.context = Object.freeze({
      label: task.label,
      signal,
      get canCancel() {
        return !active.committed && !signal.aborted;
      },
      commit: () => {
        signal.throwIfAborted();
        if (this.#active !== active) {
          throw new DOMException("Image operation has already finished", "AbortError");
        }
        if (active.committed) return;
        active.committed = true;
        this.#notify();
      },
    });
    this.#active = active;
    this.#notify();
    void this.#run(task, active.context);
  }

  async #run(task, context) {
    const { signal } = context;
    try {
      const value = await this.#invoke(task, context);
      task.resolve(signal.aborted ? undefined : value);
    } catch (error) {
      if (signal.aborted && (error === signal.reason || error?.name === "AbortError"))
        task.resolve();
      else task.reject(error);
    } finally {
      this.#active = null;
      this.#startNext();
    }
  }

  async #invoke(task, context) {
    if (context.signal.aborted || !task.isValid()) return;
    context.signal.throwIfAborted();
    return task.run(context);
  }

  #notify() {
    try {
      this.#onDidChange?.(this);
    } catch (error) {
      console.error("Image operation queue listener failed", error);
    }
  }
};
