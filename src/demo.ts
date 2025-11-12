// src/demo.ts
import { performance } from "perf_hooks";
import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { pickBestMove, applyPlannedArrange, searchStats } from "./engine";
import { coordsOf, indexOf } from "./coords";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";

// ---------- CLI args ----------
function getArg(name: string, def?: string) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}
const SIDE = (getArg("side", "host")! as "host" | "guest");
const DEPTH = Math.max(1, parseInt(getArg("depth", "3")!, 10));
const TIME_MS = (() => {
  const v = getArg("time", "");
  return v ? Math.max(1, parseInt(v, 10)) : undefined;
})();
const SELFPLIES = Math.max(0, parseInt(getArg("selfplay", "0")!, 10));
const SCENARIO = (getArg("scenario", "small")! as "small" | "empty");

// ---------- Helpers ----------
function idx1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function setupSmallPosition(): Board {
  const b = new Board();
  // Host R3 at (0,0)
  b.setAtIndex(idx1(0, 0), packPiece(TypeId.R3, Owner.Host));
  // Guest W3 at (1,0)
  b.setAtIndex(idx1(1, 0), packPiece(TypeId.W3, Owner.Guest));
  // Extra host R4 at (0,1)
  b.setAtIndex(idx1(0, 1), packPiece(TypeId.R4, Owner.Host));
  return b;
}
function setupEmpty(): Board { return new Board(); }

function boardToAscii(b: Board): string {
  const lines: string[] = [];
  const widths = [9,11,13,15, 17,17,17,17,17,17,17,17,17, 15,13,11,9];
  let base = 1;
  for (let r = 0; r < widths.length; r++) {
    const w = widths[r];
    const pad = " ".repeat(17 - w);
    const cells: string[] = [];
    for (let c = 0; c < w; c++) {
      const idx = base + c;
      const p = b.getAtIndex(idx);
      if (!p) { cells.push("·"); continue; }
      const d = unpackPiece(p)!;
      const sym =
        d.type === TypeId.R3 ? "R3" :
        d.type === TypeId.R4 ? "R4" :
        d.type === TypeId.R5 ? "R5" :
        d.type === TypeId.W3 ? "W3" :
        d.type === TypeId.W4 ? "W4" :
        d.type === TypeId.W5 ? "W5" :
        d.type === TypeId.Lotus ? "L " :
        d.type === TypeId.Orchid ? "O " :
        d.type === TypeId.Rock ? "⛰ " :
        d.type === TypeId.Wheel ? "⟳ " :
        d.type === TypeId.Boat ? "⛵ " :
        d.type === TypeId.Knotweed ? "✣ " : "??";
      cells.push(sym.trim());
    }
    lines.push(pad + cells.join(" ") + pad);
    base += w;
  }
  return lines.join("\n");
}

function printMove(m: any) {
  if (!m) { console.log("Engine returned no move."); return; }
  if (m.kind === "arrange") {
    const fromXY = coordsOf(m.from - 1);
    const toXY = coordsOf(m.path[m.path.length - 1] - 1);
    console.log(`\n→ ARRANGE from ${JSON.stringify(fromXY)} -> ${JSON.stringify(toXY)} (steps=${m.path.length})`);
  } else if (m.kind === "wheel") {
    const at = coordsOf(m.center - 1);
    console.log(`\n→ WHEEL at ${JSON.stringify(at)}`);
  } else if (m.kind === "boatFlower") {
    const s = coordsOf(m.from - 1);
    const t = coordsOf(m.to - 1);
    console.log(`\n→ BOAT-FLOWER ${JSON.stringify(s)} -> ${JSON.stringify(t)} (boat @ idx1=${m.boat})`);
  } else if (m.kind === "boatAccent") {
    const t = coordsOf(m.target - 1);
    console.log(`\n→ BOAT-ACCENT remove accent @ ${JSON.stringify(t)} with boat idx1=${m.boat}`);
  } else {
    console.log("\n→", m);
  }
}

function applyAnyMove(board: Board, side: "host"|"guest", m: any): Board {
  switch (m.kind) {
    case "arrange":     return applyPlannedArrange(board, { from: m.from, path: m.path });
    case "wheel":       return applyWheel(board, side, m.center);
    case "boatFlower":  return applyBoatFlower(board, side, m.boat, m.from, m.to);
    case "boatAccent":  return applyBoatAccent(board, side, m.boat, m.target);
    default: throw new Error(`unknown move kind: ${m.kind}`);
  }
}

// ---------- Main ----------
async function main() {
  const board = (SCENARIO === "empty" ? setupEmpty() : setupSmallPosition());

  console.log(`Scenario: ${SCENARIO} | Side: ${SIDE} | Depth: ${DEPTH} | Time: ${TIME_MS ?? "∞"}ms | Self-play plies: ${SELFPLIES}`);
  console.log(boardToAscii(board));
  console.log("");

  // One search
  const t0 = performance.now();
  const move = pickBestMove(board, SIDE, DEPTH, TIME_MS ? { maxMs: TIME_MS } : undefined);
  const t1 = performance.now();
  printMove(move);
  console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
  try {
    console.log(`nodes=${searchStats.nodes.toLocaleString()} | ttHits=${searchStats.ttHits.toLocaleString()} | cutoffs=${searchStats.cutoffs.toLocaleString()}`);
  } catch { /* stats may not be exported */ }

  // Optional self-play
  let b = board;
  let side: "host" | "guest" = SIDE;
  for (let p = 0; p < SELFPLIES; p++) {
    const mv = pickBestMove(b, side, DEPTH, TIME_MS ? { maxMs: TIME_MS } : undefined);
    if (!mv) break;
    b = applyAnyMove(b, side, mv);
    side = side === "host" ? "guest" : "host";
  }

  if (SELFPLIES > 0) {
    console.log("\nFinal position after self-play:");
    console.log(boardToAscii(b));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
