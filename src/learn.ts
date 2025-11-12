// src/learn.ts
// Learn linear eval weights from high-ELO games (JSONL).
//
// Usage: npm run learn
//
// Reads: data/sample_games.jsonl
// Writes: (prints code block to paste into src/eval.ts)

import * as fs from "fs";
import { Board, unpackPiece, TypeId } from "./board";
import { coordsOf } from "./coords";
import { buildHarmonyGraph } from "./move";
import { generateLegalArrangeMoves, Side } from "./engine";
import { applySetup, applyAction, loadGames, GameRecord } from "./parse";

// ------- Feature extraction -------

type Features = {
  materialDiff: number;
  harmonyDegDiff: number;
  centerDiff: number;
  mobilityDiff: number;
};

function sideFromOwnerBit(ownerBit: 0 | 1): Side {
  return ownerBit === 0 ? "host" : "guest";
}

function material(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0, guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    // base piece values; accents=0 here—we’ll learn their effect via other features
    const val =
      d.type === TypeId.R3 || d.type === TypeId.W3 ? 3 :
      d.type === TypeId.R4 || d.type === TypeId.W4 ? 4 :
      d.type === TypeId.R5 || d.type === TypeId.W5 ? 5 :
      d.type === TypeId.Lotus ? 7 :
      d.type === TypeId.Orchid ? 6 : 0;
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

function extractFeatures(board: Board): Features {
  const m = material(board);
  const h = harmonyDeg(board);
  const c = centerCount(board);
  const mo = mobility(board);
  return {
    materialDiff: m.host - m.guest,
    harmonyDegDiff: h.host - h.guest,
    centerDiff: c.host - c.guest,
    mobilityDiff: mo.host - mo.guest,
  };
}

// ------- Regression (ridge) -------

type Vec = number[];
type Mat = number[][];

function ridge(X: Mat, y: Vec, lambda = 1e-3): Vec {
  // w = (X^T X + λI)^(-1) X^T y
  const XT = transpose(X);
  const XTX = mul(XT, X);
  const k = XTX.length;
  for (let i = 0; i < k; i++) XTX[i][i] += lambda;
  const XTy = mulVec(XT, y);
  const XTXinv = invSymmetric(XTX);
  return mulVec(XTXinv, XTy);
}

function transpose(A: Mat): Mat {
  const m = A.length, n = A[0].length;
  const T: Mat = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}

function mul(A: Mat, B: Mat): Mat {
  const m = A.length, n = B[0].length, p = B.length;
  const C: Mat = Array.from({ length: m }, () => Array(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < p; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}

function mulVec(A: Mat, v: Vec): Vec {
  const m = A.length, n = A[0].length;
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

// Simple symmetric matrix inverse via Gauss-Jordan (sufficient for small feature sets)
function invSymmetric(M: Mat): Mat {
  const n = M.length;
  const A: Mat = M.map(r => r.slice());
  const I: Mat = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  for (let i = 0; i < n; i++) {
    // pivot
    let maxR = i, maxV = Math.abs(A[i][i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(A[r][i]);
      if (v > maxV) { maxV = v; maxR = r; }
    }
    if (maxV < 1e-12) throw new Error("Matrix near-singular");
    if (maxR !== i) { [A[i], A[maxR]] = [A[maxR], A[i]]; [I[i], I[maxR]] = [I[maxR], I[i]]; }
    const piv = A[i][i];
    for (let j = 0; j < n; j++) { A[i][j] /= piv; I[i][j] /= piv; }
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) { A[r][j] -= f * A[i][j]; I[r][j] -= f * I[i][j]; }
    }
  }
  return I;
}

// ------- Learning driver -------

function resultToScore(res: "host" | "guest" | "draw"): number {
  return res === "host" ? +1 : res === "guest" ? -1 : 0;
}

async function main() {
  const path = "data/sample_games.jsonl";
  if (!fs.existsSync(path)) {
    console.error(`Missing ${path}. Create it with one JSON object per line. See the template I provided.`);
    process.exit(1);
  }
  const games = await loadGames(path);
  if (games.length === 0) {
    console.error("No games found in JSONL.");
    process.exit(1);
  }

  const X: Mat = [];
  const y: Vec = [];

  for (const g of games) {
    const finalScore = resultToScore(g.result);
    // Start from empty board each game
    let b = new Board();
    applySetup(b, g.setup);

    // For each ply: record features for side-to-move pre-move (credit assignment is crude but works)
    // Side alternates host, guest, host, ...
    let side: Side = "host";
    for (const action of g.moves) {
      // (Optional sanity) ensure action.side matches expected side; if not, trust the action
      try {
        // features before the move
        const f = extractFeatures(b);
        X.push([f.materialDiff, f.harmonyDegDiff, f.centerDiff, f.mobilityDiff]);
        y.push(finalScore);

        // apply move
        b = applyAction(b, action);
      } catch (e: any) {
        throw new Error(`Game ${g.id ?? "(no id)"}: failed to apply action ${JSON.stringify(action)}: ${e.message}`);
      }
      side = side === "host" ? "guest" : "host";
    }
  }

  // Fit ridge regression
  const w = ridge(X, y, 1e-3);
  const [wMat, wHar, wCtr, wMob] = w;

  // Print pasteable code for eval.ts
  console.log("\n---- Paste this block into src/eval.ts (replace the scoring section) ----\n");
  console.log(`// Learned weights from ${X.length} samples`);
  console.log(`const WEIGHTS = { materialDiff: ${wMat.toFixed(6)}, harmonyDegDiff: ${wHar.toFixed(6)}, centerDiff: ${wCtr.toFixed(6)}, mobilityDiff: ${wMob.toFixed(6)} };`);
  console.log(`
export function evaluate(board: Board, pov: "host" | "guest"): number {
  // Compute raw (host - guest) feature diffs, then flip by pov
  const f = (function(){
    const m = (${material.toString()})(board);
    const h = (${harmonyDeg.toString()})(board);
    const c = (${centerCount.toString()})(board);
    const mo = (${mobility.toString()})(board);
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
`);
  console.log("---- end paste block ----\n");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
