// src/eval.ts
// Position evaluator for Pai Sho. Compatible with current engine/rules.

import { Board, unpackPiece, TypeId } from "./board";
import { coordsOf } from "./coords";
import { buildHarmonyGraph } from "./move";
import { generateLegalArrangeMoves } from "./engine";

type Pov = "host" | "guest";

// If your TypeId enum includes Empty, keep it; otherwise remove that line.
const MATERIAL: Record<TypeId, number> = {
  [TypeId.Empty]: 0 as any, // remove if your enum doesn't have Empty
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

function pieceValue(t: TypeId): number {
  return MATERIAL[t] ?? 0;
}

function material(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0, guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const val = pieceValue(d.type);
    if (d.owner === 0) host += val; else guest += val;
  }
  return { host, guest };
}

function harmonyDeg(board: Board): { host: number; guest: number } {
  const g = buildHarmonyGraph(board);
  let host = 0, guest = 0;
  for (const [node, neighbors] of g) {
    const p = board.getAtIndex(node);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner === 0) host += neighbors.length; else guest += neighbors.length;
  }
  return { host, guest };
}

function centerCount(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0, guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const { x, y } = coordsOf(i - 1);
    const isCenter = Math.abs(x) + Math.abs(y) <= 3;
    if (!isCenter) continue;
    if (d.owner === 0) host++; else guest++;
  }
  return { host, guest };
}

function mobility(board: Board): { host: number; guest: number } {
  const hostMoves = generateLegalArrangeMoves(board, "host").length;
  const guestMoves = generateLegalArrangeMoves(board, "guest").length;
  return { host: hostMoves, guest: guestMoves };
}

/**
 * Learned weights: these are placeholders. After you run `npm run learn`,
 * paste the printed WEIGHTS block here to replace these numbers.
 */
const WEIGHTS = { 
  materialDiff: 7.977498, 
  harmonyDegDiff: 0.000000, 
  centerDiff: 0.000000, 
  mobilityDiff: -0.069078 
};

/**
 * Evaluate from POV: positive = good for pov.
 * We compute (host - guest) with features, then flip by pov.
 */
export function evaluate(board: Board, pov: Pov): number {
  const m = material(board);
  const h = harmonyDeg(board);
  const c = centerCount(board);
  const mo = mobility(board);

  const feats = {
    materialDiff: m.host - m.guest,
    harmonyDegDiff: h.host - h.guest,
    centerDiff: c.host - c.guest,
    mobilityDiff: mo.host - mo.guest,
  };

  const raw =
    WEIGHTS.materialDiff * feats.materialDiff +
    WEIGHTS.harmonyDegDiff * feats.harmonyDegDiff +
    WEIGHTS.centerDiff * feats.centerDiff +
    WEIGHTS.mobilityDiff * feats.mobilityDiff;

  return pov === "host" ? raw : -raw;
}
