"use strict";
// src/coords.ts
// Canonical 249-point Pai Sho grid (bottom row first):
// Row widths: 9, 11, 13, 15, 17×9, 15, 13, 11, 9
Object.defineProperty(exports, "__esModule", { value: true });
exports.XY_BY_INDEX = exports.NUM_POINTS = exports.NUM_SQUARES = exports.ROW_OFFSETS = exports.NUM_ROWS = exports.ROW_WIDTHS = void 0;
exports.rowToY = rowToY;
exports.colToX = colToX;
exports.toIndex = toIndex;
exports.fromIndex = fromIndex;
exports.indexOf = indexOf;
exports.toXY = toXY;
exports.allIndices = allIndices;
exports.totalIntersections = totalIntersections;
exports.coordsOf = coordsOf;
exports.generateValidPoints = generateValidPoints;
// ---------- Geometry ----------
exports.ROW_WIDTHS = [
    9, 11, 13, 15,
    17, 17, 17, 17, 17, 17, 17, 17, 17,
    15, 13, 11, 9
]; // rows r = 0..16 (r=0 is bottom / y = -8)
exports.NUM_ROWS = exports.ROW_WIDTHS.length; // 17
exports.ROW_OFFSETS = (() => {
    const off = [];
    let acc = 0;
    for (const w of exports.ROW_WIDTHS) {
        off.push(acc);
        acc += w;
    }
    return off;
})();
exports.NUM_SQUARES = exports.ROW_OFFSETS[exports.NUM_ROWS - 1] + exports.ROW_WIDTHS[exports.NUM_ROWS - 1]; // 249
exports.NUM_POINTS = exports.NUM_SQUARES; // alias if other files use this
// Convenience: y for a row index and x for a column index
function rowToY(r) { return r - 8; }
function colToX(r, c) {
    const w = exports.ROW_WIDTHS[r];
    const minX = -((w - 1) / 2);
    return minX + c;
}
// ---------- Indexing ----------
function toIndex(row, col) {
    if (row < 0 || row >= exports.NUM_ROWS)
        return -1;
    const w = exports.ROW_WIDTHS[row];
    if (col < 0 || col >= w)
        return -1;
    return exports.ROW_OFFSETS[row] + col;
}
function fromIndex(idx) {
    if (idx < 0 || idx >= exports.NUM_SQUARES)
        throw new Error(`index OOB: ${idx}`);
    let lo = 0, hi = exports.NUM_ROWS - 1, row = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (exports.ROW_OFFSETS[mid] <= idx) {
            row = mid;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    const col = idx - exports.ROW_OFFSETS[row];
    return { row, col };
}
// ---------- Full table: index -> (x,y) ----------
exports.XY_BY_INDEX = (() => {
    const arr = new Array(exports.NUM_SQUARES);
    for (let r = 0; r < exports.NUM_ROWS; r++) {
        const y = rowToY(r);
        const w = exports.ROW_WIDTHS[r];
        const minX = -((w - 1) / 2);
        for (let c = 0; c < w; c++) {
            const idx = toIndex(r, c);
            arr[idx] = { x: minX + c, y };
        }
    }
    return arr;
})();
// Helper: (x,y) -> index, or -1 if not on board
function indexOf(x, y) {
    const row = y + 8; // invert rowToY
    if (row < 0 || row >= exports.NUM_ROWS)
        return -1;
    const w = exports.ROW_WIDTHS[row];
    const minX = -((w - 1) / 2);
    const col = x - minX;
    if (!Number.isInteger(col) || col < 0 || col >= w)
        return -1;
    return toIndex(row, col);
}
// Helper: index -> (x,y)
function toXY(index) {
    return exports.XY_BY_INDEX[index];
}
// Iterate all indices [0..NUM_SQUARES-1]
function* allIndices() {
    for (let i = 0; i < exports.NUM_SQUARES; i++)
        yield i;
}
// older API expects a FUNCTION: totalIntersections()
function totalIntersections() {
    return exports.NUM_SQUARES;
}
// older name for "xy at index"
function coordsOf(index) {
    return exports.XY_BY_INDEX[index];
}
// older helper that returns all valid points in board order
function generateValidPoints() {
    return exports.XY_BY_INDEX.slice(); // shallow copy so callers can't mutate our table
}
