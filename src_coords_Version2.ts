// coords.ts
// Coordinate utilities for the Pai Sho board (centered 17x17 grid).
// Valid intersections: integer (x,y) with |x| + |y| <= 8 and x,y have same parity (both even or both odd).
// Index ordering: scan y from -8 up to +8 (bottom-to-top), for each y scan x from -8 to +8 (left-to-right),
// include only valid intersections. Indexes are 1-based.

export type Pt = { x: number; y: number };
export const RADIUS = 8;
export const BOARD_SIDE = 17; // coordinates run -8..8 inclusive

let pointsCache: Pt[] | null = null;
export function generateValidPoints(): Pt[] {
  if (pointsCache) return pointsCache;
  const pts: Pt[] = [];
  for (let y = -RADIUS; y <= RADIUS; y++) {
    for (let x = -RADIUS; x <= RADIUS; x++) {
      if (isValidIntersection(x, y)) pts.push({ x, y });
    }
  }
  pointsCache = pts;
  return pts;
}

export function isValidIntersection(x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (Math.abs(x) + Math.abs(y) > RADIUS) return false;
  // same parity: absolute parity works for negatives too
  return (Math.abs(x) % 2) === (Math.abs(y) % 2);
}

export function totalIntersections(): number {
  return generateValidPoints().length;
}

export function indexOf(x: number, y: number): number {
  if (!isValidIntersection(x, y)) throw new RangeError(`invalid intersection (${x},${y})`);
  const pts = generateValidPoints();
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].x === x && pts[i].y === y) return i + 1;
  }
  throw new Error("unreachable: valid point not found");
}

export function coordsOf(index: number): Pt {
  const pts = generateValidPoints();
  if (index < 1 || index > pts.length) throw new RangeError("invalid index");
  return pts[index - 1];
}