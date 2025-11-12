// src/coords.ts
// Canonical 249-point Pai Sho grid (bottom row first):
// Row widths: 9, 11, 13, 15, 17×9, 15, 13, 11, 9

export type XY = { x: number; y: number };

// ---------- Geometry ----------
export const ROW_WIDTHS: number[] = [
  9, 11, 13, 15,
  17, 17, 17, 17, 17, 17, 17, 17, 17,
  15, 13, 11, 9
]; // rows r = 0..16 (r=0 is bottom / y = -8)

export const NUM_ROWS = ROW_WIDTHS.length; // 17

export const ROW_OFFSETS: number[] = (() => {
  const off: number[] = [];
  let acc = 0;
  for (const w of ROW_WIDTHS) { off.push(acc); acc += w; }
  return off;
})();

export const NUM_SQUARES = ROW_OFFSETS[NUM_ROWS - 1] + ROW_WIDTHS[NUM_ROWS - 1]; // 249
export const NUM_POINTS = NUM_SQUARES; // alias if other files use this

// Convenience: y for a row index and x for a column index
export function rowToY(r: number): number { return r - 8; }
export function colToX(r: number, c: number): number {
  const w = ROW_WIDTHS[r];
  const minX = -((w - 1) / 2);
  return minX + c;
}

// ---------- Indexing ----------
export function toIndex(row: number, col: number): number {
  if (row < 0 || row >= NUM_ROWS) return -1;
  const w = ROW_WIDTHS[row];
  if (col < 0 || col >= w) return -1;
  return ROW_OFFSETS[row] + col;
}

export function fromIndex(idx: number): { row: number; col: number } {
  if (idx < 0 || idx >= NUM_SQUARES) throw new Error(`index OOB: ${idx}`);
  let lo = 0, hi = NUM_ROWS - 1, row = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ROW_OFFSETS[mid] <= idx) { row = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  const col = idx - ROW_OFFSETS[row];
  return { row, col };
}

// ---------- Full table: index -> (x,y) ----------
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

// Helper: (x,y) -> index, or -1 if not on board
export function indexOf(x: number, y: number): number {
  const row = y + 8; // invert rowToY
  if (row < 0 || row >= NUM_ROWS) return -1;
  const w = ROW_WIDTHS[row];
  const minX = -((w - 1) / 2);
  const col = x - minX;
  if (!Number.isInteger(col) || col < 0 || col >= w) return -1;
  return toIndex(row, col);
}

// Helper: index -> (x,y)
export function toXY(index: number): XY {
  return XY_BY_INDEX[index];
}

// Iterate all indices [0..NUM_SQUARES-1]
export function* allIndices(): Iterable<number> {
  for (let i = 0; i < NUM_SQUARES; i++) yield i;
}

// ---------- Compatibility shims expected by other modules ----------
export type Pt = XY;

// older API expects a FUNCTION: totalIntersections()
export function totalIntersections(): number {
  return NUM_SQUARES;
}

// older name for "xy at index"
export function coordsOf(index: number): XY {
  return XY_BY_INDEX[index];
}

// older helper that returns all valid points in board order
export function generateValidPoints(): XY[] {
  return XY_BY_INDEX.slice(); // shallow copy so callers can't mutate our table
}
