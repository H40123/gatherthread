/** Only sessions created by this browser are candidates. The server checks
 * emptiness and ownership atomically; never fall back to unconditional delete. */
export function createSoloDrafts({ api, onDiscard = () => {}, onError = () => {}, onPendingChange = () => {} }) {
  const candidates = new Set();
  const pending = new Map();
  let generation = 0;
  return {
    has(id) { return candidates.has(id); },
    isPending(id) { return pending.has(id); },
    remember(session) { if (session?.mode === "solo") candidates.add(session.id); },
    submitted(id) { candidates.delete(id); },
    clear() { generation++; candidates.clear(); pending.clear(); },
    async leave(id) {
      if (!id || !candidates.has(id)) return;
      if (pending.has(id)) return pending.get(id);
      const captured = generation;
      const operation = (async () => {
        try {
          const result = await Promise.resolve().then(() => api.discardEmptySolo(id));
          if (captured !== generation) return;
          candidates.delete(id);
          if (result.discarded) onDiscard(id);
        } catch (error) {
          if (captured !== generation) return;
          // An already-deleted conversation needs no further cleanup.
          if (error?.status === 404 && api.getSession) {
            try { await api.getSession(id, { deadlineMs: 3000 }); }
            catch (readError) {
              if (captured !== generation) return;
              if (readError?.status === 404) { candidates.delete(id); onDiscard(id); return; }
            }
          }
          if (captured === generation) onError(error);
        } finally {
          if (captured === generation) { pending.delete(id); onPendingChange(id); }
        }
      })();
      pending.set(id, operation);
      onPendingChange(id);
      return operation;
    },
  };
}
