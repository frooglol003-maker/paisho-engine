// src/zobrist.ts
// 64-bit Zobrist hashing (as two 32-bit ints) for robustness without BigInt.
import { TypeId, Owner } from "./board";

const RNG = (() => {
  let s1 = 0x9e3779b9 ^ 0xdeadbeef, s2 = 0xa5a5a5a5 ^ 0x7f4a7c15;
  function next() {
    // xorshift-ish
    s1 ^= s1 << 13; s1 ^= s1 >>> 17; s1 ^= s1 << 5;
    s2 ^= s2 << 17; s2 ^= s2 >>> 13; s2 ^= s2 << 5;
    // return [hi, lo]
    return [(s1 ^ (s2 << 1)) >>> 0, (s2 ^ (s1 >>> 1)) >>> 0];
  }
  return { next };
})();

// Pieces: for each board index (1..249), for each (type, owner)
const MAX_SQ = 249;
const TYPES: TypeId[] = [
  TypeId.R3, TypeId.R4, TypeId.R5, TypeId.W3, TypeId.W4, TypeId.W5,
  TypeId.Lotus, TypeId.Orchid, TypeId.Rock, TypeId.Wheel, TypeId.Boat, TypeId.Knotweed
];
const OWNERS: Owner[] = [Owner.Host, Owner.Guest];

export const Z_PIECE: [number, number][][][] = (() => {
  const arr: [number, number][][][] = new Array(MAX_SQ + 1);
  for (let i = 0; i <= MAX_SQ; i++) {
    arr[i] = [];
    for (let t = 0; t < TYPES.length; t++) {
      arr[i][t] = [];
      for (let o = 0; o < OWNERS.length; o++) arr[i][t][o] = RNG.next();
    }
  }
  return arr;
})();

export const Z_SIDE: [number, number] = RNG.next();

// XOR two 64-bit tuples
export function xor64(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] ^ b[0], a[1] ^ b[1]];
}
// Convert 64-bit tuple to a short string key
export function key64(h: [number, number]): string {
  // 8 hex bytes compact
  return h[0].toString(16).padStart(8, "0") + h[1].toString(16).padStart(8, "0");
}
