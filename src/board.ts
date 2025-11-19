// src/board.ts
// Compact board representation (Int16Array) and packing helpers.

import { totalIntersections, coordsOf, indexOf } from "./coords";

// Total playable intersections (should be 249)
export const TOTAL_POINTS = totalIntersections();

// Packed piece layout (16-bit integer per square):
// bits 0-3: type id (0 empty, 1..6 basics, 7 lotus, 8 orchid, 9 rock, 10 wheel, 11 boat, 12 knotweed)
// bit 4: owner (0 host/light, 1 guest/dark)
// bits 5-15: reserved for flags (unused for now)
export enum TypeId {
  Empty = 0,
  R3 = 1,
  R4 = 2,
  R5 = 3,
  W3 = 4,
  W4 = 5,
  W5 = 6,
  Lotus = 7,
  Orchid = 8,
  Rock = 9,
  Wheel = 10,
  Boat = 11,
  Knotweed = 12,
}

export enum Owner {
  Host = 0,
  Guest = 1,
}

export function packPiece(type: TypeId, owner: Owner): number {
  return (type & 0x0f) | ((owner & 0x01) << 4);
}

export function unpackPiece(packed: number): { type: TypeId; owner: Owner } | null {
  if (!packed) return null;
  const type = (packed & 0x0f) as TypeId;
  const owner = ((packed >> 4) & 0x01) ? Owner.Guest : Owner.Host;
  return { type, owner };
}

export class Board {
  private squares: Int16Array;

  /** Number of playable intersections (0-based array length is the same). */
  public readonly size1Based: number;
  /** Alias kept for older code that expects `size`. */
  public readonly size: number;

  constructor(initial?: ArrayLike<number>) {
    this.size1Based = TOTAL_POINTS;
    this.size = this.size1Based;

    if (initial) {
      if (initial.length !== this.size1Based) {
        throw new Error(`initial length mismatch: expected ${this.size1Based}, got ${initial.length}`);
      }
      this.squares = Int16Array.from(initial);
    } else {
      this.squares = new Int16Array(this.size1Based);
    }
  }

  /**
   * 1-based board index → packed piece.
   * Returns 0 for out-of-range indices instead of throwing, so callers can be lazy
   * when scanning loops or probing "maybe valid" indices.
   */
  getAtIndex(index: number): number {
    if (!Number.isInteger(index) || index < 1 || index > this.size1Based) {
      return 0;
    }
    return this.squares[index - 1];
  }

  /**
   * 1-based board index setter. Invalid indices are treated as programmer bugs.
   */
  setAtIndex(index: number, packed: number) {
    if (!Number.isInteger(index) || index < 1 || index > this.size1Based) {
      throw new RangeError(`Board.setAtIndex: invalid index ${index}`);
    }
    this.squares[index - 1] = packed;
  }

  /**
   * Get piece at coordinate (x,y).
   * If (x,y) is off-board, returns 0 instead of throwing.
   */
  getAtCoord(x: number, y: number): number {
    const idx0 = indexOf(x, y); // 0-based index from coords
    if (idx0 === -1) return 0;
    return this.getAtIndex(idx0 + 1);
  }

  /**
   * Set piece at coordinate (x,y).
   * If (x,y) is off-board, throws (that’s a bug in the caller).
   */
  setAtCoord(x: number, y: number, packed: number) {
    const idx0 = indexOf(x, y);
    if (idx0 === -1) {
      throw new RangeError(`Board.setAtCoord: invalid coord (${x},${y})`);
    }
    this.setAtIndex(idx0 + 1, packed);
  }

  clone(): Board {
    return new Board(this.squares);
  }

  toArray(): number[] {
    return Array.from(this.squares);
  }

  // Debug helper — list non-empty squares with coords
  listPieces(): { index: number; x: number; y: number; packed: number }[] {
    const out: { index: number; x: number; y: number; packed: number }[] = [];
    for (let i1 = 1; i1 <= this.size1Based; i1++) {
      const p = this.getAtIndex(i1);
      if (!p) continue;
      // coordsOf expects a 0-based index
      const { x, y } = coordsOf(i1 - 1);
      out.push({ index: i1, x, y, packed: p });
    }
    return out;
  }
}
