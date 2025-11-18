// src/move.ts
// Move validation, clash detection, harmony graph and ring detection.
// NOTE: Board indices are 1-based (1..249). coords/index helpers are 0-based (0..248).
// Always use (idx-1) when calling coordsOf(), and (indexOf(...) + 1) when calling board.getAtIndex().

import { generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import {
  getPieceDescriptor,
  isClashPair,
  ownerHasBloomingLotus,
  getGardenType,
  isGateCoord,
  isHarmonyActivePair,
  isTrappedByOrchid,
} from "./rules";
// ----- Local garden geometry to match CLI board colours -----

type GardenColour = "red" | "white" | "neutral";

/**
 * Gardens (must match the ASCII board in play.ts):
 * - If x === 0 or y === 0 → neutral (midlines)
 * - If |x| + |y| < 7:
 *    - Quadrants 1 & 3 (x>0,y>0 or x<0,y<0) → red
 *    - Quadrants 2 & 4 (x<0,y>0 or x>0,y<0) → white
 * - Else → neutral
 * - Gates (±8,0) and (0,±8) are treated as neutral for color rules.
 */
function gardenAt(x: number, y: number): GardenColour {
  // Gates are neutral for landing rules
  if (isGateCoord(x, y)) return "neutral";

  // Midlines are neutral
  if (x === 0 || y === 0) return "neutral";

  const manhattan = Math.abs(x) + Math.abs(y);
  if (manhattan >= 7) return "neutral";

  const q1 = x > 0 && y > 0;
  const q2 = x < 0 && y > 0;
  const q3 = x < 0 && y < 0;
  // q4 is the remaining case

  if (q1 || q3) return "red";   // quadrants 1 & 3
  if (q2)        return "white"; // quadrant 2
  return "white";               // quadrant 4
}

/* Utility to compute orthogonal neighbors (returns 1-based indices). */
function orthogonalNeighborsIdx(idx1: number): number[] {
  const c = coordsOf(idx1 - 1) as { x: number; y: number } | undefined;
  if (!c) return [];  // invalid index → no neighbors

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

/* detectAnyClash: scan all basic blooming pairs aligned with LOS and test clash */
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

/* ----- Arrange validation -------------------------------------------------- */

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
 * - You CANNOT pass through occupied intersections (including the final dest).
 * - You MAY pass through “wrong-color” gardens; only the FINAL
 *   destination’s garden color must be legal for the tile.
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

    // Cannot pass THROUGH any occupied intersection (including final).
    const occupant = board.getAtIndex(idx);
    if (occupant) {
      return { ok: false, reason: `blocked at intermediate ${idx}` };
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

/* ----- Harmony graph & rings ---------------------------------------------- */

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

      const aC = coordsOf(aIdx1 - 1), bC = coordsOf(bIdx1 - 1); // coords need 0-based
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
