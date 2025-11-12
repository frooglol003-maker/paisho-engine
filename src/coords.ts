// src/coords.ts
// Canonical 249-point Pai Sho grid with row widths:
// 9,11,13,15, 17×9, 15,13,11,9  (bottom row first)

export type XY = { x: number; y: number };

// ----- Geometry -----
export const ROW_WIDTHS: number[] = [
  9, 11, 13, 15,
  17, 17, 17, 17, 17, 17, 17, 17, 17,
  15, 13, 11, 9
]; // rows r = 0..16 (r=0 is bottom)

export const NUM_ROWS = ROW_WIDTHS.length; // 17

export const ROW_OFFSETS: number[] = (() => {
  const off: number[] = [];
  let acc = 0;
  for (const w of ROW_WIDTHS) { off.push(acc); acc += w; }
  return off; // length 17
})();

export const NUM_SQUARES = ROW_OFFSETS[NUM_ROWS - 1] + ROW_WIDTHS[NUM_ROWS - 1]; // 249

// y coordinate for row r (bottom to top): -8 .. +8
export function rowToY(r: number): number {
  return r - 8;
}

// For a given row r, x runs from -((w-1)/2) .. +((w-1)/2) in steps of 1
export function colToX(r: number, c: number): number {
  const w = ROW_WIDTHS[r];
  const minX = -((w - 1) / 2);
  return minX + c;
}

// ----- Indexing helpers -----
// toIndex from (row, col)
export function toIndex(row: number, col: number): number {
  if (row < 0 || row >= NUM_ROWS) return -1;
  const w = ROW_WIDTHS[row];
  if (col < 0 || col >= w) return -1;
  return ROW_OFFSETS[row] + col;
}

// fromIndex to (row, col)
export function fromIndex(idx: number): { row: number; col: number } {
  if (idx < 0 || idx >= NUM_SQUARES) throw new Error(`index OOB: ${idx}`);
  // binary search over ROW_OFFSETS (17 rows — linear would also be fine)
  let lo = 0, hi = NUM_ROWS - 1, row = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ROW_OFFSETS[mid] <= idx) { row = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  const col = idx - ROW_OFFSETS[row];
  return { row, col };
}

// ----- Graph-style coordinate mapping -----
// We map each (row, col) to an (x, y) where y = row - 8, and x spans the width.
// This produces exactly 249 intersections with simple integer coordinates.

export const XY_BY_INDEX: XY[] = (() => {
  const arr: XY[] = new Array(NUM_SQUARES);
  for (let r = 0; r < NUM_ROWS; r++) {
    const y = rowToY(r);
    const w = ROW_WIDTHS[r];
    const minX = -((w - 1) / 2);
    for (let c = 0; c < w; c++) {
      const idx = toIndex(r, c);
      arr[idx] = { x: minX + c, y };
    }
  }
  return arr;
})();

// Reverse lookup: (x,y) -> index. Returns -1 if not a valid board point.
export function indexOf(x: number, y: number): number {
  const row = y + 8; // invert rowToY
  if (row < 0 || row >= NUM_ROWS) return -1;
  const w = ROW_WIDTHS[row];
  const minX = -((w - 1) / 2);
  const col = x - minX;
  if (!Number.isInteger(col) || col < 0 || col >= w) return -1;
  return toIndex(row, col);
}

// Convenience: iterate all indices [0..NUM_SQUARES-1]
export function* allIndices(): Iterable<number> {
  for (let i = 0; i < NUM_SQUARES; i++) yield i;
}
// --- Compatibility shims for older code ---
// Type alias
export type Pt = XY;

// Same value, older name
export const totalIntersections = NUM_SQUARES;

// Older name for toXY
export function coordsOf(index: number): XY {
  return toXY(index);
}

// Older helper: list of all valid (x,y) points in board order
export function generateValidPoints(): XY[] {
  return XY_BY_INDEX.slice(); // shallow copy
}
