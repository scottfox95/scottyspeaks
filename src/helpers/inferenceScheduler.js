function abortError() {
  const error = new Error("Local inference cancelled");
  error.name = "AbortError";
  return error;
}

// One process-wide lane across local ASR engines. Active native inference is not
// preempted: abort only removes queued work; capacity releases when a task settles.
class InferenceScheduler {
  constructor() {
    this.queues = { foreground: [], background: [] };
    this.activePriority = null;
    this.reservations = new Set();
  }

  status() {
    return {
      active: this.activePriority ? 1 : 0,
      activePriority: this.activePriority,
      queued: {
        foreground: this.queues.foreground.length,
        background: this.queues.background.length,
      },
      foregroundReservations: this.reservations.size,
    };
  }

  // Reserve while recording, before a transcription task exists. The returned
  // idempotent release must run on success, silence, cancellation and owner loss.
  // Foreground remains runnable; background resumes FIFO after reservations end.
  reserveForeground() {
    const token = Symbol();
    this.reservations.add(token);
    return () => {
      this.reservations.delete(token);
      this.drain();
    };
  }

  run(task, { priority, signal } = {}) {
    if (typeof task !== "function" || !Object.hasOwn(this.queues, priority)) {
      return Promise.reject(
        new TypeError("A task and foreground/background priority are required")
      );
    }
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, signal, priority };
      entry.abort = () => {
        const queue = this.queues[priority];
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        signal.removeEventListener("abort", entry.abort);
        reject(abortError());
      };
      this.queues[priority].push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.drain();
    });
  }

  drain() {
    if (this.activePriority) return;
    const entry =
      this.queues.foreground.shift() ||
      (this.reservations.size === 0 ? this.queues.background.shift() : null);
    if (!entry) return;
    entry.signal?.removeEventListener("abort", entry.abort);
    this.activePriority = entry.priority;
    Promise.resolve()
      .then(entry.task)
      .then(
        (result) => this.finish(entry, true, result),
        (error) => this.finish(entry, false, error)
      );
  }

  finish(entry, success, result) {
    this.activePriority = null;
    if (!success) entry.reject(result);
    else entry.resolve(result);
    this.drain();
  }
}

const inferenceScheduler = new InferenceScheduler();
module.exports = { InferenceScheduler, inferenceScheduler };
