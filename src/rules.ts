// rules.ts
// Garden/gate classification, harmony/clash utilities, and piece descriptor helpers.

import { Pt, generateValidPoints, coordsOf } from "./coords";
import { Board, TypeId, unpackPiece } from "./board";

// Gates
export const GATES: Pt[] = [
  { x: 8, y: 0 },
  { x: -8, y: 0 },
  { x: 0, y: 8 },
  { x: 0, y: -8 },
];

export function isGateCoord(x: number, y: number): boolean {
  return (Math.abs(x) === 8 && y === 0) || (Math.abs(y) === 8 && x === 0);
}

export type IntersectionType = "gate" | "white" | "red" | "neutral";
export function intersectionType(x: number, y: number): IntersectionType {
  if (isGateCoord(x, y)) return "gate";
  if (x === 0 || y === 0) return "neutral";
  if (Math.abs(x) === Math.abs(y)) return "neutral";
  if (x * y > 0) return "white";
  if (x * y < 0) return "red";
  return "neutral";
}
export function getGardenType(x: number, y: number): "white" | "red" | "neutral" | "gate" {
  const t = intersectionType(x, y);
  if (t === "gate") return "gate";
  if (t === "white") return "white";
  if (t === "red") return "red";
  return "neutral";
}

// Harmony cycle and helpers
export const HARMONY_CYCLE = ["R3", "R4", "R5", "W3", "W4", "W5"] as const;
export type HarmonyId = typeof HARMONY_CYCLE[number];
export function toHarmonyId(garden: "R" | "W", num: 3 | 4 | 5): HarmonyId {
  return (garden + String(num)) as HarmonyId;
}
export function harmoniousPair(aGarden: "R"|"W", aNum: 3|4|5, bGarden: "R"|"W", bNum: 3|4|5): boolean {
  const ai = HARMONY_CYCLE.indexOf(toHarmonyId(aGarden, aNum));
  const bi = HARMONY_CYCLE.indexOf(toHarmonyId(bGarden, bNum));
  if (ai < 0 || bi < 0) return false;
  const d = Math.abs(ai - bi);
  return d === 1 || d === (HARMONY_CYCLE.length - 1);
}
export function isClashPair(aGarden: "R"|"W", aNum: 3|4|5, bGarden: "R"|"W", bNum: 3|4|5): boolean {
  return (aGarden !== bGarden) && (aNum === bNum);
}

// Piece descriptor returned by getPieceDescriptor
export type PieceKind =
  | { kind: "empty" }
  | { kind: "basic", owner: "host"|"guest", garden: "R"|"W", number: 3|4|5, blooming: boolean }
  | { kind: "lotus", owner: "host"|"guest", blooming: boolean }
  | { kind: "orchid", owner: "host"|"guest", blooming: boolean, wild: boolean }
  | { kind: "accent", owner: "host"|"guest", accent: "rock"|"wheel"|"boat"|"knotweed" };

export function getPieceDescriptor(board: Board, index: number): PieceKind {
  const packed = board.getAtIndex(index);
  if (!packed) return { kind: "empty" };
  const decoded = unpackPiece(packed)!;
  const owner = decoded.owner === 0 ? "host" : "guest";
  const { x, y } = coordsOf(index);
  const blooming = !isGateCoord(x, y);
  switch (decoded.type) {
    case TypeId.R3: return { kind: "basic", owner, garden: "R", number: 3, blooming };
    case TypeId.R4: return { kind: "basic", owner, garden: "R", number: 4, blooming };
    case TypeId.R5: return { kind: "basic", owner, garden: "R", number: 5, blooming };
    case TypeId.W3: return { kind: "basic", owner, garden: "W", number: 3, blooming };
    case TypeId.W4: return { kind: "basic", owner, garden: "W", number: 4, blooming };
    case TypeId.W5: return { kind: "basic", owner, garden: "W", number: 5, blooming };
    case TypeId.Lotus: return { kind: "lotus", owner, blooming };
    case TypeId.Orchid: {
      // wild is determined by owner having any Blooming Lotus (caller can ask for recompute)
      // default to false here; callers can compute wildness by scanning board for owner's lotus
      return { kind: "orchid", owner, blooming, wild: false };
    }
    case TypeId.Rock: return { kind: "accent", owner, accent: "rock" };
    case TypeId.Wheel: return { kind: "accent", owner, accent: "wheel" };
    case TypeId.Boat: return { kind: "accent", owner, accent: "boat" };
    case TypeId.Knotweed: return { kind: "accent", owner, accent: "knotweed" };
    default: return { kind: "empty" };
  }
}

// Find if an owner has a blooming lotus on the board
export function ownerHasBloomingLotus(board: Board, owner: "host"|"guest"): boolean {
  const pts = generateValidPoints();
  for (let i = 0; i < pts.length; i++) {
    const idx = i + 1;
    const packed = board.getAtIndex(idx);
    if (!packed) continue;
    const dec = unpackPiece(packed)!;
    if (dec.type === TypeId.Lotus) {
      const lotusOwner = dec.owner === 0 ? "host" : "guest";
      const { x, y } = coordsOf(idx);
      if (lotusOwner === owner && !isGateCoord(x, y)) return true;
    }
  }
  return false;
}
