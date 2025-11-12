// src/rules.ts
// Garden/gate classification, harmony/clash utilities, special-flowers helpers,
// and piece descriptor helpers. Designed to be compatible with the current codebase.

import { Pt, generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, TypeId, unpackPiece } from "./board";

// -----------------------------------------------------------------------------
// Gates & intersection typing
// -----------------------------------------------------------------------------
export const GATES: Pt[] = [
  { x:  8, y:  0 },
  { x: -8, y:  0 },
  { x:  0, y:  8 },
  { x:  0, y: -8 },
];

export function isGateCoord(x: number, y: number): boolean {
  return (Math.abs(x) === 8 && y === 0) || (Math.abs(y) === 8 && x === 0);
}

export type IntersectionType = "gate" | "white" | "red" | "neutral";

/**
 * Heuristic quadrant classifier consistent with your board art:
 * - gates: the four cardinal points
 * - midlines (x=0 or y=0) and diagonals |x|===|y| are neutral
 * - (+,+) & (-,-) are white; (+,-) & (-,+) are red
 */
export function intersectionType(x: number, y: number): IntersectionType {
  if (isGateCoord(x, y)) return "gate";
  if (x === 0 || y === 0) return "neutral";
  if (Math.abs(x) === Math.abs(y)) return "neutral";
  if (x * y > 0) return "white";
  if (x * y < 0) return "red";
  return "neutral";
}

export function getGardenType(
  x: number,
  y: number
): "white" | "red" | "neutral" | "gate" {
  const t = intersectionType(x, y);
  if (t === "gate") return "gate";
  if (t === "white") return "white";
  if (t === "red") return "red";
  return "neutral";
}

// -----------------------------------------------------------------------------
// Harmony ring cycle & helpers (R3→R4→R5→W3→W4→W5→back to R3)
// -----------------------------------------------------------------------------
export const HARMONY_CYCLE = ["R3", "R4", "R5", "W3", "W4", "W5"] as const;
export type HarmonyId = (typeof HARMONY_CYCLE)[number];

export function toHarmonyId(garden: "R" | "W", num: 3 | 4 | 5): HarmonyId {
  return (garden + String(num)) as HarmonyId;
}

export function harmoniousPair(
  aGarden: "R" | "W",
  aNum: 3 | 4 | 5,
  bGarden: "R" | "W",
  bNum: 3 | 4 | 5
): boolean {
  const ai = HARMONY_CYCLE.indexOf(toHarmonyId(aGarden, aNum));
  const bi = HARMONY_CYCLE.indexOf(toHarmonyId(bGarden, bNum));
  if (ai < 0 || bi < 0) return false;
  const d = Math.abs(ai - bi);
  return d === 1 || d === HARMONY_CYCLE.length - 1;
}

export function isClashPair(
  aGarden: "R" | "W",
  aNum: 3 | 4 | 5,
  bGarden: "R" | "W",
  bNum: 3 | 4 | 5
): boolean {
  return aGarden !== bGarden && aNum === bNum;
}

// -----------------------------------------------------------------------------
// Piece descriptor
// -----------------------------------------------------------------------------
export type PieceKind =
  | { kind: "empty" }
  | {
      kind: "basic";
      owner: "host" | "guest";
      garden: "R" | "W";
      number: 3 | 4 | 5;
      blooming: boolean;
    }
  | { kind: "lotus"; owner: "host" | "guest"; blooming: boolean }
  | {
      kind: "orchid";
      owner: "host" | "guest";
      blooming: boolean;
      wild: boolean;
    }
  | {
      kind: "accent";
      owner: "host" | "guest";
      accent: "rock" | "wheel" | "boat" | "knotweed";
    };

/** Blooming = not in a gate. */
export function isBloomingIndex(index: number): boolean {
  const { x, y } = coordsOf(index);
  return !isGateCoord(x, y);
}

/**
 * Return a high-level descriptor for the piece at a board index.
 * NOTE: For Orchid we compute `wild` live from the board state
 * (owner has a blooming Lotus).
 */
export function getPieceDescriptor(board: Board, index: number): PieceKind {
  const packed = board.getAtIndex(index); // current codebase uses 1-based indices here
  if (!packed) return { kind: "empty" };

  const decoded = unpackPiece(packed)!;
  const owner = decoded.owner === 0 ? "host" : "guest";
  const blooming = isBloomingIndex(index);

  switch (decoded.type) {
    case TypeId.R3:
      return { kind: "basic", owner, garden: "R", number: 3, blooming };
    case TypeId.R4:
      return { kind: "basic", owner, garden: "R", number: 4, blooming };
    case TypeId.R5:
      return { kind: "basic", owner, garden: "R", number: 5, blooming };
    case TypeId.W3:
      return { kind: "basic", owner, garden: "W", number: 3, blooming };
    case TypeId.W4:
      return { kind: "basic", owner, garden: "W", number: 4, blooming };
    case TypeId.W5:
      return { kind: "basic", owner, garden: "W", number: 5, blooming };
    case TypeId.Lotus:
      return { kind: "lotus", owner, blooming };
    case TypeId.Orchid: {
      // Orchid is wild if the same owner has a BLOOMING Lotus on the board
      const wild = ownerHasBloomingLotus(board, owner);
      return { kind: "orchid", owner, blooming, wild };
    }
    case TypeId.Rock:
      return { kind: "accent", owner, accent: "rock" };
    case TypeId.Wheel:
      return { kind: "accent", owner, accent: "wheel" };
    case TypeId.Boat:
      return { kind: "accent", owner, accent: "boat" };
    case TypeId.Knotweed:
      return { kind: "accent", owner, accent: "knotweed" };
    default:
      return { kind: "empty" };
  }
}

// -----------------------------------------------------------------------------
// Lotus / Orchid helpers (compatible with current board indexing)
// -----------------------------------------------------------------------------

/** True if the given owner has at least one BLOOMING Lotus on the board. */
export function ownerHasBloomingLotus(
  board: Board,
  owner: "host" | "guest"
): boolean {
  const pts = generateValidPoints(); // board order; callers elsewhere used i+1
  for (let i = 0; i < pts.length; i++) {
    const idx = i + 1; // current Board.getAtIndex/packing uses 1-based indices
    const packed = board.getAtIndex(idx);
    if (!packed) continue;
    const dec = unpackPiece(packed)!;
    if (dec.type !== TypeId.Lotus) continue;

    const lotusOwner = dec.owner === 0 ? "host" : "guest";
    if (lotusOwner !== owner) continue;

    if (isBloomingIndex(idx)) return true;
  }
  return false;
}

/** Orchid becomes wild when its owner has a BLOOMING Lotus. */
export function isOrchidWild(board: Board, owner: "host" | "guest"): boolean {
  return ownerHasBloomingLotus(board, owner);
}

/**
 * Is the flower at `index` trapped by any enemy Orchid in its 8-neighborhood?
 * A trapped flower cannot move on Arrange turns.
 */
export function isTrappedByOrchid(board: Board, index: number): boolean {
  const packedVictim = board.getAtIndex(index);
  if (!packedVictim) return false;

  const victim = unpackPiece(packedVictim)!;
  // Only flowers are subject to trapping; ignore empty and accents.
  const isVictimFlower =
    victim.type === TypeId.R3 ||
    victim.type === TypeId.R4 ||
    victim.type === TypeId.R5 ||
    victim.type === TypeId.W3 ||
    victim.type === TypeId.W4 ||
    victim.type === TypeId.W5 ||
    victim.type === TypeId.Lotus ||
    victim.type === TypeId.Orchid;
  if (!isVictimFlower) return false;

  const victimOwner: "host" | "guest" = victim.owner === 0 ? "host" : "guest";
  const { x, y } = coordsOf(index);

  // Check 8-neighborhood around (x, y)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nIdx0 = indexOf(x + dx, y + dy);
      if (nIdx0 === -1) continue;
      const nIdx1 = nIdx0 + 1; // Board.getAtIndex expects 1-based index
      const qPacked = board.getAtIndex(nIdx1);
      if (!qPacked) continue;

      const q = unpackPiece(qPacked)!;
      if (q.type !== TypeId.Orchid) continue;

      const qOwner: "host" | "guest" = q.owner === 0 ? "host" : "guest";
      if (qOwner !== victimOwner) {
        // enemy Orchid adjacent → trapped
        return true;
      }
    }
  }
  return false;
}
