// move.ts
// Move validation, clash detection, harmony graph and ring detection.

import { isHarmonyActivePair } from "./rules";
import { generateValidPoints, coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor, isClashPair, harmoniousPair, ownerHasBloomingLotus, getGardenType, isGateCoord } from "./rules";

/* Utility to compute orthogonal neighbors (if valid intersection). */
function orthogonalNeighborsIdx(idx: number): number[] {
  const { x, y } = coordsOf(idx);
  const candidates = [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 }
  ];
  const out: number[] = [];
  for (const c of candidates) {
    try {
      const i = indexOf(c.x, c.y);
      out.push(i);
    } catch {
      // skip invalid
    }
  }
  return out;
}

/* lineOfSightClear: true if orthogonal straight segment from a to b has no pieces and no gates between them */
export function lineOfSightClear(board: Board, aIdx: number, bIdx: number): boolean {
  const a = coordsOf(aIdx), b = coordsOf(bIdx);
  if (a.x !== b.x && a.y !== b.y) return false;
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  let cx = a.x + dx, cy = a.y + dy;
  while (!(cx === b.x && cy === b.y)) {
    try {
      const idx = indexOf(cx, cy);
      const packed = board.getAtIndex(idx);
      if (packed) return false;
      if (isGateCoord(cx, cy)) return false;
    } catch {
      return false;
    }
    cx += dx; cy += dy;
  }
  return true;
}

/* detectAnyClash: scan all basic blooming pairs aligned with lineOfSight and test clash */
export function detectAnyClash(board: Board): boolean {
  const pts = generateValidPoints();
  for (let i = 0; i < pts.length; i++) {
    const aIdx = i + 1;
    const pA = getPieceDescriptor(board, aIdx);
    if (pA.kind !== "basic") continue;
    if (!pA.blooming) continue;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const bIdx = j + 1;
      const pB = getPieceDescriptor(board, bIdx);
      if (pB.kind !== "basic") continue;
      if (!pB.blooming) continue;
      // same axis?
      const aC = coordsOf(aIdx), bC = coordsOf(bIdx);
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      if (!lineOfSightClear(board, aIdx, bIdx)) continue;
      if (isClashPair(pA.garden, pA.number, pB.garden, pB.number)) return true;
    }
  }
  return false;
}

/* validateArrange: verify a path (list of indices) from fromIdx to a finalIdx */
export function validateArrange(board: Board, fromIdx: number, path: number[]): { ok: boolean, reason?: string } {
  if (path.length === 0) return { ok: false, reason: "empty path" };
  const packed = board.getAtIndex(fromIdx);
  if (!packed) return { ok: false, reason: "no piece at from index" };
  const decoded = unpackPiece(packed)!;
  if (![TypeId.R3, TypeId.R4, TypeId.R5, TypeId.W3, TypeId.W4, TypeId.W5, TypeId.Lotus, TypeId.Orchid].includes(decoded.type)) {
    return { ok: false, reason: "only flower tiles may arrange" };
  }

  // build piece descriptor to get movement limit
  const desc = getPieceDescriptor(board, fromIdx);
  let limit = 0;
  if (desc.kind === "basic") limit = desc.number;
  else if (desc.kind === "lotus") limit = 2;
  else if (desc.kind === "orchid") limit = 6;
  if (path.length > limit) return { ok: false, reason: `path too long: ${path.length} > ${limit}` };

  // step-by-step checks
  let prev = fromIdx;
  const seen = new Set<number>([fromIdx]);
  for (let i = 0; i < path.length; i++) {
    const cur = path[i];
    const { x: px, y: py } = coordsOf(prev);
    const { x: cx, y: cy } = coordsOf(cur);
    if (Math.abs(px - cx) + Math.abs(py - cy) !== 1) return { ok: false, reason: `non-orthogonal step at step ${i}` };
    // cannot revisit same square in a path (redundant)
    if (seen.has(cur)) return { ok: false, reason: "path revisits a square (redundant)" };
    seen.add(cur);
    const occ = board.getAtIndex(cur);
    const isFinal = (i === path.length - 1);
    if (occ && !isFinal) return { ok: false, reason: `blocked at intermediate ${cur}` };
    if (isFinal && isGateCoord(cx, cy)) return { ok: false, reason: "cannot end move in a gate" };
    // garden landing checks for basic
    if (isFinal && desc.kind === "basic") {
      const g = getGardenType(cx, cy);
      if (g === "red" && desc.garden === "W") return { ok: false, reason: "cannot end in opposite garden (red)" };
      if (g === "white" && desc.garden === "R") return { ok: false, reason: "cannot end in opposite garden (white)" };
    }
    prev = cur;
  }

  // simulate final board and check clash
  const finalIdx = path[path.length - 1];
  const simulated = board.clone();
  const destPacked = simulated.getAtIndex(finalIdx);
  // remove source
  simulated.setAtIndex(fromIdx, 0);
  // remove captured (if any)
  if (destPacked) simulated.setAtIndex(finalIdx, 0);
  // place mover
  simulated.setAtIndex(finalIdx, packed);

  if (detectAnyClash(simulated)) return { ok: false, reason: "move would create a Clash" };

  return { ok: true };
}

/* Build harmony graph and detect rings.
   Simple implementation:
   - Nodes are indices of blooming basic tiles;
   - Edges between two nodes if same axis, lineOfSightClear, and harmoniousPair OR if one endpoint is a White Lotus (owner of basic gets the harmony).
*/
export function buildHarmonyGraph(board: Board): Map<number, number[]> {
  const pts = generateValidPoints();
  const nodeIdxs: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const idx = i + 1;
    const p = getPieceDescriptor(board, idx);
    if (p.kind === "basic" && p.blooming) nodeIdxs.push(idx);
  }

  const graph = new Map<number, number[]>();
  for (let i = 0; i < nodeIdxs.length; i++) {
    for (let j = i + 1; j < nodeIdxs.length; j++) {
      const aIdx = nodeIdxs[i], bIdx = nodeIdxs[j];
      const a = getPieceDescriptor(board, aIdx) as any;
      const b = getPieceDescriptor(board, bIdx) as any;
      const aC = coordsOf(aIdx), bC = coordsOf(bIdx);
      if (aC.x !== bC.x && aC.y !== bC.y) continue;
      if (!lineOfSightClear(board, aIdx, bIdx)) continue;
      // NOTE: aIdx/bIdx should be the same indexing you use for Board.getAtIndex.
// If elsewhere in this function you call board.getAtIndex(aIdx), they're 1-based.
// If they are 0-based, use (aIdx+1) / (bIdx+1) below instead.

const aGarden = a.garden as ("R" | "W");
const bGarden = b.garden as ("R" | "W");
const aNum = a.number as (3 | 4 | 5);
const bNum = b.number as (3 | 4 | 5);

const aIndexForBoard = aIdx; // or aIdx + 1 if your board uses 1-based here
const bIndexForBoard = bIdx; // or bIdx + 1 if your board uses 1-based here

if (isHarmonyActivePair(board, aIndexForBoard, bIndexForBoard, aGarden, aNum, bGarden, bNum)) {
  graph.set(aIdx, (graph.get(aIdx) || []).concat(bIdx));
  graph.set(bIdx, (graph.get(bIdx) || []).concat(aIdx));
} else {
  // Lotus interactions (lotus harmonizes with any basic) — handled elsewhere when lotus present.
  // TODO: add lotus edges if a lotus owned by someone participates on the same axis.
}
    }
  }
  return graph;
}

/* Basic cycle detection + polygon test for center inclusion (0,0)
   For simplicity we'll look for simple cycles (via DFS), build their ordered polygon using coords in traversal order,
   and run ray-casting for (0,0). This will detect rings that are closed and contain the origin.
*/
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
        const key = cycle.slice().sort((a,b)=>a-b).join(",");
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
  const pts = cycle.map(i => coordsOf(i));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > 0) !== (yj > 0)) && (0 < (xj - xi) * (0 - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
