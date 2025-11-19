// src/move.ts
// Move validation, clash detection, harmony graph and ring detection.
// NOTE: Board indices are 1-based (1..249). coords/index helpers are 0-based (0..248).
// Always use (idx-1) when calling coordsOf(), and (indexOf(...) + 1) when calling board.getAtIndex().

import { generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import {
  getPieceDescriptor,
  isClashPair,
  getGardenType,
  isGateCoord,
  isHarmonyActivePair,
  isTrappedByOrchid,
} from "./rules";

// -----------------------------------------------------------------------------
// Small helper: 1-based index → (x,y) using coordsOf(0-based)
// -----------------------------------------------------------------------------
function xyOfIndex(idx1: number): { x: number; y: number } {
  if (!Number.isInteger(idx1) || idx1 < 1) {
    throw new Error(`xyOfIndex: expected 1-based index, got ${idx1}`);
  }
  return coordsOf(idx1 - 1);
}

// -----------------------------------------------------------------------------
// Garden helper for arrange legality
// -----------------------------------------------------------------------------

type GardenColour = "red" | "white" | "neutral";

/**
 * Gardens for movement:
 * - Delegates to rules.getGardenType for the diamond layout
 * - We still treat gates specially: you cannot *stop* on a gate with Arrange.
 */
function gardenAt(x: number, y: number): GardenColour {
  return getGardenType(x, y);
}

/* Utility to compute orthogonal neighbors (returns 1-based indices). */
function orthogonalNeighborsIdx(idx1: number): number[] {
  let c: { x: number; y: number };
  try {
    c = xyOfIndex(idx1);
  } catch {
    return [];
  }

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
    if (i0 !== -1) out.push(i0 + 1);     // convert back to 1-based
  }
  return out;
}

// -----------------------------------------------------------------------------
// Line-of-sight & clash
// -----------------------------------------------------------------------------

/* lineOfSightClear: true if orthogonal straight segment from a to b has no pieces and no gates between them */
export function lineOfSightClear(board: Board, aIdx1: number, bIdx1: number): boolean {
  let a, b;
  try {
    a = xyOfIndex(aIdx1);
    b = xyOfIndex(bIdx1);
  } catch {
    return false;
  }

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

/* detectAnyClash: scan all basic blooming pairs aligned with LOS and test clash */
export function detectAnyClash(board: Board): boolean {
  const N = (board as any).size1Based ?? 249;

  for (let aIdx1 = 1; aIdx1 <= N; aIdx1++) {
    const pA = getPieceDescriptor(board, aIdx1);
    if (pA.kind !== "basic" || !pA.blooming) continue;

    let aC: { x: number; y: number };
    try {
      aC = xyOfIndex(aIdx1);
    } catch {
      continue;
    }

    for (let bIdx1 = 1; bIdx1 <= N; bIdx1++) {
      if (bIdx1 === aIdx1) continue;

      const pB = getPieceDescriptor(board, bIdx1);
      if (pB.kind !== "basic" || !pB.blooming) continue;

      let bC: { x: number; y: number };
      try {
        bC = xyOfIndex(bIdx1);
      } catch {
        continue;
      }

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

// -----------------------------------------------------------------------------
// Arrange validation
// -----------------------------------------------------------------------------

export type ArrangeValidation = { ok: true } | { ok: false; reason: string };

function isRedFlower(t: TypeId): boolean {
  return t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5;
}
function isWhiteFlower(t: TypeId): boolean {
  return t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5;
}

/**
 * Can a tile of this type legally *stop* on (x,y)?
 * - We allow passing through any garden, including "wrong" color.
 * - Final destination must:
 *   - not be a gate
 *   - respect red/white garden rules for R/W flowers
 *   - neutral squares are always OK
 *   - Lotus / Orchid / accents can end anywhere non-gate
 */
function canStopOnGarden(type: TypeId, x: number, y: number): boolean {
  // Never stop on a gate with Arrange.
  if (isGateCoord(x, y)) return false;

  const g = gardenAt(x, y); // "red" | "white" | "neutral"

  if (g === "neutral") return true;

  if (g === "red" && isWhiteFlower(type)) return false;
  if (g === "white" && isRedFlower(type)) return false;

  // Lotus / Orchid / accents can land anywhere (except gates).
  return true;
}

/**
 * Maximum number of arrange *steps* for each tile type.
 * Flowers obey 3/4/5; others are unlimited (null = no intrinsic cap),
 * but move gen may still cap length.
 */
function maxArrangeSteps(t: TypeId): number | null {
  switch (t) {
    case TypeId.R3:
    case TypeId.W3: return 3;
    case TypeId.R4:
    case TypeId.W4: return 4;
    case TypeId.R5:
    case TypeId.W5: return 5;
    default:
      // Lotus, Orchid, Rock, Wheel, Boat, Knotweed:
      // if they arrange at all, treat them as "no intrinsic limit"
      return null;
  }
}

/**
 * Validate an arrange path.
 * - Path is a list of 1-based indices.
 * - Each step must be 1-square orthogonal (no diagonals, no jumps).
 * - You CANNOT pass through occupied intersections (including the final dest).
 * - You MAY pass through “wrong-color” gardens; only the FINAL
 *   destination’s garden color must be legal for the tile.
 * - If the starting tile is trapped by an enemy Orchid, the move is illegal.
 */
export type ArrangeValidation = { ok: true } | { ok: false; reason: string };

function isRedFlower(t: TypeId): boolean {
  return t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5;
}
function isWhiteFlower(t: TypeId): boolean {
  return t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5;
}

function canStopOnGarden(type: TypeId, x: number, y: number): boolean {
  const g = gardenAt(x, y); // use local geometry, not rules.getGardenType

  if (g === "neutral") return true;

  if (g === "red" && isWhiteFlower(type)) return false;
  if (g === "white" && isRedFlower(type)) return false;

  // Lotus / Orchid / accents can land anywhere
  return true;
}

function maxArrangeSteps(t: TypeId): number | null {
  switch (t) {
    case TypeId.R3:
    case TypeId.W3: return 3;
    case TypeId.R4:
    case TypeId.W4: return 4;
    case TypeId.R5:
    case TypeId.W5: return 5;
    default:
      // Lotus, Orchid, Rock, Wheel, Boat, Knotweed:
      // if they arrange at all, treat them as "no intrinsic limit"
      return null;
  }
}

/**
 * Validate an arrange path.
 * - Path is a list of 1-based indices.
 * - Each step must be 1-square orthogonal (no diagonals, no jumps).
 * - You CANNOT pass through occupied intersections.
 * - You MAY capture on the final square (enemy piece only).
 * - Final garden colour must be legal for the moving tile.
 */
export function validateArrange(board: Board, fromIdx: number, path: number[]): ArrangeValidation {
  if (path.length === 0) {
    return { ok: false, reason: "empty path" };
  }

  const startPacked = board.getAtIndex(fromIdx);
  if (!startPacked) return { ok: false, reason: "no tile at start" };
  const startPiece = unpackPiece(startPacked)!;
  const type = startPiece.type;

  // Enforce numbered flower move ranges (3/4/5)
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
    if (occupant) {
      const occ = unpackPiece(occupant)!;
      const moverOwner = startPiece.owner;

      if (!isLast) {
        // Can’t pass THROUGH any piece.
        return { ok: false, reason: `blocked at intermediate ${idx}` };
      }

      // Last step: friendly piece → illegal, enemy piece → capture allowed.
      if (occ.owner === moverOwner) {
        return { ok: false, reason: "cannot land on a friendly piece" };
      }
      // enemy piece on final square is ok; capture will be done in applyPlannedArrange
    }

    // Garden-color legality ONLY on the final landing intersection.
    if (isLast && !canStopOnGarden(type, x, y)) {
      return { ok: false, reason: "cannot stop on that garden" };
    }

    px = x;
    py = y;
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Harmony graph & rings
// -----------------------------------------------------------------------------

/* Build harmony graph and detect rings.
   Nodes: blooming basic tiles;
   Edges: share axis, lineOfSightClear, and isHarmonyActivePair (cancels for Rock/Knotweed).
*/
export function buildHarmonyGraph(board: Board): Map<number, number[]> {
  const pts = generateValidPoints();
  const nodeIdxs: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const idx1 = i + 1;
    const p = getPieceDescriptor(board, idx1);
    if (p.kind === "basic" && p.blooming) nodeIdxs.push(idx1);
  }

  const graph = new Map<number, number[]>();
  for (let i = 0; i < nodeIdxs.length; i++) {
    for (let j = i + 1; j < nodeIdxs.length; j++) {
      const aIdx1 = nodeIdxs[i], bIdx1 = nodeIdxs[j];
      const a = getPieceDescriptor(board, aIdx1) as any;
      const b = getPieceDescriptor(board, bIdx1) as any;

      const aC = xyOfIndex(aIdx1);
      const bC = xyOfIndex(bIdx1);
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;

      const aGarden = a.garden as ("R" | "W");
      const bGarden = b.garden as ("R" | "W");
      const aNum = a.number as (3 | 4 | 5);
      const bNum = b.number as (3 | 4 | 5);

      if (isHarmonyActivePair(board, aIdx1, bIdx1, aGarden, aNum, bGarden, bNum)) {
        graph.set(aIdx1, (graph.get(aIdx1) || []).concat(bIdx1));
        graph.set(bIdx1, (graph.get(bIdx1) || []).concat(aIdx1));
      } else {
        // Lotus interactions (lotus harmonizes with any basic) — handled elsewhere when lotus present.
        // TODO: add lotus edges if a lotus owned by someone participates on the same axis.
      }
    }
  }
  return graph;
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
  const pts = cycle.map((i1) => xyOfIndex(i1));
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
