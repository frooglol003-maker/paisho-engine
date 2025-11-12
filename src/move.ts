// src/move.ts
// Move validation, clash detection, harmony graph and ring detection.
// NOTE: Board indices are 1-based (1..249). coords/index helpers are 0-based (0..248).
// Always use (idx-1) when calling coordsOf(), and (indexOf(...) + 1) when calling board.getAtIndex().

import { generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import {
  getPieceDescriptor,
  isClashPair,
  harmoniousPair, // kept for clarity, but graph uses isHarmonyActivePair instead
  ownerHasBloomingLotus,
  getGardenType,
  isGateCoord,
  isHarmonyActivePair,
  isTrappedByOrchid,
} from "./rules";

/* Utility to compute orthogonal neighbors (returns 1-based indices). */
function orthogonalNeighborsIdx(idx1: number): number[] {
  const { x, y } = coordsOf(idx1 - 1); // convert to 0-based for coords
  const candidates = [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ];
  const out: number[] = [];
  for (const c of candidates) {
    const i0 = indexOf(c.x, c.y); // 0-based
    if (i0 !== -1) out.push(i0 + 1); // convert back to 1-based
  }
  return out;
}

/* lineOfSightClear: true if orthogonal straight segment from a to b has no pieces and no gates between them */
export function lineOfSightClear(board: Board, aIdx1: number, bIdx1: number): boolean {
  const a = coordsOf(aIdx1 - 1), b = coordsOf(bIdx1 - 1); // coords need 0-based
  if (a.x !== b.x && a.y !== b.y) return false;
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  let cx = a.x + dx, cy = a.y + dy;
  while (!(cx === b.x && cy === b.y)) {
    const mid0 = indexOf(cx, cy); // 0-based
    if (mid0 === -1) return false; // off board
    const packed = board.getAtIndex(mid0 + 1); // board is 1-based
    if (packed) return false;
    if (isGateCoord(cx, cy)) return false;
    cx += dx; cy += dy;
  }
  return true;
}

/* detectAnyClash: scan all basic blooming pairs aligned with LOS and test clash */
export function detectAnyClash(board: Board): boolean {
  const pts = generateValidPoints();
  for (let i = 0; i < pts.length; i++) {
    const aIdx1 = i + 1; // board index
    const pA = getPieceDescriptor(board, aIdx1);
    if (pA.kind !== "basic") continue;
    if (!pA.blooming) continue;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const bIdx1 = j + 1;
      const pB = getPieceDescriptor(board, bIdx1);
      if (pB.kind !== "basic") continue;
      if (!pB.blooming) continue;

      // same axis?
      const aC = coordsOf(aIdx1 - 1), bC = coordsOf(bIdx1 - 1);
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      if (!lineOfSightClear(board, aIdx1, bIdx1)) continue;
      if (isClashPair(pA.garden, pA.number, pB.garden, pB.number)) return true;
    }
  }
  return false;
}

/* validateArrange: verify a path (list of 1-based indices) from fromIdx1 to final */
export function validateArrange(
  board: Board,
  fromIdx1: number,
  path: number[]
): { ok: boolean; reason?: string } {
  if (path.length === 0) return { ok: false, reason: "empty path" };
  const packed = board.getAtIndex(fromIdx1);
  if (!packed) return { ok: false, reason: "no piece at from index" };
  const decoded = unpackPiece(packed)!;
  if (
    ![
      TypeId.R3,
      TypeId.R4,
      TypeId.R5,
      TypeId.W3,
      TypeId.W4,
      TypeId.W5,
      TypeId.Lotus,
      TypeId.Orchid,
    ].includes(decoded.type)
  ) {
    return { ok: false, reason: "only flower tiles may arrange" };
  }

  // Orchid trap: cannot move if trapped
  if (isTrappedByOrchid(board, fromIdx1)) {
    return { ok: false, reason: "source flower is trapped by enemy orchid" };
  }

  // build piece descriptor to get movement limit
  const desc = getPieceDescriptor(board, fromIdx1);
  let limit = 0;
  if (desc.kind === "basic") limit = desc.number;
  else if (desc.kind === "lotus") limit = 2;
  else if (desc.kind === "orchid") limit = 6;
  if (path.length > limit) return { ok: false, reason: `path too long: ${path.length} > ${limit}` };

  // step-by-step checks
  let prev1 = fromIdx1; // 1-based
  const seen = new Set<number>([fromIdx1]);
  for (let i = 0; i < path.length; i++) {
    const cur1 = path[i]; // 1-based
    const { x: px, y: py } = coordsOf(prev1 - 1);
    const { x: cx, y: cy } = coordsOf(cur1 - 1);
    if (Math.abs(px - cx) + Math.abs(py - cy) !== 1) {
      return { ok: false, reason: `non-orthogonal step at step ${i}` };
    }
    // cannot revisit same square in a path (redundant)
    if (seen.has(cur1)) return { ok: false, reason: "path revisits a square (redundant)" };
    seen.add(cur1);
    const occ = board.getAtIndex(cur1);
    const isFinal = i === path.length - 1;
    if (occ && !isFinal) return { ok: false, reason: `blocked at intermediate ${cur1}` };
    if (isFinal && isGateCoord(cx, cy)) return { ok: false, reason: "cannot end move in a gate" };
    // garden landing checks for basic
    if (isFinal && desc.kind === "basic") {
      const g = getGardenType(cx, cy);
      if (g === "red" && desc.garden === "W") return { ok: false, reason: "cannot end in opposite garden (red)" };
      if (g === "white" && desc.garden === "R") return { ok: false, reason: "cannot end in opposite garden (white)" };
    }
    prev1 = cur1;
  }

  // simulate final board and check clash
  const final1 = path[path.length - 1];
  const simulated = board.clone();
  const destPacked = simulated.getAtIndex(final1);
  // remove source
  simulated.setAtIndex(fromIdx1, 0);
  // remove captured (if any)
  if (destPacked) simulated.setAtIndex(final1, 0);
  // place mover
  simulated.setAtIndex(final1, packed);

  if (detectAnyClash(simulated)) return { ok: false, reason: "move would create a Clash" };

  return { ok: true };
}

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
    const intersect = ((yi > 0) !== (yj > 0)) &&
      (0 < (xj - xi) * (0 - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
