// src/play.ts
import { performance } from "perf_hooks";
import * as readline from "readline";
import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { validateArrange } from "./move";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";

// ---- CLI args ----
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) return [m[1], m[2]];
    return [s.replace(/^--/, ""), true];
  })
);

const YOU = (args.you === "guest" ? "guest" : "host") as "host" | "guest";
const ENGINE = YOU === "host" ? "guest" : "host";
const DEPTH = Math.max(1, parseInt(String(args.depth ?? "3"), 10));
const TIMEMS = args.time ? Math.max(1, parseInt(String(args.time), 10)) : undefined;
const SCENARIO = (args.scenario ?? "small") as "small" | "empty";

// ---- helpers ----
function idx1FromXY(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function parseXY(tok: string): { x: number; y: number } {
  const m = tok.trim().match(/^(-?\d+)\s*,\s*(-?\d+)$/);
  if (!m) throw new Error(`bad XY "${tok}" (use like 0,1)`);
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

function setupSmall(): Board {
  const b = new Board();
  // Host R3 at (0,0)
  b.setAtIndex(idx1FromXY(0, 0), packPiece(TypeId.R3, Owner.Host));
  // Guest W3 at (1,0)
  b.setAtIndex(idx1FromXY(1, 0), packPiece(TypeId.W3, Owner.Guest));
  // Extra host R4 at (0,1)
  b.setAtIndex(idx1FromXY(0, 1), packPiece(TypeId.R4, Owner.Host));
  return b;
}

function setupEmpty(): Board {
  return new Board();
}

function symFor(type: TypeId): string {
  switch (type) {
    case TypeId.R3: return "R3";
    case TypeId.R4: return "R4";
    case TypeId.R5: return "R5";
    case TypeId.W3: return "W3";
    case TypeId.W4: return "W4";
    case TypeId.W5: return "W5";
    case TypeId.Lotus: return "L ";
    case TypeId.Orchid: return "O ";
    case TypeId.Rock: return "⛰ ";
    case TypeId.Wheel: return "⟳ ";
    case TypeId.Boat: return "⛵ ";
    case TypeId.Knotweed: return "✣ ";
    default: return "??";
  }
}

function boardToAscii(b: Board): string {
  const lines: string[] = [];
  const widths = [9,11,13,15, 17,17,17,17,17,17,17,17,17, 15,13,11,9];
  let base = 1;
  for (let r = 0; r < widths.length; r++) {
    const w = widths[r];
    const pad = " ".repeat((17 - w));
    const cells: string[] = [];
    for (let c = 0; c < w; c++) {
      const idx = base + c;
      const p = b.getAtIndex(idx);
      if (!p) { cells.push("·"); continue; }
      const d = unpackPiece(p)!;
      cells.push(symFor(d.type).trim());
    }
    lines.push(pad + cells.join(" ") + pad);
    base += w;
  }
  return lines.join("\n");
}

function printHeader(b: Board, side: "host"|"guest") {
  console.log("");
  console.log(`You are ${YOU}. Engine is ${ENGINE}. Depth=${DEPTH}${TIMEMS ? `, Time≈${TIMEMS}ms` : ""}`);
  console.log(`Side to move: ${side}`);
  console.log(boardToAscii(b));
  console.log("");
  console.log("Type 'help' for commands.");
}

type AnyMove =
  | { kind: "arrange"; from: number; path: number[] }
  | { kind: "wheel"; center: number }
  | { kind: "boatFlower"; boat: number; from: number; to: number }
  | { kind: "boatAccent"; boat: number; target: number };

function printMove(m: AnyMove) {
  if (m.kind === "arrange") {
    const fromXY = coordsOf(m.from - 1);
    const toXY = coordsOf(m.path[m.path.length - 1] - 1);
    console.log(`→ ARRANGE ${fromXY.x},${fromXY.y} -> ${toXY.x},${toXY.y} (${m.path.length} step(s))`);
  } else if (m.kind === "wheel") {
    const at = coordsOf(m.center - 1);
    console.log(`→ WHEEL at ${at.x},${at.y}`);
  } else if (m.kind === "boatFlower") {
    const s = coordsOf(m.from - 1);
    const t = coordsOf(m.to - 1);
    const b = coordsOf(m.boat - 1);
    console.log(`→ BOAT-FLOWER boat@${b.x},${b.y}: ${s.x},${s.y} -> ${t.x},${t.y}`);
  } else if (m.kind === "boatAccent") {
    const bt = coordsOf(m.boat - 1);
    const t = coordsOf(m.target - 1);
    console.log(`→ BOAT-ACCENT boat@${bt.x},${bt.y} remove ${t.x},${t.y}`);
  }
}

function applyAnyMove(board: Board, side: "host"|"guest", m: AnyMove): Board {
  switch (m.kind) {
    case "arrange":     return applyPlannedArrange(board, { from: m.from, path: m.path });
    case "wheel":       return applyWheel(board, side, m.center);
    case "boatFlower":  return applyBoatFlower(board, side, m.boat, m.from, m.to);
    case "boatAccent":  return applyBoatAccent(board, side, m.boat, m.target);
  }
}

// ---- interactive loop ----
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const q = (prompt: string) => new Promise<string>(res => rl.question(prompt, res));

  let board = (SCENARIO === "empty" ? setupEmpty() : setupSmall());
  let side: "host"|"guest" = "host";
  const history: { board: Board; side: "host"|"guest" }[] = [];

  console.log(`Interactive play — scenario=${SCENARIO}, you=${YOU}, depth=${DEPTH}${TIMEMS ? `, time=${TIMEMS}ms` : ""}`);
  printHeader(board, side);

  while (true) {
    // engine move
    if (side === ENGINE) {
      const t0 = performance.now();
      const mv = pickBestMove(board, side, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
      const t1 = performance.now();
      if (!mv) {
        console.log("Engine passes / no move found.");
        side = side === "host" ? "guest" : "host";
        continue;
      }
      printMove(mv as AnyMove);
      console.log(`engine time: ${((t1 - t0)/1000).toFixed(3)}s`);
      history.push({ board, side });
      board = applyAnyMove(board, side, mv as AnyMove);
      side = side === "host" ? "guest" : "host";
      printHeader(board, side);
      continue;
    }

    // your move
    const line = (await q(`${side}> `)).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(/\s+/);

    try {
      if (cmd === "quit" || cmd === "exit") { break; }

      if (cmd === "help") {
        console.log(`
Commands:
  arr X,Y [X,Y ...]        Arrange: first XY is from, rest are path squares
  wheel X,Y                Rotate wheel at center X,Y
  boatf Bx,By FromX,FromY ToX,ToY   Boat on flower
  boata Bx,By Tx,Ty       Boat on accent
  hint                     Engine suggests a move for your side
  show                     Reprint board
  undo                     Undo last move (if any)
  quit                     Exit
        `.trim());
        continue;
      }

      if (cmd === "show") {
        printHeader(board, side);
        continue;
      }

      if (cmd === "undo") {
        const last = history.pop();
        if (!last) { console.log("Nothing to undo."); continue; }
        board = last.board;
        side = last.side;
        printHeader(board, side);
        continue;
      }

      if (cmd === "hint") {
        const t0 = performance.now();
        const mv = pickBestMove(board, side, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
        const t1 = performance.now();
        if (!mv) console.log("No hint (no move).");
        else {
          printMove(mv as AnyMove);
          console.log(`hint time: ${((t1 - t0)/1000).toFixed(3)}s`);
        }
        continue;
      }

      if (cmd === "arr") {
        if (rest.length < 2) throw new Error("usage: arr FromX,FromY step1X,step1Y [step2X,step2Y ...]");
        const [fromTok, ...pathToks] = rest;
        const fromXY = parseXY(fromTok);
        const from = idx1FromXY(fromXY.x, fromXY.y);
        const path = pathToks.map(t => {
          const { x, y } = parseXY(t);
          return idx1FromXY(x, y);
        });
        const v = validateArrange(board, from, path);
        if (!v.ok) throw new Error(`arrange invalid: ${v.reason ?? "unknown"}`);
        const mv: AnyMove = { kind: "arrange", from, path };
        printMove(mv);
        history.push({ board, side });
        board = applyAnyMove(board, side, mv);
        side = side === "host" ? "guest" : "host";
        printHeader(board, side);
        continue;
      }

      if (cmd === "wheel") {
        if (rest.length !== 1) throw new Error("usage: wheel X,Y");
        const { x, y } = parseXY(rest[0]);
        const center = idx1FromXY(x, y);
        const mv: AnyMove = { kind: "wheel", center };
        // let parse/apply throw if illegal
        history.push({ board, side });
        board = applyAnyMove(board, side, mv);
        printMove(mv);
        side = side === "host" ? "guest" : "host";
        printHeader(board, side);
        continue;
      }

      if (cmd === "boatf") {
        if (rest.length !== 3) throw new Error("usage: boatf Bx,By FromX,FromY ToX,ToY");
        const b = idx1FromXY(...Object.values(parseXY(rest[0])) as [number, number]);
        const f = idx1FromXY(...Object.values(parseXY(rest[1])) as [number, number]);
        const t = idx1FromXY(...Object.values(parseXY(rest[2])) as [number, number]);
        const mv: AnyMove = { kind: "boatFlower", boat: b, from: f, to: t };
        history.push({ board, side });
        board = applyAnyMove(board, side, mv);
        printMove(mv);
        side = side === "host" ? "guest" : "host";
        printHeader(board, side);
        continue;
      }

      if (cmd === "boata") {
        if (rest.length !== 2) throw new Error("usage: boata Bx,By Tx,Ty");
        const b = idx1FromXY(...Object.values(parseXY(rest[0])) as [number, number]);
        const t = idx1FromXY(...Object.values(parseXY(rest[1])) as [number, number]);
        const mv: AnyMove = { kind: "boatAccent", boat: b, target: t };
        history.push({ board, side });
        board = applyAnyMove(board, side, mv);
        printMove(mv);
        side = side === "host" ? "guest" : "host";
        printHeader(board, side);
        continue;
      }

      console.log("Unknown command. Type 'help' for help.");
    } catch (e: any) {
      console.log(`⚠️ ${e.message ?? String(e)}`);
    }
  }

  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
