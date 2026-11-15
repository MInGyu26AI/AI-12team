// Lucian 2.0.13 original drawings, poses and timings; Chrome content-world adapter.
// Chrome's isolated world has no usable customElements registry.
import definitions from './vendor/lucian/definitions.json';
import { frame, timing, origin, drawParts, poseOf } from './vendor/lucian/runtime.js';

export function mountLucianIcons(root) {
  for (const host of root.querySelectorAll('[data-lucian]')) {
    const def = definitions[host.dataset.lucian];
    if (!def) continue;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>:host{display:inline-block;width:32px;height:32px;line-height:0;pointer-events:none}svg{display:block;width:100%;height:100%;overflow:visible}[data-part]{transform-box:view-box}.s{fill:none}.t{fill:none;stroke:none}.a{stroke:currentColor}.f,.k{fill:currentColor;stroke:none}</style><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g data-part="*">${def.svg}</g></svg>`;
    const nodes = new Map();
    const draws = drawParts(def);
    const pose = poseOf(def, def.defaultState ?? null);
    for (const node of shadow.querySelectorAll('[data-part]')) {
      const name = node.dataset.part;
      const [x, y] = origin(def, name);
      node.style.transformOrigin = `${x}px ${y}px`;
      if (draws.has(name)) {
        for (const shape of [node, ...node.querySelectorAll('path,line,polyline,circle,rect,ellipse')]) {
          shape.setAttribute('pathLength', '1');
          shape.style.strokeDasharray = '1 1';
        }
      }
      if (pose[name]) Object.assign(node.style, frame(pose[name]));
      nodes.set(name, node);
    }
    let effects = [];
    host.play = () => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || effects.some(a => a.playState === 'running')) return false;
      effects = Object.entries(def.effect).map(([name, spec]) => nodes.get(name)?.animate(
        spec.k.map(frame), { ...timing(spec, { e: 'inOut', d: 600 }), composite: 'add', fill: 'backwards' },
      )).filter(Boolean);
      return true;
    };
  }
}
