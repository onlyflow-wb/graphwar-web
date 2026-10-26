import { Player } from '../src/core/entities';
import { Terrain } from '../src/core/terrain';

/** same scenario as test/golden/java/Golden.java */
export function scenario(kind: 'empty' | 'blocks') {
  const circles = kind === 'blocks' ? [385, 100, 40, 330, 330, 50, 200, 150, 30, 560, 260, 45] : [];
  const terrain = new Terrain(circles);
  const a = new Player('a', 0, 1, true, 2, false);
  const b = new Player('b', 1, 2, true, 3, false);
  a.startSoldier(0, 150, 200); a.startSoldier(1, 100, 330);
  b.startSoldier(0, 620, 225); b.startSoldier(1, 700, 100); b.startSoldier(2, 520, 380);
  return { terrain, players: [a, b] };
}
