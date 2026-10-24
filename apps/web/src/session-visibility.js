import { createIdempotencyKey } from "./domain.js?v=20261018-tabs-2";

// One uncertain mutation per account/project/session. Polls and navigation must
// not turn a lost acknowledgement into a second, differently keyed mutation.
export function createSessionVisibilityController({ api, getContext, onSaved, onMembers, onChange }) {
  const pending = new Map();
  const errors = new Map();
  const scope = () => {
    const c = getContext();
    return c?.userId && c?.projectId && c?.sessionId ? JSON.stringify([c.userId,c.projectId,c.sessionId]) : null;
  };
  async function refresh(key, sessionId) {
    try { const members = await api.listMembers(sessionId); if (scope() === key) onMembers(members); }
    catch { /* The normal membership poll retries independently. */ }
  }
  async function attempt(key, intent) {
    if (intent.busy) return;
    intent.busy = true; errors.delete(key); onChange();
    try {
      const result = await api.setSessionMemberVisibility(intent.sessionId, intent.userId, intent.input);
      if (result.user_id !== intent.userId) throw new Error("Unconfirmed visibility response");
      pending.delete(key);
      if (scope() === key) { onSaved(result); await refresh(key, intent.sessionId); }
    } catch (error) {
      const definitive = Number(error?.status) >= 400 && Number(error.status) < 500 && error.status !== 408;
      if (definitive) pending.delete(key);
      intent.busy = false;
      errors.set(key, { userId:intent.userId, message:definitive
        ? "Unable to change visibility. Refresh members and try again."
        : "Not confirmed. Retry the same visibility change." });
      if (definitive && scope() === key) await refresh(key, intent.sessionId);
    } finally { if (scope() === key) onChange(); }
  }
  return {
    pending: () => pending.get(scope()),
    error: () => errors.get(scope()),
    async change(member, visible) {
      const key = scope(), context = getContext();
      if (!key || !context.canManage || pending.has(key) || member.userId === context.userId
        || typeof visible !== "boolean" || typeof member.sessionVisible !== "boolean"
        || !Number.isSafeInteger(member.visibilityRevision) || member.visibilityRevision < 0) return;
      const intent = { sessionId:context.sessionId, userId:member.userId, busy:false,
        input:{visible,expectedRevision:member.visibilityRevision,idempotencyKey:createIdempotencyKey("session-visibility")} };
      pending.set(key,intent);
      await attempt(key,intent);
    },
    async retry() {
      const key = scope(), intent = pending.get(key);
      if (key && intent && getContext().canManage) await attempt(key,intent);
    },
  };
}
