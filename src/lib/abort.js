/** @param {AbortSignal} signal */
function abortReason(signal) {
  return signal.reason === undefined
    ? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    : signal.reason;
}

/** @param {AbortSignal} [signal] */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

/** @param {AbortSignal[]} signals */
export function combineAbortSignals(signals) {
  const controller = new AbortController();
  /** @type {Map<AbortSignal, () => void>} */
  const listeners = new Map();
  const dispose = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  for (const signal of new Set(signals)) {
    const onAbort = () => {
      controller.abort(abortReason(signal));
      dispose();
    };
    if (signal.aborted) {
      onAbort();
      break;
    }
    listeners.set(signal, onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (controller.signal.aborted) break;
  }
  return { signal: controller.signal, dispose };
}

/** @template T @param {Promise<T>} promise @param {AbortSignal} [signal] @returns {Promise<T>} */
export async function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    throw abortReason(signal);
  }
  let onAbort = () => {};
  /** @type {Promise<never>} */
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
