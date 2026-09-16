/** Join the monitor-owned task collection, including work added while awaiting it. */
export async function waitForPending(
  read: () => Iterable<Promise<unknown>>,
  reject = false,
): Promise<void> {
  for (;;) {
    const pending = [...read()];
    if (pending.length === 0) {
      return;
    }
    await (reject ? Promise.all(pending) : Promise.allSettled(pending));
  }
}
