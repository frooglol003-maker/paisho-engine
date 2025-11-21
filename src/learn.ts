// src/learn.ts
// Learn linear eval weights from games.
// Two modes:
//
// 1) JSONL mode (default):
//    node dist/learn.js
//    -> reads data/sample_games.jsonl
//
// 2) Interactive notation mode:
//    node dist/learn.js --notation
//    -> prompts you to paste a single game in notation form,
//       parses it via parseNotation.ts, plays it through,
//       prints final board + learned weights block.

import * as fs from "fs";
import * as readline from "readline";
import { Board, unpackPiece, TypeId } from "./board";
import { coordsOf } from "./coords";
import { buildHarmonyGraph } from "./move";
import { generateLegalArrangeMoves, Side } from "./engine";
import { applySetup, applyAction, loadGames, GameRecord } from "./parse";

// For dynamic require without TS complaining
declare const require: any;

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

// ------- Result -> scalar -------

function resultToScore(res: "host" | "guest" | "draw"): number {
  return res === "host" ? +1 : res === "guest" ? -1 : 0;
}

// ------- Simple ASCII board renderer (final position) -------

function symPlain(type: TypeId): string {
  switch (type) {
    case TypeId.R3: return "R3";
    case TypeId.R4: return "R4";
    case TypeId.R5: return "R5";
    case TypeId.W3: return "W3";
    case TypeId.W4: return "W4";
    case TypeId.W5: return "W5";
    case TypeId.Lotus: return "L ";
    case TypeId.Orchid: return "O ";
    case TypeId.Rock: return "Ro";
    case TypeId.Wheel: return "Wh";
    case TypeId.Boat: return "Bo";
    case TypeId.Knotweed: return "Kn";
    default: return "· ";
  }
}

/**
 * Very simple ASCII diamond similar to play.ts, but no colors/sidebars.
 * Just enough to visually confirm final positions after learning.
 */
function renderBoardAscii(board: Board): string {
  const widths = [9,11,13,15, 17,17,17,17,17,17,17,17,17, 15,13,11,9];
  const rowStarts: number[] = [];
  let base = 1;
  for (let r = 0; r < widths.length; r++) {
    rowStarts[r] = base;
    base += widths[r];
  }

  const lines: string[] = [];
  for (let vr = 0; vr < widths.length; vr++) {
    const r = widths.length - 1 - vr;
    const w = widths[r];
    const rowBase = rowStarts[r];

    const padLeft = " ".repeat(17 - w);
    const cells: string[] = [];

    for (let c = 0; c < w; c++) {
      const idx = rowBase + c;
      const p = board.getAtIndex(idx);
      if (!p) {
        cells.push("· ");
      } else {
        const d = unpackPiece(p)!;
        const sym = symPlain(d.type);
        const owner = d.owner === 0 ? "H" : "G";
        cells.push(owner + sym);
      }
    }

    lines.push(padLeft + cells.join(" ") + padLeft);
  }
  return lines.join("\n");
}

// ------- JSONL learning (old behaviour) -------

async function mainFromJSONL() {
  const path = "data/sample_games.jsonl";
  if (!fs.existsSync(path)) {
    console.error(`Missing ${path}. Create it with one JSON object per line.`);
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
    let b = new Board();
    applySetup(b, g.setup);

    let side: Side = "host";
    for (const action of g.moves) {
      try {
        const f = extractFeatures(b);
        X.push([f.materialDiff, f.harmonyDegDiff, f.centerDiff, f.mobilityDiff]);
        y.push(finalScore);

        b = applyAction(b, action);
      } catch (e: any) {
        throw new Error(
          `Game ${g.id ?? "(no id)"}: failed to apply action ${JSON.stringify(action)}: ${
            e.message
          }`
        );
      }
      side = side === "host" ? "guest" : "host";
    }
  }

  const w = ridge(X, y, 1e-3);
  const [wMat, wHar, wCtr, wMob] = w;

  console.log("\n---- Paste this block into src/eval.ts (replace the scoring section) ----\n");
  console.log(`// Learned weights from ${X.length} samples`);
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
}

// ------- Interactive notation learning -------

async function mainFromNotation() {
  console.log("Interactive notation mode.");
  console.log("Paste a SINGLE game's notation (like your 0H./0G./1G... example).");
  console.log("When you're done, enter a line with just 'END' and press Enter.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];

  for await (const line of rl) {
    if (line.trim() === "END") break;
    lines.push(line);
  }
  rl.close();

  const text = lines.join("\n").trim();
  if (!text) {
    console.error("No notation provided.");
    process.exit(1);
  }

  // Dynamically load your notation parser
  const { parseNotationToGameRecord } = require("./parseNotation");
  const game: GameRecord = parseNotationToGameRecord(text);

  // Play game through on a Board and collect features
  const finalScore = resultToScore(game.result);
  const X: Mat = [];
  const y: Vec = [];

  let b = new Board();
  applySetup(b, game.setup);

  let side: Side = "host";
  for (const action of game.moves) {
    const f = extractFeatures(b);
    X.push([f.materialDiff, f.harmonyDegDiff, f.centerDiff, f.mobilityDiff]);
    y.push(finalScore);
    b = applyAction(b, action);
    side = side === "host" ? "guest" : "host";
  }

  console.log("\nFinal board position from this notation:\n");
  console.log(renderBoardAscii(b));
  console.log("\nLearning weights from THIS ONE GAME (toy training)…");

  const w = ridge(X, y, 1e-3);
  const [wMat, wHar, wCtr, wMob] = w;

  console.log("\n---- Paste this block into src/eval.ts (replace the scoring section) ----\n");
  console.log(`// Learned weights from ${X.length} samples (1 notation game)`);
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
}

// ------- entrypoint -------

async function main() {
  const args = process.argv.slice(2);
  const useNotation = args.includes("--notation");

  if (useNotation) {
    await mainFromNotation();
  } else {
    await mainFromJSONL();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
