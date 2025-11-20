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
  if (!c) return [];

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
    if (i0 !== -1) out.push(i0 + 1);    // back to 1-based
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
    case TypeId.Lotus:  return 2; // Lotus moves up to 2
    case TypeId.Orchid: return 6; // Orchid moves up to 6
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
 *   - BUT it can still capture an enemy wild orchid.
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
  const aNum = aDesc.number as 3 | 4 | 5;
  const bNum = bDesc.number as 3 | 4 | 5;

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

  // Orchid freeze
  if (isTrappedByOrchid(board, fromIdx)) {
    return { ok: false, reason: "piece is frozen by an Orchid" };
  }

  const startPiece = unpackPiece(startPacked)!;
  const type = startPiece.type;

  // Enforce move ranges
  const limit = maxArrangeSteps(type);
  if (limit !== null && path.length > limit) {
    return { ok: false, reason: `path too long for that tile (max ${limit})` };
  }

  let { x: px, y: py } = coordsOf(fromIdx - 1);

  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    const { x, y } = coordsOf(idx - 1);
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

export type HarmonyEdge = {
  aIdx1: number;
  bIdx1: number;
  owner: "host" | "guest"; // which side this harmony belongs to (for bonuses & UI)
};

/**
 * Build harmony graph.
 *
 * Nodes:
 *   - all blooming basic flowers (R3/4/5, W3/4/5)  
 *   - Lotus (always allowed as a harmony node)  
 *   - never Orchid
 *
 * Edges:
 *   - same axis (x or y)
 *   - clear line of sight (no blockers / gates)
 *   - EITHER:
 *       * normal flower–flower pattern via isHarmonyActivePair, or
 *       * “Lotus override”: exactly one endpoint is Lotus and the other is a basic flower
 *         (Lotus–Lotus is *not* a harmony).
 */
export function buildHarmonyGraph(board: Board): Map<number, number[]> {
  const pts = generateValidPoints();
  const nodeIdxs: number[] = [];

  // --- pick which indices can ever be harmony endpoints ---
  for (let i = 0; i < pts.length; i++) {
    const idx1 = i + 1;
    const packed = board.getAtIndex(idx1);
    if (!packed) continue;

    const piece = unpackPiece(packed)!;

    // Orchids NEVER harmonize
    if (piece.type === TypeId.Orchid) continue;

    const desc = getPieceDescriptor(board, idx1);

    // Blooming basics harmonize
    if (desc.kind === "basic" && desc.blooming) {
      nodeIdxs.push(idx1);
      continue;
    }

    // Lotus is always allowed as a harmony node
    if (piece.type === TypeId.Lotus) {
      nodeIdxs.push(idx1);
    }
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

      // Must have clear LOS
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;

      const aPack = board.getAtIndex(aIdx1)!;
      const bPack = board.getAtIndex(bIdx1)!;
      const aPiece = unpackPiece(aPack)!;
      const bPiece = unpackPiece(bPack)!;

      // Orchids double-check
      if (aPiece.type === TypeId.Orchid || bPiece.type === TypeId.Orchid) continue;

      const aIsLotus = aPiece.type === TypeId.Lotus;
      const bIsLotus = bPiece.type === TypeId.Lotus;

      // Lotus–Lotus is NOT a harmony
      if (aIsLotus && bIsLotus) continue;

      const aDesc = getPieceDescriptor(board, aIdx1);
      const bDesc = getPieceDescriptor(board, bIdx1);

      let active = false;

      // Case 1: both are basic flowers → normal pattern
      if (aDesc.kind === "basic" && bDesc.kind === "basic") {
        active = isHarmonyActivePair(
          board,
          aIdx1,
          bIdx1,
          aDesc.garden,
          aDesc.number,
          bDesc.garden,
          bDesc.number
        );
      }

      // Case 2: exactly one Lotus + one basic flower → always harmonic
      if (!active && (aIsLotus !== bIsLotus)) {
        const otherDesc = aIsLotus ? bDesc : aDesc;
        if (otherDesc.kind === "basic") {
          active = true;
        }
      }

      if (!active) continue;

      graph.set(aIdx1, (graph.get(aIdx1) || []).concat(bIdx1));
      graph.set(bIdx1, (graph.get(bIdx1) || []).concat(aIdx1));
    }
  }

  return graph;
}

/**
 * List all harmony edges with ownership.
 *
 * Lotus rule: if exactly one endpoint is Lotus and the other is a basic flower,
 * that’s a harmony “owned” by the basic flower’s side. Lotus–Lotus never counts.
 */
export function listHarmonyEdges(board: Board): HarmonyEdge[] {
  const pts = generateValidPoints();
  const result: HarmonyEdge[] = [];

  for (let i = 0; i < pts.length; i++) {
    const aIdx1 = i + 1;
    const aPack = board.getAtIndex(aIdx1);
    if (!aPack) continue;

    const aPiece = unpackPiece(aPack)!;
    if (aPiece.type === TypeId.Orchid) continue; // orchids never harmonize

    const aDesc = getPieceDescriptor(board, aIdx1);
    const aC = coordsOf(aIdx1 - 1);
    if (!aC) continue;

    for (let j = i + 1; j < pts.length; j++) {
      const bIdx1 = j + 1;
      const bPack = board.getAtIndex(bIdx1);
      if (!bPack) continue;

      const bPiece = unpackPiece(bPack)!;
      if (bPiece.type === TypeId.Orchid) continue;

      const bDesc = getPieceDescriptor(board, bIdx1);
      const bC = coordsOf(bIdx1 - 1);
      if (!bC) continue;

      // Must share an axis
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      // Must have clear LOS
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;

      const aIsLotus = (aPiece.type === TypeId.Lotus);
      const bIsLotus = (bPiece.type === TypeId.Lotus);

      // Lotus–Lotus is NOT a harmony
      if (aIsLotus && bIsLotus) continue;

      let active = false;

      // Case 1: both basics → normal pattern
      if (aDesc.kind === "basic" && bDesc.kind === "basic") {
        active = isHarmonyActivePair(
          board,
          aIdx1,
          bIdx1,
          aDesc.garden,
          aDesc.number,
          bDesc.garden,
          bDesc.number
        );
      }

      // Case 2: Lotus + basic flower
      if (!active && (aIsLotus !== bIsLotus)) {
        const otherDesc = aIsLotus ? bDesc : aDesc;
        if (otherDesc.kind === "basic") {
          active = true;
        }
      }

      if (!active) continue;

      // Decide which side “owns” this harmony.
      let ownerSide: "host" | "guest";

      if (!aIsLotus && !bIsLotus) {
        // standard basic–basic harmony: both must be basic & same owner
        if (aDesc.kind !== "basic" || bDesc.kind !== "basic") continue;
        if (aDesc.owner !== bDesc.owner) continue;

        ownerSide = (aDesc.owner === "host" ? "host" : "guest");
      } else {
        // Lotus + basic flower → belongs to the basic flower’s owner
        const basicDesc = aIsLotus ? bDesc : aDesc;
        if (basicDesc.kind !== "basic") continue;
        ownerSide = (basicDesc.owner === "host" ? "host" : "guest");
      }

      result.push({
        aIdx1,
        bIdx1,
        owner: ownerSide,
      });
    }
  }

  return result;
}

// Who (if anyone) currently owns a harmony ring around (0,0)?
export type RingOwners = { host: boolean; guest: boolean };

/**
 * A "ring" is any harmony cycle from findHarmonyRings whose edges are
 * all owned by the same side (host or guest). If both sides have at least
 * one such ring at the same time, that's a double-ring draw.
 */
export function getRingOwners(board: Board): RingOwners {
  const edges = listHarmonyEdges(board);

  // Map undirected edge key "min-max" -> owner ("host" | "guest")
  const edgeOwner = new Map<string, "host" | "guest">();
  for (const e of edges) {
    const a = Math.min(e.aIdx1, e.bIdx1);
    const b = Math.max(e.aIdx1, e.bIdx1);
    const key = `${a}-${b}`;
    edgeOwner.set(key, e.owner);
  }

  const rings = findHarmonyRings(board);
  let host = false;
  let guest = false;

  for (const cycle of rings) {
    if (cycle.length < 3) continue;

    const owners = new Set<"host" | "guest">();

    for (let i = 0; i < cycle.length; i++) {
      const a = cycle[i];
      const b = cycle[(i + 1) % cycle.length];
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      const owner = edgeOwner.get(key);
      if (owner) owners.add(owner);
    }

    // Ring only "belongs" if all its edges belong to the same side
    if (owners.size === 1) {
      const only = [...owners][0];
      if (only === "host") host = true;
      else guest = true;
    }
  }

  return { host, guest };
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
