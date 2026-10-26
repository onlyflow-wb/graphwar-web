// Port of Graphwar/Obstacle.java.
// The original rasterised anti-aliased black circles on a white BufferedImage and treated any
// non-white pixel as solid. To keep every browser deterministic (important: shots are simulated
// independently on each client) we keep an integer solid-mask and rasterise with a fixed rule.
// Deviation: boundary pixels are decided by pixel-centre distance (<= r + 0.55; explosions clear < r - 0.7).
// Slack values were fitted against a pixel dump of the original Java Obstacle: ~0.02% of solid pixels differ
// (all on circle edges, 4 missing / 80 extra of 23120 in the fitting scene).
import { PLANE_HEIGHT, PLANE_LENGTH, NUM_CIRCLES_MEAN_VALUE, NUM_CIRCLES_STANDARD_DEVIATION,
  CIRCLE_MEAN_RADIUS, CIRCLE_STANDARD_DEVIATION } from './constants';
import { Rng, defaultRng, nextGaussian, nextInt } from './rng';

export class Terrain {
  /** 1 = solid, 0 = air. Row-major, PLANE_LENGTH wide. */
  readonly mask = new Uint8Array(PLANE_LENGTH * PLANE_HEIGHT);
  readonly circles: number[];
  expX = 0; expY = 0; expRadius = 0;
  /** bumped whenever the mask changes so the renderer knows to repaint its cache */
  version = 0;
  /** every explosion applied so far as [x, y, radius] triples (renderers replay these onto their cached bitmap) */
  readonly explosions: number[] = [];

  constructor(circles: number[]) {
    this.circles = circles;
    for (let i = 0; i + 2 < circles.length; i += 3) this.fillCircle(circles[i], circles[i + 1], circles[i + 2], 1, 0.55);
  }

  private fillCircle(cx: number, cy: number, r: number, value: 0 | 1, slack: number) {
    const lim = (value === 1 ? r + slack : r - slack);
    if (lim < 0) return;
    const lim2 = lim * lim;
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(PLANE_LENGTH - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(PLANE_HEIGHT - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= lim2) this.mask[y * PLANE_LENGTH + x] = value;
      }
    }
  }

  collidePoint(x: number, y: number): boolean {
    if (x < 0 || x >= PLANE_LENGTH) return true;
    if (y < 0 || y >= PLANE_HEIGHT) return true;
    return this.mask[y * PLANE_LENGTH + x] !== 0;
  }

  setExplosion(x: number, y: number, radius: number) { this.expX = x; this.expY = y; this.expRadius = radius; }

  explodePoint() {
    // Original drew an anti-aliased white oval: fully covered pixels become white, edge pixels stay greyish (solid).
    this.fillCircle(this.expX, this.expY, this.expRadius, 0, 0.7);
    this.explosions.push(this.expX, this.expY, this.expRadius);
    this.version++;
  }

  static randomCircles(r: Rng = defaultRng): number[] {
    let n = Math.floor(nextGaussian(r) * NUM_CIRCLES_STANDARD_DEVIATION + NUM_CIRCLES_MEAN_VALUE);
    if (n < 1) n = 1;
    const c: number[] = [];
    for (let i = 0; i < n; i++) {
      c.push(nextInt(r, PLANE_LENGTH), nextInt(r, PLANE_HEIGHT));
      let rad = Math.floor(nextGaussian(r) * CIRCLE_STANDARD_DEVIATION + CIRCLE_MEAN_RADIUS);
      while (rad < 0) rad = Math.floor(nextGaussian(r) * CIRCLE_STANDARD_DEVIATION + CIRCLE_MEAN_RADIUS);
      c.push(rad);
    }
    return c;
  }
}
