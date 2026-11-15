/** @template T @param {Promise<T>} promise @param {AbortSignal} [signal] @returns {Promise<T>} */
export async function withAbort(promise, signal) {
  if (!signal) return promise;
  let onAbort = () => {};
  /** @type {Promise<never>} */
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
