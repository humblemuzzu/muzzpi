/**
 * A timer callback that cannot throw. After a session is replaced its ctx
 * throws on use, and a throw inside a timer is an uncaught exception that
 * exits pi.
 */
export function guarded(run: () => void): () => void {
  return () => {
    try {
      run();
    } catch {}
  };
}
