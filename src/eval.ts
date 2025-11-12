// eval.ts
// A simple evaluation to use inside minimax. This is intentionally simple and tunable.
// Score is from the perspective of 'host' (positive => host leads).

import { Board, TypeId, unpackPiece } from "./board";
import { buildHarmonyGraph, findHarmonyRings } from "./move";

// Material values (tweak as needed)
const VAL_BASIC = 10; // each basic flower tile base value
const VAL_R3 = 10, VAL_R4 = 12, VAL_R5 = 14;
const VAL_W3 = 10, VAL_W4 = 12, VAL_W5 = 14;
const VAL_LOTUS = 8;
const VAL_ORCHID = 9;
const VAL_ACCENT = 6;

export function evaluate(board: Board): number {
  let score = 0;
  // material
  const size = board.toArray().length;
  for (let i = 1; i <= size; i++) {
    const packed = board.getAtIndex(i);
    if (!packed) continue;
    const p = unpackPiece(packed)!;
    const ownerSign = p.owner === 0 ? 1 : -1;
    switch (p.type) {
      case TypeId.R3: score += ownerSign * VAL_R3; break;
      case TypeId.R4: score += ownerSign * VAL_R4; break;
      case TypeId.R5: score += ownerSign * VAL_R5; break;
      case TypeId.W3: score += ownerSign * VAL_W3; break;
      case TypeId.W4: score += ownerSign * VAL_W4; break;
      case TypeId.W5: score += ownerSign * VAL_W5; break;
      case TypeId.Lotus: score += ownerSign * VAL_LOTUS; break;
      case TypeId.Orchid: score += ownerSign * VAL_ORCHID; break;
      case TypeId.Rock:
      case TypeId.Wheel:
      case TypeId.Boat:
      case TypeId.Knotweed:
        score += ownerSign * VAL_ACCENT; break;
    }
  }

  // harmony bonuses — count edges in harmony graph and give small bonus per harmony for owner
  try {
    const graph = buildHarmonyGraph(board);
    for (const [node, edges] of graph.entries()) {
      // each edge counted twice in adjacency list; account per-edge by half
      const descPacked = board.getAtIndex(node)!;
      const owner = unpackPiece(descPacked)!.owner;
      const ownerSign = owner === 0 ? 1 : -1;
      score += ownerSign * 0.5 * edges.length; // small bonus per adjacency
    }
  } catch {
    // ignore failures
  }

  // ring bonus/match end: big bonus if ring found
  try {
    const rings = findHarmonyRings(board);
    for (const ring of rings) {
      // approximate ring ownership by majority of nodes' owners
      let hostCount = 0, guestCount = 0;
      for (const idx of ring) {
        const p = unpackPiece(board.getAtIndex(idx)!)!;
        if (p.owner === 0) hostCount++; else guestCount++;
      }
      if (hostCount > guestCount) score += 200; else if (guestCount > hostCount) score -= 200; else score += 0;
    }
  } catch {
    // ignore
  }

  return score;
}
