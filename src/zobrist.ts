// src/zobrist.ts
// Lightweight Zobrist hashing for Pai Sho board states.
// We represent a 64-bit value as a tuple [hi, lo] of unsigned 32-bit ints.

export type U64 = [number, number];

export function xor64(a: U64, b: U64): U64 {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

/** Turn a 64-bit tuple into a fixed 16-hex-character key string. */
export function key64(z: U64): string {
  const hi = z[0] >>> 0;
  const lo = z[1] >>> 0;
  const h = hi.toString(16).padStart(8, "0");
  const l = lo.toString(16).padStart(8, "0");
  return h + l;
}

// ---------------- RNG ----------------
// Two xorshift32 streams; each next() returns a U64 = [hi, lo].
class XorShift32 {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9; // golden ratio seed if 0
  }
  step(): number {
    // xorshift32
    let x = this.s;
    x ^= (x << 13) >>> 0;
    x ^= (x >>> 17) >>> 0;
    x ^= (x << 5) >>> 0;
    this.s = x >>> 0;
    return this.s;
  }
}

class RNG64 {
  private a: XorShift32;
  private b: XorShift32;
  constructor(seedHi = 0x85ebca6b, seedLo = 0xc2b2ae35) {
    this.a = new XorShift32(seedHi >>> 0);
    this.b = new XorShift32(seedLo >>> 0);
  }
  next(): U64 {
    // produce two 32-bit words
    const hi = this.a.step();
    const lo = this.b.step();
    return [hi >>> 0, lo >>> 0];
  }
}

const RNG = new RNG64(0x12345678, 0x9abcdef0);

// ---------------- Tables ----------------
// Indices: 1..249 (we'll allocate 250 and ignore index 0)
// Types: 12 (R3,R4,R5,W3,W4,W5,Lotus,Orchid,Rock,Wheel,Boat,Knotweed)
// Owners: 2 (Host, Guest)

const N_SLOTS = 250;  // support 1..249 inclusive
const N_TYPES = 12;
const N_OWNERS = 2;

// Allocate fully-typed 3D array of U64
const ZP: U64[][][] = Array.from({ length: N_SLOTS }, () =>
  Array.from({ length: N_TYPES }, () =>
    Array.from({ length: N_OWNERS }, () => [0, 0] as U64)
  )
);

// Fill with random U64 values
for (let i = 0; i < N_SLOTS; i++) {
  for (let t = 0; t < N_TYPES; t++) {
    for (let o = 0; o < N_OWNERS; o++) {
      ZP[i][t][o] = RNG.next(); // <-- correctly typed as U64
    }
  }
}

/** Zobrist piece table, indexed as Z_PIECE[index1][typeIdx][ownerIdx] -> U64 */
export const Z_PIECE: U64[][][] = ZP;

/** Side-to-move key. */
export const Z_SIDE: U64 = RNG.next();
