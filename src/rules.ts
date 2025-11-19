// src/rules.ts
// Garden/gate classification, harmony/clash utilities, special-flowers helpers,
// Accent logic (pure planners), and piece descriptor helpers.
// Designed to be compatible with the current codebase (Board indices are 1-based;
// coordsOf / indexOf are 0-based).

import { Pt, generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, TypeId, unpackPiece } from "./board";

// -----------------------------------------------------------------------------
// Small helper: convert 1-based board index -> (x,y) using coordsOf(0-based)
// -----------------------------------------------------------------------------
function xyOfIndex(idx1: number): { x: number; y: number } {
  // Guard in case someone passes 0 or negative
  if (!Number.isInteger(idx1) || idx1 < 1) {
    throw new Error(`xyOfIndex: expected 1-based index, got ${idx1}`);
  }
  return coordsOf(idx1 - 1);
}

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
 * Simple quadrant classifier for display:
 * - gates: the four cardinal points
 * - midlines (x=0 or y=0) and diagonals |x|===|y| are neutral
 * - (+,+) & (-,-) are white; (+,-) & (-,+) are red
 *
 * NOTE: This is for UI / labeling. Actual garden legality is handled by
 * getGardenType (diamond layout).
 */
export function intersectionType(x: number, y: number): IntersectionType {
  if (isGateCoord(x, y)) return "gate";
  if (x === 0 || y === 0) return "neutral";
  if (Math.abs(x) === Math.abs(y)) return "neutral";
  if (x * y > 0) return "white";
  if (x * y < 0) return "red";
  return "neutral";
}

export type Garden = "red" | "white" | "neutral";

/**
 * Diamond-based garden layout (Skud Pai Sho-style):
 *
 * - Midlines (x === 0 or y === 0) are NEUTRAL.
 * - If |x| + |y| < 7:
 *     Quadrants 1 & 3 (x>0,y>0 and x<0,y<0)  → RED
 *     Quadrants 2 & 4 (x<0,y>0 and x>0,y<0)  → WHITE
 * - Everything else is NEUTRAL.
 */
export function getGardenType(x: number, y: number): Garden {
  // Midlines are neutral; gates are handled separately via isGateCoord(...)
  if (x === 0 || y === 0) {
    return "neutral";
  }

  const manhattan = Math.abs(x) + Math.abs(y);
  if (manhattan >= 7) {
    return "neutral";
  }

  const inQ1 = x > 0 && y > 0;
  const inQ3 = x < 0 && y < 0;

  // Q1 & Q3 are red; Q2 & Q4 are white.
  if (inQ1 || inQ3) {
    return "red";
  } else {
    return "white";
  }
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

/** Clash pair = same number, opposite gardens (red vs white). */
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

/** Blooming = not in a gate (using 1-based board index). */
export function isBloomingIndex(index1: number): boolean {
  const { x, y } = xyOfIndex(index1);
  return !isGateCoord(x, y);
}

/**
 * Return a high-level descriptor for the piece at a board index.
 * NOTE: For Orchid we compute `wild` live from the board state
 * (owner has a blooming Lotus).
 */
export function getPieceDescriptor(board: Board, index1: number): PieceKind {
  const packed = board.getAtIndex(index1); // Board uses 1-based indices
  if (!packed) return { kind: "empty" };

  const decoded = unpackPiece(packed)!;
  const owner = decoded.owner === 0 ? "host" : "guest";
  const blooming = isBloomingIndex(index1);

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
      // DLC (Pond/Bamboo/Lion Turtle) or unknown types are treated as empty here.
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
  const pts = generateValidPoints(); // board order; coordsOf uses 0-based indices
  for (let i = 0; i < pts.length; i++) {
    const idx1 = i + 1; // 1-based index for Board
    const packed = board.getAtIndex(idx1);
    if (!packed) continue;
    const dec = unpackPiece(packed)!;
    if (dec.type !== TypeId.Lotus) continue;

    const lotusOwner = dec.owner === 0 ? "host" : "guest";
    if (lotusOwner !== owner) continue;

    if (isBloomingIndex(idx1)) return true;
  }
  return false;
}

/** Orchid becomes wild when its owner has a BLOOMING Lotus. */
export function isOrchidWild(board: Board, owner: "host" | "guest"): boolean {
  return ownerHasBloomingLotus(board, owner);
}

/**
 * Is the flower at `index1` trapped by any enemy Orchid in its 8-neighborhood?
 * A trapped flower cannot move on Arrange turns.
 */
export function isTrappedByOrchid(board: Board, index1: number): boolean {
  const packedVictim = board.getAtIndex(index1);
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
  const { x, y } = xyOfIndex(index1);

  // Check 8-neighborhood around (x, y)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nIdx0 = indexOf(x + dx, y + dy); // 0-based
      if (nIdx0 === -1) continue;
      const nIdx1 = nIdx0 + 1; // 1-based for Board
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

// -----------------------------------------------------------------------------
// Accent logic (ROCK, KNOTWEED, WHEEL, BOAT) — pure planners (no mutation)
// Integrate by calling these from move generation / harmony evaluation.
// -----------------------------------------------------------------------------

function isAccentType(t: TypeId): boolean {
  return (
    t === TypeId.Rock ||
    t === TypeId.Wheel ||
    t === TypeId.Boat ||
    t === TypeId.Knotweed
  );
}
function isRock(t: TypeId): boolean { return t === TypeId.Rock; }
function isKnotweed(t: TypeId): boolean { return t === TypeId.Knotweed; }
function isWheel(t: TypeId): boolean { return t === TypeId.Wheel; }
function isBoat(t: TypeId): boolean { return t === TypeId.Boat; }

/** Return true if there is a Rock at a given 1-based board index. */
export function isRockAt(board: Board, idx1: number): boolean {
  const p = board.getAtIndex(idx1);
  if (!p) return false;
  const dec = unpackPiece(p)!;
  return isRock(dec.type);
}

/** Return true if there is a Knotweed at a given 1-based board index. */
export function isKnotweedAt(board: Board, idx1: number): boolean {
  const p = board.getAtIndex(idx1);
  if (!p) return false;
  const dec = unpackPiece(p)!;
  return isKnotweed(dec.type);
}

/** Scan along an axis between two indices (exclusive endpoints) and test predicate. */
function scanAxis(
  board: Board,
  aIdx1: number,
  bIdx1: number,
  pred: (idx1: number) => boolean
): boolean {
  const { x: ax, y: ay } = xyOfIndex(aIdx1);
  const { x: bx, y: by } = xyOfIndex(bIdx1);
  if (ax !== bx && ay !== by) return false; // not aligned orthogonally

  const stepX = Math.sign(bx - ax);
  const stepY = Math.sign(by - ay);
  let x = ax + stepX;
  let y = ay + stepY;

  while (x !== bx || y !== by) {
    const mid0 = indexOf(x, y); // 0-based
    if (mid0 !== -1) {
      const mid1 = mid0 + 1; // 1-based
      if (pred(mid1)) return true;
    }
    x += stepX;
    y += stepY;
  }
  return false;
}

/**
 * ROCK: Cancels harmonies along its vertical/horizontal lines.
 * Use inside your harmony check: if true, the harmony is cancelled.
 */
export function hasRockBlockingHarmony(board: Board, aIdx1: number, bIdx1: number): boolean {
  // If not orthogonal, rock doesn't apply.
  const { x: ax, y: ay } = xyOfIndex(aIdx1);
  const { x: bx, y: by } = xyOfIndex(bIdx1);
  if (ax !== bx && ay !== by) return false;

  // Any Rock strictly between A and B?
  const rockBetween = scanAxis(board, aIdx1, bIdx1, (mid1) => {
    const p = board.getAtIndex(mid1);
    if (!p) return false;
    const dec = unpackPiece(p)!;
    return isRock(dec.type);
  });
  if (rockBetween) return true;

  // Also: if A or B itself is a rock (edge case), treat as cancelled.
  return isRockAt(board, aIdx1) || isRockAt(board, bIdx1);
}

/**
 * KNOTWEED: Cancels harmonies formed by tiles on any of the 8 surrounding points.
 * If either endpoint sits in a knotweed neighborhood, cancel.
 */
export function isHarmonyCancelledByKnotweed(board: Board, aIdx1: number, bIdx1: number): boolean {
  const nearKnotweed = (idx1: number): boolean => {
    const { x, y } = xyOfIndex(idx1);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const n0 = indexOf(x + dx, y + dy);
        if (n0 === -1) continue;
        const n1 = n0 + 1;
        const p = board.getAtIndex(n1);
        if (!p) continue;
        const dec = unpackPiece(p)!;
        if (isKnotweed(dec.type)) return true;
      }
    }
    return false;
  };
  return nearKnotweed(aIdx1) || nearKnotweed(bIdx1);
}

/** Combined Accent cancellation check to call from your harmony detector. */
export function harmonyCancelledByAccents(board: Board, aIdx1: number, bIdx1: number): boolean {
  return hasRockBlockingHarmony(board, aIdx1, bIdx1) ||
         isHarmonyCancelledByKnotweed(board, aIdx1, bIdx1);
}

// -----------------------------------------------------------------------------
// WHEEL planner: rotate the 8 neighbors one step clockwise around the wheel.
// Returns a move-plan mapping {from -> to} or {ok:false, reason} if illegal.
// NOTE: We do NOT mutate the board here.
// -----------------------------------------------------------------------------

export type IndexMove = { from: number; to: number };
export type PlanResult =
  | { ok: true; moves: IndexMove[] }
  | { ok: false; reason: string };

/**
 * Clockwise ring (relative to center (x,y)):
 * (-1,-1) -> (0,-1) -> (+1,-1) -> (+1,0) -> (+1,+1)
 *  -> (0,+1) -> (-1,+1) -> (-1,0) -> back
 */
const CW_RING: Pt[] = [
  { x: -1, y: -1 },
  { x:  0, y: -1 },
  { x:  1, y: -1 },
  { x:  1, y:  0 },
  { x:  1, y:  1 },
  { x:  0, y:  1 },
  { x: -1, y:  1 },
  { x: -1, y:  0 },
];

export function planWheelRotate(board: Board, wheelIdx1: number): PlanResult {
  // Verify there's a Wheel here
  const here = board.getAtIndex(wheelIdx1);
  if (!here) return { ok: false, reason: "empty center" };
  const hereDec = unpackPiece(here)!;
  if (!isWheel(hereDec.type)) return { ok: false, reason: "no wheel at center" };

  const { x: cx, y: cy } = xyOfIndex(wheelIdx1);

  const mapping: IndexMove[] = [];

  for (let k = 0; k < CW_RING.length; k++) {
    const fromRel = CW_RING[k];
    const toRel   = CW_RING[(k + CW_RING.length - 1) % CW_RING.length]; // move each piece forward (CW target)

    const from0 = indexOf(cx + fromRel.x, cy + fromRel.y);
    const to0   = indexOf(cx + toRel.x,   cy + toRel.y);
    if (from0 === -1 || to0 === -1) {
      // If any neighbor slot doesn't exist on this board shape, rotation is illegal.
      return { ok: false, reason: "edge wheel - missing neighbor slot" };
    }
    const from1 = from0 + 1;
    const to1   = to0 + 1;

    const p = board.getAtIndex(from1);
    if (p) {
      // Basic "may not move into Gates" rule for wheel-moved tiles:
      const { x: tx, y: ty } = xyOfIndex(to1);
      if (isGateCoord(tx, ty)) {
        return { ok: false, reason: "would move into gate" };
      }
      mapping.push({ from: from1, to: to1 });
    }
  }

  // Ensure no two pieces target the same cell (shouldn’t happen with a ring).
  const targets = new Set(mapping.map(m => m.to));
  if (targets.size !== mapping.length) {
    return { ok: false, reason: "collision on rotation" };
  }

  return { ok: true, moves: mapping };
}

// -----------------------------------------------------------------------------
// BOAT planners
// -----------------------------------------------------------------------------

/**
 * Boat on a BLOOMING flower: move that flower to any adjacent (8-neighborhood) legal target.
 * Returns a single-move plan or a failure with reason.
 */
export function planBoatOnFlower(
  board: Board,
  fromIdx1: number,
  toIdx1: number
): PlanResult {
  const p = board.getAtIndex(fromIdx1);
  if (!p) return { ok: false, reason: "no piece at source" };
  const dec = unpackPiece(p)!;

  // Only flowers can be boated (R/W 3/4/5, Lotus, Orchid) and must be BLOOMING
  const isFlower =
    dec.type === TypeId.R3 ||
    dec.type === TypeId.R4 ||
    dec.type === TypeId.R5 ||
    dec.type === TypeId.W3 ||
    dec.type === TypeId.W4 ||
    dec.type === TypeId.W5 ||
    dec.type === TypeId.Lotus ||
    dec.type === TypeId.Orchid;
  if (!isFlower) return { ok: false, reason: "boat source not a flower" };
  if (!isBloomingIndex(fromIdx1)) return { ok: false, reason: "flower is in a gate" };

  // Adjacent?
  const { x: fx, y: fy } = xyOfIndex(fromIdx1);
  const { x: tx, y: ty } = xyOfIndex(toIdx1);
  if (Math.max(Math.abs(fx - tx), Math.abs(fy - ty)) !== 1) {
    return { ok: false, reason: "target not adjacent" };
  }

  // Target must exist and be empty and not a gate
  const targetPacked = board.getAtIndex(toIdx1);
  if (targetPacked) return { ok: false, reason: "target occupied" };
  if (isGateCoord(tx, ty)) return { ok: false, reason: "cannot boat into gate" };

  // (Optional future: forbid boating basic flowers into opposite gardens)
  return { ok: true, moves: [{ from: fromIdx1, to: toIdx1 }] };
}

/**
 * Boat on an ACCENT: remove BOTH the Boat and the target Accent.
 * Returns a two-removals plan:
 *   { ok: true, remove: [{remove: accentIdx1}, {remove: boatIdx1}] }
 *
 * Caller (parse/engine) decides how to interpret removals.
 */
export type RemovePlan = { remove: number }; // 1-based index to remove

export type BoatAccentPlan =
  | { ok: true; remove: RemovePlan[] }
  | { ok: false; reason: string };

export function planBoatOnAccent(
  board: Board,
  accentIdx1: number,
  boatIdx1: number
): BoatAccentPlan {
  const a = board.getAtIndex(accentIdx1);
  if (!a) return { ok: false, reason: "no accent at target" };
  const aDec = unpackPiece(a)!;
  if (!isAccentType(aDec.type) || isBoat(aDec.type)) {
    return { ok: false, reason: "target is not a non-boat accent" };
  }

  const b = board.getAtIndex(boatIdx1);
  if (!b) return { ok: false, reason: "no boat tile provided" };
  const bDec = unpackPiece(b)!;
  if (!isBoat(bDec.type)) return { ok: false, reason: "source is not a boat tile" };

  // Remove both the accent and the boat
  return { ok: true, remove: [{ remove: accentIdx1 }, { remove: boatIdx1 }] };
}

// -----------------------------------------------------------------------------
// One-call harmony helper: pair check + Rock/Knotweed cancellation.
// -----------------------------------------------------------------------------
export function isHarmonyActivePair(
  board: Board,
  aIdx1: number,
  bIdx1: number,
  aGarden: "R" | "W",
  aNum: 3 | 4 | 5,
  bGarden: "R" | "W",
  bNum: 3 | 4 | 5
): boolean {
  if (!harmoniousPair(aGarden, aNum, bGarden, bNum)) return false;
  if (harmonyCancelledByAccents(board, aIdx1, bIdx1)) return false;
  return true;
}

