/** Browse Host directories using only the public uiWorkspace.listDirectory API.
 * Listing: { path, home, crumbs: [{name,path,hidden}], entries: [{name,path,hidden}], truncated }.
 * Paths are returned by the Host; never join directory names in the browser.
 */
export function createDirectoryBrowser(navigation) {
  let state = { listing: null, loading: false, error: '' };
  let current = null;
  const listeners = new Set();
  const publish = patch => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async browse(path) {
      current?.abort();
      const request = new AbortController();
      current = request;
      publish({ loading: true, error: '' });
      try {
        if (typeof navigation?.listDirectory !== 'function') throw new Error('Directory browsing is unavailable.');
        const listing = await navigation.listDirectory(path || undefined, request.signal);
        if (request.signal.aborted || current !== request) return null;
        publish({ listing, loading: false });
        return listing;
      } catch (error) {
        if (request.signal.aborted || current !== request) return null;
        publish({ listing: null, loading: false, error: String(error?.message ?? error) });
        return null;
      }
    },
    dispose() { current?.abort(); current = null; },
  };
}

/** Create once beside the parent component, using the plugin's injected React.
 * Mount only while open. onSelect(path) may return a Promise (e.g. workspace creation).
 * On successful selection the parent should unmount this component. Creation failures
 * remain visible here; Cancel/Escape calls onCancel. No native picker is called.
 */
export function createDirectoryPicker(React) {
  const h = React.createElement;
  const buttonStyle = { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-primary, #8886)', borderRadius: 6, padding: '7px 10px', cursor: 'pointer' };
  return function DirectoryPicker({ navigation, initialPath, onSelect, onCancel, language = 'zh' }) {
    const t = (zh, en) => language === 'zh' ? zh : en;
    const browser = React.useMemo(() => createDirectoryBrowser(navigation), [navigation]);
    const state = React.useSyncExternalStore(browser.subscribe, browser.getSnapshot, browser.getSnapshot);
    const [path, setPath] = React.useState(initialPath ?? '');
    const [hidden, setHidden] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const dialog = React.useRef(null);
    const pending = React.useRef(false);
    const alive = React.useRef(true);
    const titleId = React.useId();
    React.useEffect(() => {
      alive.current = true;
      dialog.current?.showModal();
      return () => { alive.current = false; dialog.current?.close(); };
    }, []);
    React.useEffect(() => { void browser.browse(initialPath); return () => browser.dispose(); }, [browser, initialPath]);
    React.useEffect(() => { if (state.listing) setPath(state.listing.path); }, [state.listing]);
    const browse = value => { setError(''); void browser.browse(value); };
    const select = async () => {
      if (pending.current || state.loading || !state.listing) return;
      pending.current = true;
      setSaving(true); setError('');
      try {
        // Validate edited manual paths before submitting; use the Host's absolute path.
        const listing = path === state.listing.path ? state.listing : await browser.browse(path);
        if (listing && alive.current) await onSelect(listing.path);
      } catch (reason) {
        if (alive.current) setError(String(reason?.message ?? reason));
      } finally {
        pending.current = false;
        if (alive.current) setSaving(false);
      }
    };
    const listing = state.listing;
    const disabled = saving || state.loading;
    const button = (label, onClick, props = {}) => h('button', { type: 'button', style: buttonStyle, onClick, disabled, ...props }, label);
    return h('dialog', {
      ref: dialog, 'aria-labelledby': titleId, 'aria-busy': disabled,
      onCancel: event => { event.preventDefault(); if (!pending.current) onCancel(); },
      style: { color: 'var(--dsw-alias-label-primary, #222)', background: 'var(--dsw-alias-background-primary, Canvas)', border: '1px solid var(--dsw-alias-border-primary, #8886)', borderRadius: 12, padding: 20, width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 48px)', boxSizing: 'border-box', overflow: 'auto', font: 'inherit' },
    },
    h('h2', { id: titleId, style: { fontSize: '1.1em', margin: '0 0 16px' } }, t('选择工作区目录', 'Choose workspace directory')),
    h('form', { onSubmit: event => { event.preventDefault(); browse(path); }, style: { display: 'flex', gap: 8, marginBottom: 12 } },
      h('input', { autoFocus: true, 'aria-label': t('目录路径', 'Directory path'), value: path, disabled: saving, onChange: event => setPath(event.target.value), placeholder: t('输入主机目录路径', 'Enter a Host directory path'), style: { minWidth: 0, flex: 1, font: 'inherit', padding: 8, color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-primary, #8886)', borderRadius: 6 } }),
      h('button', { type: 'submit', disabled, style: buttonStyle }, t('前往', 'Go'))),
    h('nav', { 'aria-label': t('目录导航', 'Directory navigation'), style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 } },
      button(t('主目录', 'Home'), () => browse(listing?.home)),
      ...(listing?.crumbs ?? []).map(crumb => button(crumb.name, () => browse(crumb.path), { key: crumb.path, 'aria-current': crumb.path === listing.path ? 'location' : undefined }))),
    h('label', { style: { display: 'block', marginBottom: 10 } }, h('input', { type: 'checkbox', checked: hidden, onChange: event => setHidden(event.target.checked) }), ' ', t('显示隐藏目录', 'Show hidden directories')),
    h('div', { style: { minHeight: 100, maxHeight: '35dvh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
      state.loading ? h('p', { role: 'status' }, t('正在读取目录…', 'Loading directories…')) :
      (listing?.entries ?? []).filter(entry => hidden || !entry.hidden).map(entry => button(entry.name + '/', () => browse(entry.path), { key: entry.path, style: { ...buttonStyle, textAlign: 'left', overflowWrap: 'anywhere' } })),
      !state.loading && listing && !listing.entries.some(entry => hidden || !entry.hidden) ? h('p', null, t('没有可显示的子目录。可选择当前目录。', 'No visible subdirectories. You can select this directory.')) : null),
    listing?.truncated ? h('p', { role: 'status' }, t('仅显示部分目录；可输入完整路径继续。', 'Only some directories are shown; enter a full path to continue.')) : null,
    state.error || error ? h('p', { role: 'alert', style: { overflowWrap: 'anywhere' } }, state.error || error) : null,
    h('p', { style: { overflowWrap: 'anywhere', opacity: 0.8 } }, listing?.path ?? ''),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
      button(t('取消', 'Cancel'), onCancel, { disabled: saving }),
      button(saving ? t('正在添加…', 'Adding…') : t('选择此目录', 'Select directory'), () => void select(), { disabled: disabled || !listing })),
    );
  };
}
