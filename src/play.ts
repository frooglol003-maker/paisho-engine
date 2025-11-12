// src/play.ts
import readline from "readline";
import { performance } from "perf_hooks";

import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";
import { getGardenType, isGateCoord } from "./rules";

// ---------- CLI ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) return [m[1], m[2]];
    return [s.replace(/^--/, ""), true];
  })
);

type Side = "host" | "guest";
const HUMAN: Side  = (args.human === "guest" ? "guest" : "host");
const FIRST: Side  = (args.first === "guest" ? "guest" : "host");
const DEPTH        = Math.max(1, parseInt(String(args.depth ?? "3"), 10));
const TIMEMS       = args.time ? Math.max(1, parseInt(String(args.time), 10)) : undefined;

// ---------- Sanity check for engine-produced moves ----------
function isMoveSane(board: Board, mv: any): boolean {
  const N = (board as any).size1Based ?? 249;
  const inRange = (i: any) => Number.isInteger(i) && i >= 1 && i <= N;

  switch (mv?.kind) {
    case "arrange":
      if (!inRange(mv.from)) return false;
      if (!Array.isArray(mv.path) || mv.path.length === 0) return false;
      return mv.path.every(inRange);
    case "wheel":
      return inRange(mv.center);
    case "boatFlower":
      return inRange(mv.boat) && inRange(mv.from) && inRange(mv.to);
    case "boatAccent":
      return inRange(mv.boat) && inRange(mv.target);
    default:
      return false;
  }
}

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

// ------- ANSI color helpers (no deps) -------
const ESC   = (s: string) => `\u001b[${s}m`;
const RESET = ESC("0");
const BOLD  = ESC("1");
const DIM   = ESC("2");

// 256-color helpers: 38 for fg, 48 for bg
const FG = (n: number) => ESC(`38;5;${n}`);
const BG = (n: number) => ESC(`48;5;${n}`);

// Garden backgrounds (tweak to taste)
const BG_NEUTRAL = BG(236);   // dark grey
const BG_RED     = BG(52);    // deep red
const BG_WHITE   = BG(250);   // light grey
const BG_GATE    = BG(58);    // olive-ish to mark gates/midlines

// Piece colors
const FG_HOST  = FG(39);   // blue-ish
const FG_GUEST = FG(213);  // magenta-ish

function cellBg(x: number, y: number): string {
  if (x === 0 || y === 0) return BG_GATE; // midlines
  const g = getGardenType(x, y);
  if (g === "red") return BG_RED;
  if (g === "white") return BG_WHITE;
  return BG_NEUTRAL;
}

// Compact 2-char symbols (fixed width)
function symOf(type: TypeId): string {
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
    case TypeId.Boat: return "⛵";
    case TypeId.Knotweed: return "✣ ";
    default: return "· ";
  }
}

function ownerOfPacked(packed: number | null): Owner | null {
  if (!packed) return null;
  const d = unpackPiece(packed)!;
  return d.owner;
}

// ------- Counting / Pools -------
type CountMap = Record<string, number>;

const PIECE_KEYS: [TypeId, string][] = [
  [TypeId.R3, "R3"], [TypeId.R4, "R4"], [TypeId.R5, "R5"],
  [TypeId.W3, "W3"], [TypeId.W4, "W4"], [TypeId.W5, "W5"],
  [TypeId.Lotus, "Lotus"], [TypeId.Orchid, "Orchid"],
  [TypeId.Rock, "Rock"], [TypeId.Wheel, "Wheel"],
  [TypeId.Boat, "Boat"], [TypeId.Knotweed, "Knotweed"],
];

// Standard starting pool for BOTH players
const STANDARD_POOL: CountMap = {
  R3: 3, R4: 3, R5: 3,
  W3: 3, W4: 3, W5: 3,
  Lotus: 1, Orchid: 1,
  Rock: 1, Wheel: 1, Boat: 1, Knotweed: 1,
};

const POOL_DEFAULTS: { host: CountMap; guest: CountMap } = {
  host: { ...STANDARD_POOL },
  guest: { ...STANDARD_POOL },
};

function zeroCounts(): CountMap {
  const out: CountMap = {};
  for (const [, key] of PIECE_KEYS) out[key] = 0;
  return out;
}

function countsOnBoard(board: Board): { host: CountMap; guest: CountMap } {
  const host = zeroCounts();
  const guest = zeroCounts();
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const key = PIECE_KEYS.find(([tid]) => tid === d.type)?.[1]!;
    if (d.owner === Owner.Host) host[key] = (host[key] || 0) + 1;
    else guest[key] = (guest[key] || 0) + 1;
  }
  return { host, guest };
}

function minusCounts(a: CountMap, b: CountMap): CountMap {
  const out: CountMap = {};
  for (const [, key] of PIECE_KEYS) out[key] = (a[key] || 0) - (b[key] || 0);
  return out;
}

function countsToLines(label: string, m: CountMap, color: string): string[] {
  const rows: string[] = [];
  rows.push(`${BOLD}${color}${label}${RESET}`);
  for (const [, key] of PIECE_KEYS) {
    const v = m[key] ?? 0;
    if (v !== 0) rows.push(`${color}${key.padEnd(8)} ${BOLD}${String(v).padStart(2)}${RESET}`);
  }
  if (rows.length === 1) rows.push(`${DIM}(none)${RESET}`);
  return rows;
}

// ------- Rendering -------
function safeXY(idx1: number): string {
  try {
    if (!Number.isInteger(idx1) || idx1 < 1) return "<?>"; // 1-based guard
    const { x, y } = coordsOf(idx1 - 1);
    return `${x},${y}`;
  } catch {
    return "<?>"; // fall back if out of board
  }
}

function boardWithSidebar(board: Board): string {
  // ring widths for 17 rows
  const widths = [9,11,13,15, 17,17,17,17,17,17,17,17,17, 15,13,11,9];
  const lines: string[] = [];
  let base = 1;

  // Side panel content
  const onBoard = countsOnBoard(board);
  const hostOn  = countsToLines("HOST on board", onBoard.host, FG_HOST);
  const guestOn = countsToLines("GUEST on board", onBoard.guest, FG_GUEST);

  let hostRem: string[] = [];
  let guestRem: string[] = [];
  if (POOL_DEFAULTS) {
    const hostRemaining = minusCounts(POOL_DEFAULTS.host, onBoard.host);
    const guestRemaining = minusCounts(POOL_DEFAULTS.guest, onBoard.guest);
    hostRem = countsToLines("HOST remaining", hostRemaining, FG_HOST);
    guestRem = countsToLines("GUEST remaining", guestRemaining, FG_GUEST);
  }

  const sidebar: string[] = [];
  sidebar.push(...hostOn, "", ...guestOn);
  if (POOL_DEFAULTS) {
    sidebar.push("", `${DIM}Pools (remaining)${RESET}`, ...hostRem, "", ...guestRem);
  }

  const sidebarPad = "   ";
  let sideIdx = 0;

  for (let r = 0; r < widths.length; r++) {
    const w = widths[r];
    const padLeft = " ".repeat((17 - w));
    const cells: string[] = [];

    for (let c = 0; c < w; c++) {
      const idx = base + c;
      const p = board.getAtIndex(idx);
      const { x, y } = coordsOf(idx - 1);
      const bg = isGateCoord(x, y) ? BG_GATE : cellBg(x, y);

      if (!p) {
        cells.push(`${bg}${DIM}· ${RESET}`);
      } else {
        const d = unpackPiece(p)!;
        const fg = d.owner === Owner.Host ? FG_HOST : FG_GUEST;
        const sym = symOf(d.type);
        cells.push(`${bg}${fg}${BOLD}${sym}${RESET}`);
      }
    }

    const boardLine = padLeft + cells.join("") + padLeft;
    const sideLine  = sidebar[sideIdx] ?? "";
    lines.push(boardLine + sidebarPad + sideLine);
    sideIdx++;
    base += w;
  }

  return lines.join("\n");
}

function printMove(m: any) {
  if (!m) { console.log("Engine: no legal move."); return; }
  if (m.kind === "arrange") {
    const from = safeXY(m.from);
    const dest = Array.isArray(m.path) && m.path.length > 0 ? safeXY(m.path[m.path.length - 1]) : "<?>"
    console.log(`Engine → ARRANGE ${from} -> ${dest}${Array.isArray(m.path) ? ` (steps=${m.path.length})` : ""}`);
  } else if (m.kind === "wheel") {
    console.log(`Engine → WHEEL at ${safeXY(m.center)}`);
  } else if (m.kind === "boatFlower") {
    console.log(`Engine → BOAT-FLOWER ${safeXY(m.from)} -> ${safeXY(m.to)} (boat idx=${m.boat})`);
  } else if (m.kind === "boatAccent") {
    console.log(`Engine → BOAT-ACCENT target ${safeXY(m.target)} (boat idx=${m.boat})`);
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
  place TYPE OWNER x,y         manually place a piece
                               TYPE: R3 R4 R5 W3 W4 W5 Lotus Orchid Rock Wheel Boat Knotweed
                               OWNER: host | guest
  print                        redraw the board
  help                         show this help
  quit
`);
}

// ---------- Game loop ----------
async function main() {
  const b = new Board(); // start empty by default
  let toMove: Side = FIRST;

  console.log(`You are ${HUMAN}. ${FIRST} moves first. Depth=${DEPTH}${TIMEMS ? ` Time=${TIMEMS}ms` : ""}`);
  console.log(boardWithSidebar(b));
  help();

  // If engine is to move first
  if (toMove !== HUMAN) {
    const t0 = performance.now();
    const mv = pickBestMove(b, toMove, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
    const t1 = performance.now();
    printMove(mv);
    if (mv && isMoveSane(b, mv)) {
      const nb = applyAnyMove(b, toMove, mv);
      copyBoard(b, nb);
      toMove = other(toMove);
    }
    console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
    console.log(boardWithSidebar(b));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>(res => rl.question(q, res));

  while (true) {
    const line = (await ask(`${toMove === HUMAN ? "Your" : "Engine's"} turn [${toMove}] > `)).trim();
    if (!line) continue;
    if (line.toLowerCase() === "quit") break;
    if (line.toLowerCase() === "help") { help(); continue; }
    if (line.toLowerCase() === "print") { console.log(boardWithSidebar(b)); continue; }

    try {
      if (line.toLowerCase().startsWith("engine")) {
        const t0 = performance.now();
        const mv = pickBestMove(b, toMove, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
        const t1 = performance.now();

        if (!mv) {
          console.log("Engine: no move.");
        } else if (!isMoveSane(b, mv)) {
          console.log("Engine produced an invalid/unsane move (defensive check). Skipping.");
          printMove(mv);
        } else {
          printMove(mv);
          const nb = applyAnyMove(b, toMove, mv);
          copyBoard(b, nb);
          toMove = other(toMove);
        }

        console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
        console.log(boardWithSidebar(b));
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
        console.log(boardWithSidebar(b));
        continue;
      }

      if (line.toLowerCase().startsWith("wheel ")) {
        const cxy = xyFromString(line.slice(6).trim());
        const mv = { kind: "wheel", center: idx1(cxy.x, cxy.y) };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardWithSidebar(b));
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
        console.log(boardWithSidebar(b));
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
        console.log(boardWithSidebar(b));
        continue;
      }

      if (line.toLowerCase().startsWith("place ")) {
        // place TYPE OWNER x,y
        // e.g. place R3 host 0,0
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 4) throw new Error("Use: place TYPE OWNER x,y");
        const type = toTypeId(parts[1]);
        const owner = toOwner(parts[2]);
        const { x, y } = xyFromString(parts[3]);
        b.setAtIndex(idx1(x, y), packPiece(type, owner));
        console.log(boardWithSidebar(b));
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
