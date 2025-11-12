// src/eval.ts
// Simple evaluator for Pai Sho positions.

import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor } from "./rules";
import { coordsOf } from "./coords";
import { buildHarmonyGraph } from "./move";

// Local alias (do NOT export to avoid name clash with engine.ts)
type Pov = "host" | "guest";

const MATERIAL: Record<TypeId, number> = {
  [TypeId.Empty]: 0, // <-- needed for the full enum coverage
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

function whoOwns(packed: number | null): Pov | null {
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

export function evaluate(board: Board, pov: Pov): number {
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
  const g = buildHarmonyGraph(board); // respects Rock/Knotweed via isHarmonyActivePair in move.ts
  for (const [node, neighbors] of g) {
    const owner = whoOwns(board.getAtIndex(node));
    if (!owner) continue;
    if (owner === "host") hostScore += neighbors.length;
    else guestScore += neighbors.length;
  }

 // Learned weights from 1 samples
const WEIGHTS = { materialDiff: 0.000000, harmonyDegDiff: 0.000000, centerDiff: 0.000000, mobilityDiff: 0.000000 };

export function evaluate(board: Board, pov: "host" | "guest"): number {
  // Compute raw (host - guest) feature diffs, then flip by pov
  const f = (function(){
    const m = (function material(board) {
    const N = board.size1Based ?? 249;
    let host = 0, guest = 0;
    for (let i = 1; i <= N; i++) {
        const p = board.getAtIndex(i);
        if (!p)
            continue;
        const d = (0, board_1.unpackPiece)(p);
        // base piece values; accents=0 here—we’ll learn their effect via other features
        const val = d.type === board_1.TypeId.R3 || d.type === board_1.TypeId.W3 ? 3 :
            d.type === board_1.TypeId.R4 || d.type === board_1.TypeId.W4 ? 4 :
                d.type === board_1.TypeId.R5 || d.type === board_1.TypeId.W5 ? 5 :
                    d.type === board_1.TypeId.Lotus ? 7 :
                        d.type === board_1.TypeId.Orchid ? 6 : 0;
        if (d.owner === 0)
            host += val;
        else
            guest += val;
    }
    return { host, guest };
})(board);
    const h = (function harmonyDeg(board) {
    const g = (0, move_1.buildHarmonyGraph)(board);
    let host = 0, guest = 0;
    for (const [node, neighbors] of g) {
        const p = board.getAtIndex(node);
        if (!p)
            continue;
        const d = (0, board_1.unpackPiece)(p);
        if (d.owner === 0)
            host += neighbors.length;
        else
            guest += neighbors.length;
    }
    return { host, guest };
})(board);
    const c = (function centerCount(board) {
    const N = board.size1Based ?? 249;
    let host = 0, guest = 0;
    for (let i = 1; i <= N; i++) {
        const p = board.getAtIndex(i);
        if (!p)
            continue;
        const d = (0, board_1.unpackPiece)(p);
        const { x, y } = (0, coords_1.coordsOf)(i - 1);
        const isCenter = Math.abs(x) + Math.abs(y) <= 3;
        if (!isCenter)
            continue;
        if (d.owner === 0)
            host++;
        else
            guest++;
    }
    return { host, guest };
})(board);
    const mo = (function mobility(board) {
    const hostMoves = (0, engine_1.generateLegalArrangeMoves)(board, "host").length;
    const guestMoves = (0, engine_1.generateLegalArrangeMoves)(board, "guest").length;
    return { host: hostMoves, guest: guestMoves };
})(board);
    return {
      materialDiff: m.host - m.guest,
      harmonyDegDiff: h.host - h.guest,
      centerDiff: c.host - c.guest,
      mobilityDiff: mo.host - mo.guest,
    };
  })();

  const raw =
    WEIGHTS.materialDiff * f.materialDiff +
    WEIGHTS.harmonyDegDiff * f.harmonyDegDiff +
    WEIGHTS.centerDiff   * f.centerDiff +
    WEIGHTS.mobilityDiff * f.mobilityDiff;

  return pov === "host" ? raw : -raw;
}

