// Keep hover timing under plugin control instead of the browser's native title delay.
export function installSidebarTooltips(root = document) {
  let timer;
  let target;
  const tip = root.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('data-dsl-tooltip', '');
  Object.assign(tip.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', whiteSpace: 'pre-wrap', maxWidth: '420px', padding: '7px 10px', borderRadius: '6px', background: '#252525', color: '#fff', border: '1px solid var(--dsw-alias-border-l2,#555)', boxShadow: '0 3px 12px #0003', fontSize: '12px', display: 'none' });
  root.body.appendChild(tip);
  const hide = () => { clearTimeout(timer); tip.style.display = 'none'; target = null; };
  const find = event => event.target?.closest?.('[data-dsh-session-library-sidebar] [data-dsl-tip]');
  const show = element => {
    if (!element.isConnected) return;
    tip.textContent = element.getAttribute('data-dsl-tip');
    tip.style.display = 'block';
    const box = element.getBoundingClientRect();
    tip.style.left = Math.max(4, Math.min(box.left, root.documentElement.clientWidth - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(box.bottom + 5, root.documentElement.clientHeight - tip.offsetHeight - 4)) + 'px';
  };
  const over = event => { const next = find(event); if (!next || next === target) return; hide(); target = next; timer = setTimeout(() => show(next), 600); };
  const out = event => { if (target && !target.contains(event.relatedTarget)) hide(); };
  const context = event => {
    const next = find(event);
    if (!next || next.closest('[data-dsl-session-row]') || !next.matches('button')) return;
    event.preventDefault(); event.stopPropagation(); hide(); target = next; show(next);
  };
  const scroll = event => { if (target?.closest('[data-dsh-session-library-sidebar]')?.contains(event.target)) hide(); };
  root.addEventListener('mouseover', over, true);
  root.addEventListener('mouseout', out, true);
  root.addEventListener('pointerover', over, true);
  root.addEventListener('pointerout', out, true);
  root.addEventListener('contextmenu', context, true);
  root.addEventListener('click', hide, true);
  root.addEventListener('scroll', scroll, true);
  return () => {
    hide(); tip.remove();
    root.removeEventListener('mouseover', over, true);
    root.removeEventListener('mouseout', out, true);
    root.removeEventListener('pointerover', over, true);
    root.removeEventListener('pointerout', out, true);
    root.removeEventListener('contextmenu', context, true);
    root.removeEventListener('click', hide, true);
    root.removeEventListener('scroll', scroll, true);
  };
}
