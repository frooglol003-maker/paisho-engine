// src/play.ts
import readline from "readline";
import { performance } from "perf_hooks";
import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";

// ---------- CLI ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) return [m[1], m[2]];
    return [s.replace(/^--/, ""), true];
  })
);

type Side = "host" | "guest";
const HUMAN: Side = (args.human === "guest" ? "guest" : "host");
const FIRST: Side = (args.first === "guest" ? "guest" : "host");
const DEPTH = Math.max(1, parseInt(String(args.depth ?? "3"), 10));
const TIMEMS = args.time ? Math.max(1, parseInt(String(args.time), 10)) : undefined;

// ---------- Helpers ----------
function idx1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function xyFromString(s: string): { x: number; y: number } {
  const m = s.trim().match(/^(-?\d+)\s*,\s*(-?\d+)$/);
  if (!m) throw new Error(`Bad coord: "${s}" (use x,y)`);
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

function parsePathList(s: string): number[] {
  // "x1,y1; x2,y2; ..."
  const parts = s.split(";").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty path");
  return parts.map(p => {
    const { x, y } = xyFromString(p);
    return idx1(x, y);
  });
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
  if (!m) { console.log("Engine: no legal move."); return; }
  if (m.kind === "arrange") {
    const fromXY = coordsOf(m.from - 1);
    const toXY = coordsOf(m.path[m.path.length - 1] - 1);
    console.log(`Engine → ARRANGE ${fromXY.x},${fromXY.y} -> ${toXY.x},${toXY.y} (steps=${m.path.length})`);
  } else if (m.kind === "wheel") {
    const at = coordsOf(m.center - 1);
    console.log(`Engine → WHEEL at ${at.x},${at.y}`);
  } else if (m.kind === "boatFlower") {
    const s = coordsOf(m.from - 1);
    const t = coordsOf(m.to - 1);
    console.log(`Engine → BOAT-FLOWER ${s.x},${s.y} -> ${t.x},${t.y} (boat idx=${m.boat})`);
  } else if (m.kind === "boatAccent") {
    const t = coordsOf(m.target - 1);
    console.log(`Engine → BOAT-ACCENT target ${t.x},${t.y} (boat idx=${m.boat})`);
  } else {
    console.log("Engine →", m);
  }
}

function applyAnyMove(board: Board, side: Side, m: any): Board {
  switch (m.kind) {
    case "arrange":     return applyPlannedArrange(board, { from: m.from, path: m.path });
    case "wheel":       return applyWheel(board, side, m.center);
    case "boatFlower":  return applyBoatFlower(board, side, m.boat, m.from, m.to);
    case "boatAccent":  return applyBoatAccent(board, side, m.boat, m.target);
    default: throw new Error(`unknown move kind: ${m.kind}`);
  }
}

function help() {
  console.log(`
Commands:
  arr x,y -> a,b; c,d; ...     arrange move with path
  wheel x,y                    rotate neighbors around wheel at x,y
  boatf boatX,boatY fromX,fromY -> toX,toY
  boata boatX,boatY targetX,targetY
  engine                       let engine move now
  place type owner x,y         (optional) manually place a piece
                               type: R3 R4 R5 W3 W4 W5 Lotus Orchid Rock Wheel Boat Knotweed
                               owner: host | guest
  print                        redraw the board
  help                         show this help
  quit
`);
}

// ---------- Game loop ----------
async function main() {
  const b = new Board(); // EMPTY START
  let toMove: Side = FIRST;

  console.log(`You are ${HUMAN}. ${FIRST} moves first. Depth=${DEPTH}${TIMEMS ? ` Time=${TIMEMS}ms` : ""}`);
  console.log(boardToAscii(b));
  help();

  // If engine is to move first and human != first, let engine move
  if (toMove !== HUMAN) {
    const t0 = performance.now();
    const mv = pickBestMove(b, toMove, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
    const t1 = performance.now();
    printMove(mv);
    if (mv) {
      const nb = applyAnyMove(b, toMove, mv);
      copyBoard(b, nb);
      toMove = other(toMove);
    }
    console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
    console.log(boardToAscii(b));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>(res => rl.question(q, res));

  while (true) {
    const line = (await ask(`${toMove === HUMAN ? "Your" : "Engine's"} turn [${toMove}] > `)).trim();
    if (!line) continue;
    if (line.toLowerCase() === "quit") break;
    if (line.toLowerCase() === "help") { help(); continue; }
    if (line.toLowerCase() === "print") { console.log(boardToAscii(b)); continue; }

    try {
      if (line.toLowerCase().startsWith("engine")) {
        // force engine to move now
        const t0 = performance.now();
        const mv = pickBestMove(b, toMove, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
        const t1 = performance.now();
        printMove(mv);
        if (mv) {
          const nb = applyAnyMove(b, toMove, mv);
          copyBoard(b, nb);
          toMove = other(toMove);
        }
        console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
        console.log(boardToAscii(b));
        continue;
      }

      if (line.toLowerCase().startsWith("arr ")) {
        // arr x,y -> a,b; c,d; ...
        const m = line.slice(4).split("->");
        if (m.length !== 2) throw new Error("Use: arr x,y -> a,b; c,d; ...");
        const from = xyFromString(m[0].trim());
        const path = parsePathList(m[1].trim());
        const mv = { kind: "arrange", from: idx1(from.x, from.y), path };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardToAscii(b));
        continue;
      }

      if (line.toLowerCase().startsWith("wheel ")) {
        const cxy = xyFromString(line.slice(6).trim());
        const mv = { kind: "wheel", center: idx1(cxy.x, cxy.y) };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardToAscii(b));
        continue;
      }

      if (line.toLowerCase().startsWith("boatf ")) {
        // boatf boatX,boatY fromX,fromY -> toX,toY
        const body = line.slice(6);
        const [lhs, rhs] = body.split("->").map(s => s.trim());
        if (!lhs || !rhs) throw new Error("Use: boatf boatX,boatY fromX,fromY -> toX,toY");
        const [bxy, fxy] = lhs.split(/\s+/).map(s => s.trim());
        const boat = xyFromString(bxy);
        const from = xyFromString(fxy);
        const to   = xyFromString(rhs);
        const mv = {
          kind: "boatFlower",
          boat: idx1(boat.x, boat.y),
          from: idx1(from.x, from.y),
          to:   idx1(to.x, to.y)
        };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardToAscii(b));
        continue;
      }

      if (line.toLowerCase().startsWith("boata ")) {
        // boata boatX,boatY targetX,targetY
        const body = line.slice(6).trim();
        const [bxy, txy] = body.split(/\s+/).map(s => s.trim());
        if (!bxy || !txy) throw new Error("Use: boata boatX,boatY targetX,targetY");
        const boat = xyFromString(bxy);
        const targ = xyFromString(txy);
        const mv = {
          kind: "boatAccent",
          boat: idx1(boat.x, boat.y),
          target: idx1(targ.x, targ.y),
        };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardToAscii(b));
        continue;
      }

      if (line.toLowerCase().startsWith("place ")) {
        // place type owner x,y
        // e.g. place R3 host 0,0
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 4) throw new Error("Use: place TYPE OWNER x,y");
        const type = toTypeId(parts[1]);
        const owner = toOwner(parts[2]);
        const { x, y } = xyFromString(parts[3]);
        b.setAtIndex(idx1(x, y), packPiece(type, owner));
        console.log(boardToAscii(b));
        continue;
      }

      console.log("Unknown command. Type 'help'.");
    } catch (e: any) {
      console.log(`Error: ${e.message ?? e}`);
    }
  }

  rl.close();
  console.log("Bye!");
}

function other(s: Side): Side { return s === "host" ? "guest" : "host"; }

function copyBoard(dst: Board, src: Board) {
  const N = (src as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    dst.setAtIndex(i, src.getAtIndex(i) || 0);
  }
}

function toTypeId(name: string): TypeId {
  const n = name.toUpperCase();
  switch (n) {
    case "R3": return TypeId.R3;
    case "R4": return TypeId.R4;
    case "R5": return TypeId.R5;
    case "W3": return TypeId.W3;
    case "W4": return TypeId.W4;
    case "W5": return TypeId.W5;
    case "LOTUS": return TypeId.Lotus;
    case "ORCHID": return TypeId.Orchid;
    case "ROCK": return TypeId.Rock;
    case "WHEEL": return TypeId.Wheel;
    case "BOAT": return TypeId.Boat;
    case "KNOTWEED": return TypeId.Knotweed;
    default: throw new Error(`Unknown type: ${name}`);
  }
}

function toOwner(s: string): Owner {
  const v = s.toLowerCase();
  if (v === "host") return Owner.Host;
  if (v === "guest") return Owner.Guest;
  throw new Error(`Owner must be host|guest (got ${s})`);
}

main().catch(e => { console.error(e); process.exit(1); });
