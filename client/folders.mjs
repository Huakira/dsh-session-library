export function createFolderStore(React, request) {
  let state = { revision: 0, folders: [], assignments: {}, loading: true, error: '' };
  let disposed = false, pending;
  const listeners = new Set();
  const publish = patch => { if (disposed) return; state = { ...state, ...patch }; for (const fn of listeners) fn(); };
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const useFolders = () => React.useSyncExternalStore(subscribe, () => state, () => state);
  async function refresh() {
    if (disposed) return;
    if (pending) return pending;
    pending = (async () => {
      try { const value = await request('folders/list'); publish({ ...value, loading: false, error: '' }); }
      catch (error) { publish({ loading: false, error: error.message || String(error) }); }
      finally { pending = undefined; }
    })();
    return pending;
  }
  async function mutate(action, payload) {
    try {
      const value = await request('folders/' + action, { ...payload, expectedRevision: state.revision });
      publish({ ...value, loading: false, error: '' });
      return value;
    } catch (error) {
      await refresh();
      throw error;
    }
  }
  return { useFolders, refresh, mutate, getSnapshot: () => state, dispose() { disposed = true; listeners.clear(); } };
}
