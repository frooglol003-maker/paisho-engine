// src/eval.ts
// Simple evaluator for Pai Sho positions.

import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor } from "./rules";
import { coordsOf } from "./coords";
import { buildHarmonyGraph } from "./move";

export type Side = "host" | "guest";

const MATERIAL: Record<TypeId, number> = {
  [TypeId.R3]: 3,
  [TypeId.R4]: 4,
  [TypeId.R5]: 5,
  [TypeId.W3]: 3,
  [TypeId.W4]: 4,
  [TypeId.W5]: 5,
  [TypeId.Lotus]: 7,
  [TypeId.Orchid]: 6,
  [TypeId.Rock]: 0,
  [TypeId.Wheel]: 0,
  [TypeId.Boat]: 0,
  [TypeId.Knotweed]: 0,
};

function whoOwns(packed: number | null): Side | null {
  if (!packed) return null;
  const d = unpackPiece(packed)!;
  return d.owner === 0 ? "host" : "guest";
}

function pieceValue(t: TypeId): number {
  return MATERIAL[t] ?? 0;
}

function centerBonus(idx1: number): number {
  const { x, y } = coordsOf(idx1 - 1);
  return Math.abs(x) + Math.abs(y) <= 3 ? 1 : 0;
}

export function evaluate(board: Board, pov: Side): number {
  const N = (board as any).size1Based ?? 249;
  let hostScore = 0;
  let guestScore = 0;

  // Material + center presence
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const owner = d.owner === 0 ? "host" : "guest";
    const val = pieceValue(d.type) + centerBonus(i);
    if (owner === "host") hostScore += val; else guestScore += val;
  }

  // Harmony connectivity (degree sum)
  const g = buildHarmonyGraph(board); // already respects Rock/Knotweed via isHarmonyActivePair in move.ts
  for (const [node, neighbors] of g) {
    const owner = whoOwns(board.getAtIndex(node));
    if (!owner) continue;
    if (owner === "host") hostScore += neighbors.length;
    else guestScore += neighbors.length;
  }

  // POV score
  return pov === "host" ? hostScore - guestScore : guestScore - hostScore;
}
