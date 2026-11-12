import test from 'node:test';
import assert from 'node:assert/strict';
import { installSidebarTooltips } from '../client/tooltips.mjs';

test('button names wait 600 milliseconds, right click shows immediately, leaving cancels, and dispose removes listeners', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlers = new Map();
  const tip = { style: {}, offsetWidth: 100, offsetHeight: 30, setAttribute() {}, remove() { this.removed = true; } };
  const root = { createElement: () => tip, body: { appendChild() {} }, documentElement: { clientWidth: 600, clientHeight: 600 }, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const target = { isConnected: true, getAttribute: () => 'New session', getBoundingClientRect: () => ({ left: 20, bottom: 50 }), contains: () => false, matches: () => true, closest: selector => selector === '[data-dsl-session-row]' ? null : target };
  const dispose = installSidebarTooltips(root);
  handlers.get('pointerover')({ target });
  handlers.get('scroll')({ target: { id: 'streaming-chat' } }); // unrelated chat scrolling must not cancel the sidebar hint
  t.mock.timers.tick(599); assert.equal(tip.style.display, 'none');
  t.mock.timers.tick(1); assert.equal(tip.style.display, 'block'); assert.equal(tip.textContent, 'New session');
  handlers.get('pointerout')({ relatedTarget: null }); assert.equal(tip.style.display, 'none');
  handlers.get('pointerover')({ target }); handlers.get('pointerout')({ relatedTarget: null });
  t.mock.timers.tick(600); assert.equal(tip.style.display, 'none');
  let prevented = false;
  handlers.get('contextmenu')({ target, preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true); assert.equal(tip.style.display, 'block');
  dispose(); assert.equal(tip.removed, true); assert.equal(handlers.size, 0);
});
