// src/move.ts
// Move validation, clash detection, harmony graph and ring detection.
// NOTE: Board indices are 1-based (1..249). coords/index helpers are 0-based (0..248).
// Always use (idx-1) when calling coordsOf(), and (indexOf(...) + 1) when calling board.getAtIndex().

import { generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId, Owner } from "./board";
import {
  getPieceDescriptor,
  isClashPair,
  getGardenType,
  isGateCoord,
  isHarmonyActivePair,
  isTrappedByOrchid,
} from "./rules";

/* -------------------------------------------------------------------------- */
/*  Helpers for neighbors / gates                                             */
/* -------------------------------------------------------------------------- */

/* Utility to compute orthogonal neighbors (returns 1-based indices). */
function orthogonalNeighborsIdx(idx1: number): number[] {
  const c = coordsOf(idx1 - 1) as { x: number; y: number } | undefined;
  if (!c) return []; // invalid index → no neighbors

  const { x, y } = c;
  const candidates = [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ];
  const out: number[] = [];
  for (const cand of candidates) {
    const i0 = indexOf(cand.x, cand.y); // 0-based
    if (i0 !== -1) out.push(i0 + 1); // convert back to 1-based
  }
  return out;
}

/* lineOfSightClear: true if orthogonal straight segment from a to b has no pieces and no gates between them */
export function lineOfSightClear(board: Board, aIdx1: number, bIdx1: number): boolean {
  const a = coordsOf(aIdx1 - 1) as any;
  const b = coordsOf(bIdx1 - 1) as any;
  if (!a || !b) return false; // invalid indices, treat as blocked

  if (a.x !== b.x && a.y !== b.y) return false;
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);

  let cx = a.x + dx;
  let cy = a.y + dy;
  while (!(cx === b.x && cy === b.y)) {
    const mid0 = indexOf(cx, cy); // 0-based
    if (mid0 === -1) return false; // off board
    const packed = board.getAtIndex(mid0 + 1); // board is 1-based
    if (packed) return false;
    if (isGateCoord(cx, cy)) return false;
    cx += dx;
    cy += dy;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Clash detection                                                           */
/* -------------------------------------------------------------------------- */

export function detectAnyClash(board: Board): boolean {
  const N = (board as any).size1Based ?? 249;

  for (let aIdx1 = 1; aIdx1 <= N; aIdx1++) {
    const pA = getPieceDescriptor(board, aIdx1);
    if (pA.kind !== "basic" || !pA.blooming) continue;

    const aC = coordsOf(aIdx1 - 1) as any;
    if (!aC) continue;

    for (let bIdx1 = 1; bIdx1 <= N; bIdx1++) {
      if (bIdx1 === aIdx1) continue;

      const pB = getPieceDescriptor(board, bIdx1);
      if (pB.kind !== "basic" || !pB.blooming) continue;

      const bC = coordsOf(bIdx1 - 1) as any;
      if (!bC) continue;

      // same axis?
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;

      if (isClashPair(pA.garden, pA.number, pB.garden, pB.number)) {
        return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Arrange validation + capturing                                            */
/* -------------------------------------------------------------------------- */

export type ArrangeValidation = { ok: true } | { ok: false; reason: string };

function isRedFlower(t: TypeId): boolean {
  return t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5;
}
function isWhiteFlower(t: TypeId): boolean {
  return t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5;
}

/** Is (x,y) a legal final garden for this piece type? */
function canStopOnGarden(type: TypeId, x: number, y: number): boolean {
  const g = getGardenType(x, y); // "red" | "white" | "neutral"

  if (g === "neutral") return true;

  if (g === "red" && isWhiteFlower(type)) return false;
  if (g === "white" && isRedFlower(type)) return false;

  // Lotus / Orchid / accents can land anywhere
  return true;
}

/** Max arrange steps per tile type (null = no intrinsic cap). */
function maxArrangeSteps(t: TypeId): number | null {
  switch (t) {
    case TypeId.R3:
    case TypeId.W3: return 3;
    case TypeId.R4:
    case TypeId.W4: return 4;
    case TypeId.R5:
    case TypeId.W5: return 5;
    case TypeId.Lotus:   return 2; // Lotus moves up to 2
    case TypeId.Orchid:  return 6; // Orchid moves up to 6
    default:
      // Rock, Wheel, Boat, Knotweed:
      // if they arrange at all, treat them as "no intrinsic limit"
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Orchid / Lotus special status                                             */
/* -------------------------------------------------------------------------- */

/** True if this side has a Lotus of that owner *out of any gate*. */
function hasLotusOutOfGate(board: Board, owner: Owner): boolean {
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const dec = unpackPiece(p)!;
    if (dec.type !== TypeId.Lotus) continue;
    if (dec.owner !== owner) continue;

    const { x, y } = coordsOf(i - 1);
    // Only count as "active" lotus if it is NOT in a gate
    if (!isGateCoord(x, y)) {
      return true;
    }
  }
  return false;
}

/**
 * Orchid is "wild" if that side has its own Lotus out of a gate.
 * Wild orchid:
 *   - can capture any enemy piece
 *   - can be captured by any enemy piece
 * Non-wild orchid:
 *   - cannot capture or be captured by "normal" pieces
 *   - BUT (because "anything can capture a wild orchid") it can still capture an enemy wild orchid.
 */
function isOrchidWild(board: Board, owner: Owner): boolean {
  return hasLotusOutOfGate(board, owner);
}

/* Capture validation for the *final* landing intersection. */
function canCaptureOn(board: Board, fromIdx: number, targetIdx: number): ArrangeValidation {
  const fromPacked = board.getAtIndex(fromIdx);
  const targetPacked = board.getAtIndex(targetIdx);
  if (!fromPacked || !targetPacked) {
    return { ok: false, reason: "capture requires both mover and target" };
  }

  const fromPiece = unpackPiece(fromPacked)!;
  const targetPiece = unpackPiece(targetPacked)!;

  if (fromPiece.owner === targetPiece.owner) {
    return { ok: false, reason: "cannot capture your own piece" };
  }

  const fromOwner = fromPiece.owner;
  const targetOwner = targetPiece.owner;
  const fromType = fromPiece.type;
  const targetType = targetPiece.type;

  const moverIsOrchid  = (fromType === TypeId.Orchid);
  const targetIsOrchid = (targetType === TypeId.Orchid);

  const moverOrchidWild  = moverIsOrchid  && isOrchidWild(board, fromOwner);
  const targetOrchidWild = targetIsOrchid && isOrchidWild(board, targetOwner);

  // --- wildcard rules for orchids --------------------------------------

  // 1) Anything can capture a *wild* orchid
  if (targetIsOrchid && targetOrchidWild) {
    return { ok: true };
  }

  // 2) A wild orchid can capture ANY enemy piece
  if (moverOrchidWild) {
    return { ok: true };
  }

  // 3) A non-wild orchid cannot capture normal pieces
  if (moverIsOrchid && !moverOrchidWild) {
    return { ok: false, reason: "Orchid is not wild and cannot capture that piece" };
  }

  // 4) A non-wild orchid cannot be captured by normal pieces
  if (targetIsOrchid && !targetOrchidWild) {
    return { ok: false, reason: "Cannot capture a non-wild orchid" };
  }

  // --- normal "clash" capture for basic flowers ------------------------
  const aDesc = getPieceDescriptor(board, fromIdx);
  const bDesc = getPieceDescriptor(board, targetIdx);

  if (aDesc.kind !== "basic" || bDesc.kind !== "basic") {
    // Capturing accents etc. is not allowed except via Boat rules, not Arrange.
    return { ok: false, reason: "Cannot capture that tile" };
  }

  const aGarden = aDesc.garden as ("R" | "W");
  const bGarden = bDesc.garden as ("R" | "W");
  const aNum = aDesc.number as (3 | 4 | 5);
  const bNum = bDesc.number as (3 | 4 | 5);

  if (!isClashPair(aGarden, aNum, bGarden, bNum)) {
    return { ok: false, reason: "Capture allowed only when tiles clash" };
  }

  return { ok: true };
}

/**
 * Validate an arrange path.
 * - Path is a list of 1-based indices.
 * - Each step must be 1-square orthogonal (no diagonals, no jumps).
 * - You CANNOT pass through occupied intersections.
 * - FINAL intersection may be:
 *      - empty (normal move), respecting garden-color rules, OR
 *      - occupied by an enemy piece that you are allowed to capture.
 */
export function validateArrange(board: Board, fromIdx: number, path: number[]): ArrangeValidation {
  if (path.length === 0) {
    return { ok: false, reason: "empty path" };
  }

  const startPacked = board.getAtIndex(fromIdx);
  if (!startPacked) return { ok: false, reason: "no tile at start" };

   // Orchid freeze: if this piece is frozen, it cannot move at all.
  // (We let rules.ts decide what counts as "trapped".)
  if (isTrappedByOrchid(board, fromIdx)) {
    return { ok: false, reason: "piece is frozen by an Orchid" };
  }
  
  const startPiece = unpackPiece(startPacked)!;
  const type = startPiece.type;

  // Enforce numbered flower move ranges (3/4/5), Lotus (2), Orchid (6)
  const limit = maxArrangeSteps(type);
  if (limit !== null && path.length > limit) {
    return { ok: false, reason: `path too long for that tile (max ${limit})` };
  }

  let { x: px, y: py } = coordsOf(fromIdx - 1);

  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    const { x, y } = coordsOf(idx - 1); // 1-based board index → 0-based coords index
    const isLast = (i === path.length - 1);

    const dx = x - px;
    const dy = y - py;

    // Must move orthogonally, one step at a time.
    if (dx !== 0 && dy !== 0) {
      return { ok: false, reason: "Arrange must move orthogonally (no diagonals)." };
    }
    if (Math.abs(dx) + Math.abs(dy) !== 1) {
      return { ok: false, reason: "Arrange must move in single-step increments." };
    }

    const occupant = board.getAtIndex(idx);

    if (!isLast) {
      // Intermediate squares must be empty
      if (occupant) {
        return { ok: false, reason: `blocked at intermediate ${idx}` };
      }
    } else {
      // Final square:
      if (occupant) {
        // Attempt to capture
        const cap = canCaptureOn(board, fromIdx, idx);
        if (!cap.ok) return cap;
      } else {
        // Normal landing on empty intersection, must obey garden rules
        if (!canStopOnGarden(type, x, y)) {
          return { ok: false, reason: "cannot stop on that garden" };
        }
      }
    }

    px = x;
    py = y;
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Harmony graph & rings                                                     */
/* -------------------------------------------------------------------------- */

/* Build harmony graph.
   Nodes: blooming basic tiles (EXCLUDING Orchids);
   Edges: share axis, lineOfSightClear, and isHarmonyActivePair (cancels for Rock/Knotweed).
*/
export function buildHarmonyGraph(board: Board): Map<number, number[]> {
  const pts = generateValidPoints();
  const nodeIdxs: number[] = [];

  for (let i = 0; i < pts.length; i++) {
    const idx1 = i + 1;
    const desc = getPieceDescriptor(board, idx1);

    // Must be blooming to harmonize:
    if (!desc.blooming) continue;

    const packed = board.getAtIndex(idx1);
    if (!packed) continue;
    const piece = unpackPiece(packed)!;

    // Orchids NEVER harmonize with anything.
    if (piece.type === TypeId.Orchid) continue;

    // Lotus *is allowed* to harmonize.
    // Flowers are allowed. Wheel/Rock/Boat/Knotweed are NOT blooming, so already filtered out.

    nodeIdxs.push(idx1);
  }

  const graph = new Map<number, number[]>();

  for (let i = 0; i < nodeIdxs.length; i++) {
    for (let j = i + 1; j < nodeIdxs.length; j++) {
      const aIdx1 = nodeIdxs[i];
      const bIdx1 = nodeIdxs[j];

      const aC = coordsOf(aIdx1 - 1);
      const bC = coordsOf(bIdx1 - 1);
      if (!aC || !bC) continue;

      // Must share an axis
      if (aC.x !== bC.x && aC.y !== bC.y) continue;

      // Must not have blockers
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;

      // Get full descriptors
      const aDesc = getPieceDescriptor(board, aIdx1);
      const bDesc = getPieceDescriptor(board, bIdx1);

      // Orchids already filtered above, but double-protect:
      if (aDesc.type === TypeId.Orchid || bDesc.type === TypeId.Orchid) continue;

      // Lotus is allowed — so we do NOT enforce "basic" anymore.
      // Let rules.ts decide harmony rules:
      const aGarden = aDesc.garden as ("R" | "W");
      const bGarden = bDesc.garden as ("R" | "W");
      const aNum = aDesc.number as (3 | 4 | 5 | undefined);
      const bNum = bDesc.number as (3 | 4 | 5 | undefined);

      // Harmony rules (Lotus always returns true inside isHarmonyActivePair)
      if (isHarmonyActivePair(board, aIdx1, bIdx1, aGarden, aNum, bGarden, bNum)) {
        graph.set(aIdx1, (graph.get(aIdx1) || []).concat(bIdx1));
        graph.set(bIdx1, (graph.get(bIdx1) || []).concat(aIdx1));
      }
    }
  }

  return graph;
}

/* Simple edge listing, useful for detecting NEW harmonies after a move. */
export type HarmonyEdge = {
  aIdx1: number;
  bIdx1: number;
  owner: "host" | "guest"; // we tag by side that owns BOTH endpoints
};

export function listHarmonyEdges(board: Board): HarmonyEdge[] {
  const pts = generateValidPoints();
  const result: HarmonyEdge[] = [];

  for (let i = 0; i < pts.length; i++) {
    const aIdx1 = i + 1;
    const aPack = board.getAtIndex(aIdx1);
    if (!aPack) continue;

    const aPiece = unpackPiece(aPack)!;
    // Orchids never harmonize with anything
    if (aPiece.type === TypeId.Orchid) continue;

    const aDesc = getPieceDescriptor(board, aIdx1);
    if (!aDesc.blooming) continue;

    const aC = coordsOf(aIdx1 - 1);
    if (!aC) continue;

    for (let j = i + 1; j < pts.length; j++) {
      const bIdx1 = j + 1;
      const bPack = board.getAtIndex(bIdx1);
      if (!bPack) continue;

      const bPiece = unpackPiece(bPack)!;
      // Orchids never harmonize with anything
      if (bPiece.type === TypeId.Orchid) continue;

      const bDesc = getPieceDescriptor(board, bIdx1);
      if (!bDesc.blooming) continue;

      // Bonus logic: only count harmonies between tiles of the SAME owner
      if (aDesc.owner !== bDesc.owner) continue;

      const bC = coordsOf(bIdx1 - 1);
      if (!bC) continue;

      // same axis?
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;

      const aGarden = aDesc.garden as ("R" | "W");
      const bGarden = bDesc.garden as ("R" | "W");
      // Allow undefined numbers so Lotus can participate
      const aNum = aDesc.number as (3 | 4 | 5 | undefined);
      const bNum = bDesc.number as (3 | 4 | 5 | undefined);

      if (!isHarmonyActivePair(board, aIdx1, bIdx1, aGarden, aNum, bGarden, bNum)) {
        continue;
      }

      result.push({
        aIdx1,
        bIdx1,
        owner: aDesc.owner,
      });
    }
  }

  return result;
}

/* Basic cycle detection + polygon test for center inclusion (0,0).
   We build simple cycles via DFS, then ray-cast to check if polygon encloses origin. */
export function findHarmonyRings(board: Board): number[][] {
  const graph = buildHarmonyGraph(board);
  const nodes = Array.from(graph.keys());
  const rings: number[][] = [];
  const visited = new Set<string>();
  const maxLen = 20;

  function dfs(start: number, curr: number, parent: number | null, path: number[], seen: Set<number>) {
    if (path.length > maxLen) return;
    const neighbors = graph.get(curr) || [];
    for (const nb of neighbors) {
      if (nb === parent) continue;
      if (nb === start && path.length >= 4) {
        const cycle = [...path];
        const key = cycle.slice().sort((a, b) => a - b).join(",");
        if (!visited.has(key)) {
          visited.add(key);
          if (cycleEnclosesOrigin(cycle)) rings.push(cycle.slice());
        }
      } else if (!seen.has(nb) && nb > start) {
        seen.add(nb);
        path.push(nb);
        dfs(start, nb, curr, path, seen);
        path.pop();
        seen.delete(nb);
      }
    }
  }

  for (const start of nodes) {
    dfs(start, start, null, [start], new Set<number>([start]));
  }
  return rings;
}

function cycleEnclosesOrigin(cycle: number[]): boolean {
  const pts = cycle.map((i1) => coordsOf(i1 - 1)); // coords need 0-based
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect =
      ((yi > 0) !== (yj > 0)) &&
      (0 < (xj - xi) * (0 - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

