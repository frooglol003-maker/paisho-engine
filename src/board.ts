// board.ts
// Compact board representation (Int16Array) and packing helpers.

import { totalIntersections, coordsOf } from "./coords";

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
  Knotweed = 12
}

export enum Owner {
  Host = 0,
  Guest = 1
}

export function packPiece(type: TypeId, owner: Owner): number {
  return (type & 0x0f) | ((owner & 0x01) << 4);
}
export function unpackPiece(packed: number): { type: TypeId, owner: Owner } | null {
  if (!packed) return null;
  const type = (packed & 0x0f) as TypeId;
  const owner = ((packed >> 4) & 0x01) ? Owner.Guest : Owner.Host;
  return { type, owner };
}

export class Board {
  private squares: Int16Array;
  public readonly size: number;

  constructor(initial?: ArrayLike<number>) {
    this.size = TOTAL_POINTS;
    if (initial) {
      if (initial.length !== this.size) throw new Error("initial length mismatch");
      this.squares = Int16Array.from(initial);
    } else {
      this.squares = new Int16Array(this.size);
    }
  }

  getAtIndex(index: number): number {
    if (index < 1 || index > this.size) throw new RangeError("invalid index");
    return this.squares[index - 1];
  }

  setAtIndex(index: number, packed: number) {
    if (index < 1 || index > this.size) throw new RangeError("invalid index");
    this.squares[index - 1] = packed;
  }

  getAtCoord(x: number, y: number): number {
    const idx = indexOf(x, y);
    return this.getAtIndex(idx);
  }

  setAtCoord(x: number, y: number, packed: number) {
    const idx = indexOf(x, y);
    this.setAtIndex(idx, packed);
  }

  clone(): Board {
    return new Board(this.squares);
  }

  toArray(): number[] {
    return Array.from(this.squares);
  }

  // Debug helper — list non-empty squares with coords
  listPieces(): { index: number, x: number, y: number, packed: number }[] {
    const out: { index: number, x: number, y: number, packed: number }[] = [];
    for (let i = 0; i < this.size; i++) {
      const p = this.squares[i];
      if (p) {
        const { x, y } = coordsOf(i + 1);
        out.push({ index: i + 1, x, y, packed: p });
      }
    }
    return out;
  }
}
