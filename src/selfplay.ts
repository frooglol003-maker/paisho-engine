// src/selfplay.ts
// Engine self-play + on-the-fly learning + rough Pai Sho-style notation.
//
// Usage (after build):
//   npm run build
//   node dist/selfplay.js --games 5 --depth 3 --maxMs 500
//
// What it does:
//   - Runs N self-play games using your engine + current rules.
//   - Prints each game in a Pai Sho–like notation.
//   - Learns linear eval weights from ALL positions in those games
//     (same features as learn.ts) and prints the new WEIGHTS block
//     you can paste into eval.ts.
//
// NOTE: Because we don't see parse.ts here, notation is focused on
//       Arrange + Boat Accent moves; Wheel / Boat Flower are printed
//       in a readable but not yet "official" notation form.

import * as fs from "fs";
import { Board } from "./board";
import { coordsOf } from "./coords";
import { generateLegalArrangeMoves, Side, EngineMove, pickBestMove, applyEngineMove } from "./engine";
import { unpackPiece, TypeId } from "./board";

// For CLI detection
declare const require: any;

// ---------------- Feature extraction (copied / adapted from learn.ts) ----------------

type Features = {
  materialDiff: number;
  harmonyDegDiff: number;
  centerDiff: number;
  mobilityDiff: number;
};

type Vec = number[];
type Mat = number[][];

// If you later want full harmony + material feature parity with learn.ts,
// you can refactor those helpers into a shared module; here we keep a
// simplified but compatible version.

import { buildHarmonyGraph } from "./move";

function material(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0,
    guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const val =
      d.type === TypeId.R3 || d.type === TypeId.W3
        ? 3
        : d.type === TypeId.R4 || d.type === TypeId.W4
        ? 4
        : d.type === TypeId.R5 || d.type === TypeId.W5
        ? 5
        : d.type === TypeId.Lotus
        ? 7
        : d.type === TypeId.Orchid
        ? 6
        : 0;
    if (d.owner === 0) host += val;
    else guest += val;
  }
  return { host, guest };
}

function harmonyDeg(board: Board): { host: number; guest: number } {
  const g = buildHarmonyGraph(board);
  let host = 0,
    guest = 0;
  for (const [node, neighbors] of g) {
    const p = board.getAtIndex(node);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner === 0) host += neighbors.length;
    else guest += neighbors.length;
  }
  return { host, guest };
}

function centerCount(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0,
    guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const { x, y } = coordsOf(i - 1);
    const isCenter = Math.abs(x) + Math.abs(y) <= 3;
    if (!isCenter) continue;
    if (d.owner === 0) host++;
    else guest++;
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

// -------- Ridge regression (same idea as learn.ts) --------

function transpose(A: Mat): Mat {
  const m = A.length,
    n = A[0].length;
  const T: Mat = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}

function mul(A: Mat, B: Mat): Mat {
  const m = A.length,
    n = B[0].length,
    p = B.length;
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
  const m = A.length,
    n = A[0].length;
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

// Simple symmetric matrix inverse via Gauss-Jordan (OK for tiny feature sets)
function invSymmetric(M: Mat): Mat {
  const n = M.length;
  const A: Mat = M.map((r) => r.slice());
  const I: Mat = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  for (let i = 0; i < n; i++) {
    let maxR = i,
      maxV = Math.abs(A[i][i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(A[r][i]);
      if (v > maxV) {
        maxV = v;
        maxR = r;
      }
    }
    if (maxV < 1e-12) throw new Error("Matrix near-singular in ridge");
    if (maxR !== i) {
      [A[i], A[maxR]] = [A[maxR], A[i]];
      [I[i], I[maxR]] = [I[maxR], I[i]];
    }
    const piv = A[i][i];
    for (let j = 0; j < n; j++) {
      A[i][j] /= piv;
      I[i][j] /= piv;
    }
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) {
        A[r][j] -= f * A[i][j];
        I[r][j] -= f * I[i][j];
      }
    }
  }
  return I;
}

function ridge(X: Mat, y: Vec, lambda = 1e-3): Vec {
  const XT = transpose(X);
  const XTX = mul(XT, X);
  const k = XTX.length;
  for (let i = 0; i < k; i++) XTX[i][i] += lambda;
  const XTy = mulVec(XT, y);
  const XTXinv = invSymmetric(XTX);
  return mulVec(XTXinv, XTy);
}

// Map final game result (from host POV) to training target.
// Here we'll simply say:
//   host win  -> +1
//   guest win -> -1
//   draw      -> 0
function resultToScoreFromHost(finalScoreHost: number): number {
  if (finalScoreHost > 0) return +1;
  if (finalScoreHost < 0) return -1;
  return 0;
}

// ----------------- Notation helpers -----------------

function sideShort(side: Side): "H" | "G" {
  return side === "host" ? "H" : "G";
}

// Convert index1 (1-based) into (x,y)
function idx1ToXY(idx1: number): { x: number; y: number } {
  const { x, y } = coordsOf(idx1 - 1);
  return { x, y };
}

/**
 * Convert a single engine move into a Pai Sho–style notation line.
 *
 * NOTE:
 * - Arrange uses:   (x1,y1)-(x2,y2)
 * - Boat accent uses: B(boatX,boatY)-(targetX,targetY)
 * - Wheel & BoatFlower use ad-hoc comment-y formats for now,
 *   since parseNotation.ts doesn't define them yet.
 */
function formatMoveNotation(ply: number, side: Side, mv: EngineMove): string {
  const s = sideShort(side);
  switch (mv.kind) {
    case "arrange": {
      const from = idx1ToXY(mv.from);
      const to = idx1ToXY(mv.path[mv.path.length - 1]);
      return `${ply}${s}.(${from.x},${from.y})-(${to.x},${to.y})`;
    }
    case "boatAccent": {
      const boat = idx1ToXY(mv.boat);
      const target = idx1ToXY(mv.target);
      // In your handwritten notation this would normally be a +B(...) accent
      // after an arrange. Since the engine treats it as its own move, we
      // surface it directly here.
      return `${ply}${s}.B(${boat.x},${boat.y})-(${target.x},${target.y})`;
    }
    case "wheel": {
      const c = idx1ToXY(mv.center);
      return `${ply}${s}.;WHEEL(${c.x},${c.y})`; // semi-colon = comment-ish
    }
    case "boatFlower": {
      const b = idx1ToXY(mv.boat);
      const from = idx1ToXY(mv.from);
      const to = idx1ToXY(mv.to);
      return `${ply}${s}.;BFL(${b.x},${b.y}):(${from.x},${from.y})->(${to.x},${to.y})`;
    }
  }
}

// ----------------- Self-play core -----------------

interface SelfPlayPositionSample {
  features: Features;
  // final result from host POV for this game
  resultHost: number;
}

interface SelfPlayGameRecord {
  id: string;
  notationLines: string[];
  finalScoreHost: number;
}

export function playSingleSelfPlayGame(
  gameId: string,
  opts: { maxPlies?: number; depth?: number; maxMsPerMove?: number } = {}
): { game: SelfPlayGameRecord; samples: SelfPlayPositionSample[] } {
  const maxPlies = opts.maxPlies ?? 200;
  const depth = opts.depth ?? 3;

  let board = new Board(); // if you have a custom setup, inject it instead
  let side: Side = "host";
  const notationLines: string[] = [];

  // We'll store features for EACH position before a move,
  // then label them with the final result at the end.
  const positions: Features[] = [];

  let ply = 1;

  while (ply <= maxPlies) {
    const mv = pickBestMove(board, side, depth, {
      maxMs: opts.maxMsPerMove,
    });

    if (!mv) break; // no legal move → terminal (from engine's POV)

    // Record features BEFORE the move
    const f = extractFeatures(board);
    positions.push(f);

    // Convert the move to notation
    const line = formatMoveNotation(ply, side, mv);
    notationLines.push(line);

    // Apply the move
    board = applyEngineMove(board, side, mv);

    // Next side
    side = side === "host" ? "guest" : "host";
    ply++;
  }

  // Final score from host POV: we derive winner & label from this.
  // You can change this if you prefer a non-eval-based game-end.
  const finalScoreHost = 0; // default if you don't want eval here

  // If you prefer to use eval(board,"host"), uncomment this and
  // import evaluate from "./eval":
  // import { evaluate } from "./eval";
  // const finalScoreHost = evaluate(board, "host");

  const resHost = resultToScoreFromHost(finalScoreHost);

  const samples: SelfPlayPositionSample[] = positions.map((feat) => ({
    features: feat,
    resultHost: resHost,
  }));

  const game: SelfPlayGameRecord = {
    id: gameId,
    notationLines,
    finalScoreHost,
  };

  return { game, samples };
}

// ----------------- Batch + learning + CLI -----------------

function parseArgs(argv: string[]) {
  const out: Record<string, string | number | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      const num = Number(next);
      out[key] = isNaN(num) ? next : num;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const numGames = (args["games"] as number) ?? 3;
  const depth = (args["depth"] as number) ?? 3;
  const maxMsPerMove = (args["maxMs"] as number) || undefined;
  const maxPlies = (args["maxPlies"] as number) ?? 200;

  console.log(
    `Self-play: games=${numGames}, depth=${depth}, maxMsPerMove=${maxMsPerMove ?? "none"}, maxPlies=${maxPlies}`
  );

  const allSamples: SelfPlayPositionSample[] = [];
  const allGames: SelfPlayGameRecord[] = [];

  for (let g = 0; g < numGames; g++) {
    const gameId = `selfplay_${Date.now()}_${g}`;
    const { game, samples } = playSingleSelfPlayGame(gameId, {
      depth,
      maxMsPerMove,
      maxPlies,
    });

    allGames.push(game);
    allSamples.push(...samples);

    console.log(`\n=== Game ${g + 1}/${numGames} (id=${game.id}) ===\n`);
    for (const ln of game.notationLines) {
      console.log(ln);
    }
    console.log(`RESULT draw  (finalScoreHost=${game.finalScoreHost.toFixed(2)})`);
  }

  if (allSamples.length === 0) {
    console.log("\nNo samples collected (no moves?). Nothing to learn from.");
    return;
  }

  // Build X and y from allSamples
  const X: Mat = [];
  const y: Vec = [];
  for (const s of allSamples) {
    const f = s.features;
    X.push([f.materialDiff, f.harmonyDegDiff, f.centerDiff, f.mobilityDiff]);
    y.push(s.resultHost);
  }

  const w = ridge(X, y, 1e-3);
  const [wMat, wHar, wCtr, wMob] = w;

  console.log("\n---- Learned weights from self-play ----\n");
  console.log(`Samples used: ${X.length}`);
  console.log(
    `materialDiff: ${wMat.toFixed(6)}, harmonyDegDiff: ${wHar.toFixed(
      6
    )}, centerDiff: ${wCtr.toFixed(6)}, mobilityDiff: ${wMob.toFixed(6)}`
  );
  console.log("\n---- Paste this block into src/eval.ts (replace scoring section) ----\n");
  console.log(`// Learned from self-play (${X.length} samples)`);
  console.log(
    `const WEIGHTS = { materialDiff: ${wMat.toFixed(
      6
    )}, harmonyDegDiff: ${wHar.toFixed(6)}, centerDiff: ${wCtr.toFixed(
      6
    )}, mobilityDiff: ${wMob.toFixed(6)} };`
  );
  console.log(`
export function evaluate(board: Board, pov: "host" | "guest"): number {
  const m = (${material.toString()})(board);
  const h = (${harmonyDeg.toString()})(board);
  const c = (${centerCount.toString()})(board);
  const mo = (${mobility.toString()})(board);
  const f = {
    materialDiff: m.host - m.guest,
    harmonyDegDiff: h.host - h.guest,
    centerDiff: c.host - c.guest,
    mobilityDiff: mo.host - mo.guest,
  };

  const raw =
    WEIGHTS.materialDiff * f.materialDiff +
    WEIGHTS.harmonyDegDiff * f.harmonyDegDiff +
    WEIGHTS.centerDiff   * f.centerDiff +
    WEIGHTS.mobilityDiff * f.mobilityDiff;

  return pov === "host" ? raw : -raw;
}
`);
  console.log("---- end paste block ----\n");

  // "Weight delta" here is effectively just these numbers vs whatever
  // you currently have in eval.ts; you can subtract them by hand
  // or adjust this script later to read your old WEIGHTS.
}

if (require.main === module) {
  main().catch((e: any) => {
    console.error(e);
    process.exit(1);
  });
}
