// src/play.ts
import readline from "readline";
import { performance } from "perf_hooks";

import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";
import { getGardenType } from "./rules";

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

// ---------- Board geometry helpers ----------
const BOARD_RADIUS = 8; // 17 rows → y ∈ [-8..8], x ∈ [-8..8] where valid

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

// ---------- Pools & counting ----------
type CountMap = Record<string, number>;
const PIECE_KEYS: [TypeId, string][] = [
  [TypeId.R3, "R3"], [TypeId.R4, "R4"], [TypeId.R5, "R5"],
  [TypeId.W3, "W3"], [TypeId.W4, "W4"], [TypeId.W5, "W5"],
  [TypeId.Lotus, "Lotus"], [TypeId.Orchid, "Orchid"],
  [TypeId.Rock, "Rock"], [TypeId.Wheel, "Wheel"],
  [TypeId.Boat, "Boat"], [TypeId.Knotweed, "Knotweed"],
];

// Standard starting pool for BOTH players:
// R/W 3–5: 3 each; Lotus: 1; Orchid: 1; Accents: 1 each (Rock, Wheel, Boat, Knotweed)
const STANDARD_POOL: CountMap = {
  R3: 3, R4: 3, R5: 3,
  W3: 3, W4: 3, W5: 3,
  Lotus: 1, Orchid: 1,
  Rock: 1, Wheel: 1, Boat: 1, Knotweed: 1,
};

// Live pools (can be customized later)
const POOL: { host: CountMap; guest: CountMap } = {
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

// ---------- Opening: gates & plant logic ----------
const NORTH_GATE = { x: 0, y: +BOARD_RADIUS };
const SOUTH_GATE = { x: 0, y: -BOARD_RADIUS };
const EAST_GATE  = { x: +BOARD_RADIUS, y: 0 };
const WEST_GATE  = { x: -BOARD_RADIUS, y: 0 };

function gateFor(side: Side): { x: number; y: number } {
  // By your rule: guest plants in SOUTH, host mirrors in NORTH.
  return side === "guest" ? SOUTH_GATE : NORTH_GATE;
}

// Mirror placement for the other side (same type)
function mirrorGateFor(side: Side): { x: number; y: number } {
  return side === "guest" ? NORTH_GATE : SOUTH_GATE;
}

function isEmptyBoard(b: Board): boolean {
  const N = (b as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) if (b.getAtIndex(i)) return false;
  return true;
}

function plantOpening(b: Board, who: Side, type: TypeId) {
  const g = gateFor(who);
  const m = mirrorGateFor(who);
  const gi = idx1(g.x, g.y);
  const mi = idx1(m.x, m.y);

  if (b.getAtIndex(gi)) throw new Error(`Gate ${g.x},${g.y} occupied`);
  if (b.getAtIndex(mi)) throw new Error(`Mirror gate ${m.x},${m.y} occupied`);

  // place who at own gate
  b.setAtIndex(gi, packPiece(type, who === "host" ? Owner.Host : Owner.Guest));
  // mirror place opponent same type
  const otherOwner = who === "host" ? Owner.Guest : Owner.Host;
  b.setAtIndex(mi, packPiece(type, otherOwner));

  // adjust pools (one tile of that type from each side)
  const key = PIECE_KEYS.find(([tid]) => tid === type)![1];
  POOL.host[key] = Math.max(0, (POOL.host[key] ?? 0) - 1);
  POOL.guest[key] = Math.max(0, (POOL.guest[key] ?? 0) - 1);
}

// If engine is asked to move on an empty board, choose a first plant from pool.
function enginePickOpeningType(side: Side): TypeId | null {
  // Simple preference order; tune later with your learned weights
  const order = ["R3","W3","R4","W4","R5","W5","Lotus","Orchid"] as const;
  for (const k of order) {
    if ((POOL[side][k] ?? 0) > 0) return toTypeId(k);
  }
  return null;
}

// ---------- ANSI colors & rendering ----------
const ESC = (s: string) => `\u001b[${s}m`;
const RESET = ESC("0");
const BOLD = ESC("1");
const DIM = ESC("2");

const FG = (n: number) => ESC(`38;5;${n}`);
const BG = (n: number) => ESC(`48;5;${n}`);

// Palette tweaks to match your reference:
// - Neutral board (wood-ish brown)
// - Red/White gardens
// - Only the four gate intersections highlighted
const BG_NEUTRAL = BG(137);   // brown
const BG_RED     = BG(166);   // warm red
const BG_WHITE   = BG(230);   // light wood
const BG_GATE    = BG(58);    // olive diamond for the four gates
const BG_GRIDDOT = FG(240);   // faint dot overlay

const FG_HOST  = FG(39);   // blue-ish
const FG_GUEST = FG(213);  // magenta-ish

function isGatePoint(x: number, y: number): boolean {
  return (x === 0 && Math.abs(y) === BOARD_RADIUS) ||
         (y === 0 && Math.abs(x) === BOARD_RADIUS);
}

function cellBg(x: number, y: number): string {
  if (isGatePoint(x, y)) return BG_GATE;     // ONLY the four tips
  // midlines neutral, not gate-colored
  if (x === 0 || y === 0) return BG_NEUTRAL;

  const g = getGardenType(x, y);
  if (g === "red") return BG_RED;
  if (g === "white") return BG_WHITE;
  return BG_NEUTRAL;
}

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

function safeXY(idx1Val: number): string {
  try {
    if (!Number.isInteger(idx1Val) || idx1Val < 1) return "<?>"; // 1-based guard
    const xy = coordsOf(idx1Val - 1) as { x:number; y:number } | undefined;
    if (!xy) return "<?>"; 
    return `${xy.x},${xy.y}`;
  } catch {
    return "<?>"; 
  }
}
function countsToLines(label: string, m: CountMap, color: string): string[] {
  const rows: string[] = [];
  rows.push(`${BOLD}${color}${label}${RESET}`);
  let any = false;
  for (const [, key] of PIECE_KEYS) {
    const v = m[key] ?? 0;
    if (v !== 0) { any = true; rows.push(`${color}${key.padEnd(8)} ${BOLD}${String(v).padStart(2)}${RESET}`); }
  }
  if (!any) rows.push(`${DIM}(none)${RESET}`);
  return rows;
}

function boardWithSidebar(board: Board): string {
  const widths = [9,11,13,15, 17,17,17,17,17,17,17,17,17, 15,13,11,9];
  const lines: string[] = [];
  let base = 1;

  // Side panel
  const onBoard = countsOnBoard(board);
  const hostOn = countsToLines("HOST on board", onBoard.host, FG_HOST);
  const guestOn = countsToLines("GUEST on board", onBoard.guest, FG_GUEST);

  const hostRemaining = minusCounts(POOL.host, onBoard.host);
  const guestRemaining = minusCounts(POOL.guest, onBoard.guest);
  const hostRem = countsToLines("HOST remaining", hostRemaining, FG_HOST);
  const guestRem = countsToLines("GUEST remaining", guestRemaining, FG_GUEST);

  const sidebar: string[] = [];
  sidebar.push(...hostOn, "", ...guestOn, "", `${DIM}Pools (remaining)${RESET}`, ...hostRem, "", ...guestRem);

  const sidebarPad = "   ";
  let sideIdx = 0;

  for (let r = 0; r < widths.length; r++) {
    const w = widths[r];
    const padLeft = " ".repeat((17 - w));
    const cells: string[] = [];

    for (let c = 0; c < w; c++) {
  const idx = base + c;
  const p = board.getAtIndex(idx);

  // OLD (unsafe):
  // const { x, y } = coordsOf(idx - 1);

  // NEW (safe):
  const xy = coordsOf(idx - 1) as { x: number; y: number } | undefined;
  if (!xy) {
    // If the coords table doesn’t have this index, render a neutral cell and continue
    cells.push(`${BG_NEUTRAL}${DIM}· ${RESET}`);
    continue;
  }
  const { x, y } = xy;

  const bg = cellBg(x, y);
  if (!p) {
    cells.push(`${bg}${BG_GRIDDOT}· ${RESET}`);
  } else {
    const d = unpackPiece(p)!;
    const fg = d.owner === Owner.Host ? FG_HOST : FG_GUEST;
    const sym = symOf(d.type);
    cells.push(`${bg}${fg}${BOLD}${sym}${RESET}`);
  }
}
    const boardLine = padLeft + cells.join("") + padLeft;
    const sideLine = sidebar[sideIdx] ?? "";
    lines.push(boardLine + sidebarPad + sideLine);
    sideIdx++;
    base += w;
  }

  return lines.join("\n");
}

// ---------- Move helpers ----------
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

function copyBoard(dst: Board, src: Board) {
  const N = (src as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    dst.setAtIndex(i, src.getAtIndex(i) || 0);
  }
}

function help() {
  console.log(`
Commands:
  plant TYPE                   opening plant at your gate; mirrors opponent at opposite gate
                               TYPE: R3 R4 R5 W3 W4 W5 Lotus Orchid (accents rarely planted)
  engine [host|guest|me|other]  let engine move/plant (optionally pick side)
  arr x,y -> a,b; c,d; ...     arrange move with path
  wheel x,y                    rotate neighbors around wheel at x,y
  boatf boatX,boatY fromX,fromY -> toX,toY
  boata boatX,boatY targetX,targetY
  place TYPE OWNER x,y         force-place a tile (debug)
  print                        redraw the board
  help                         show this help
  quit
`);
}

// ---------- Main loop ----------
async function main() {
  const b = new Board(); // EMPTY START
  let toMove: Side = FIRST;

  console.log(`You are ${HUMAN}. ${FIRST} moves first. Depth=${DEPTH}${TIMEMS ? ` Time=${TIMEMS}ms` : ""}`);
  console.log(boardWithSidebar(b));
  help();

  // If engine is first (and the board is empty), auto-plant
  if (toMove !== HUMAN && isEmptyBoard(b)) {
    const t = enginePickOpeningType(toMove);
    if (t) plantOpening(b, toMove, t);
    console.log(boardWithSidebar(b));
    // Guest moves again after mirrored plant
    if (toMove === "guest") {
      // guest keeps the move
    } else {
      // host planted first (if configured), then guest to move
      toMove = "guest";
    }
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
      // Opening: plant command
      if (line.toLowerCase().startsWith("plant ")) {
        const typ = toTypeId(line.slice(6).trim());
        if (!isEmptyBoard(b) && (b.getAtIndex(idx1(gateFor(toMove).x, gateFor(toMove).y)) || b.getAtIndex(idx1(mirrorGateFor(toMove).x, mirrorGateFor(toMove).y)))) {
          console.log("Planting phase seems over; use moves instead.");
        } else {
          plantOpening(b, toMove, typ);
          console.log(boardWithSidebar(b));
          // By rule: guest moves again after mirrored plant
          if (toMove === "host") toMove = "guest"; // if host planted first (rare)
          // else guest retains move; do nothing
        }
        continue;
      }

     // Engine action (plant if opening, else search)
// Usage: "engine", "engine host", "engine guest", "engine me", "engine other"
const engMatch = line.toLowerCase().match(/^engine(?:\s+(host|guest|me|other))?$/);
if (engMatch) {
  const want = engMatch[1]; // may be undefined
  let sideToPlay: Side = toMove;

  if (want === "host" || want === "guest") {
    sideToPlay = want as Side;
  } else if (want === "me") {
    sideToPlay = HUMAN;
  } else if (want === "other") {
    sideToPlay = HUMAN === "host" ? "guest" : "host";
  }

  // If a specific side was requested and it's not the current turn, switch turns.
  if (sideToPlay !== toMove) {
    console.log(`(switching turn to ${sideToPlay})`);
    toMove = sideToPlay;
  }

  const t0 = performance.now();

  // Opening auto-plant if the board is empty
  if (isEmptyBoard(b)) {
    const t = enginePickOpeningType(toMove);
    if (t) {
      plantOpening(b, toMove, t);
      const t1 = performance.now();
      const g = gateFor(toMove);
      console.log(`Engine → PLANT ${TypeId[t]} at gate (${g.x},${g.y}) (mirrored)`);
      // Rule: if guest planted, guest keeps the move; if host planted, hand to guest
      if (toMove === "host") toMove = "guest";
      console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
      console.log(boardWithSidebar(b));
      continue;
    }
  }

  // Normal search
  const mv = pickBestMove(b, toMove, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
  const t1 = performance.now();

  if (!mv) {
    console.log("Engine: no move.");
  } else {
    printMove(mv);
    try {
      const nb = applyAnyMove(b, toMove, mv);
      copyBoard(b, nb);
      toMove = toMove === "host" ? "guest" : "host";
    } catch (e: any) {
      console.log(`Apply failed: ${e?.message ?? e}. Skipping.`);
    }
  }
  console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
  console.log(boardWithSidebar(b));
  continue;
}

      // Normal moves
      if (line.toLowerCase().startsWith("arr ")) {
        const m = line.slice(4).split("->");
        if (m.length !== 2) throw new Error("Use: arr x,y -> a,b; c,d; ...");
        const from = xyFromString(m[0].trim());
        const path = parsePathList(m[1].trim());
        const mv = { kind: "arrange", from: idx1(from.x, from.y), path };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = toMove === "host" ? "guest" : "host";
        console.log(boardWithSidebar(b));
        continue;
      }

      if (line.toLowerCase().startsWith("wheel ")) {
        const cxy = xyFromString(line.slice(6).trim());
        const mv = { kind: "wheel", center: idx1(cxy.x, cxy.y) };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = toMove === "host" ? "guest" : "host";
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
        toMove = toMove === "host" ? "guest" : "host";
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
        toMove = toMove === "host" ? "guest" : "host";
        console.log(boardWithSidebar(b));
        continue;
      }

      if (line.toLowerCase().startsWith("place ")) {
  // place TYPE OWNER x,y [next]
  // e.g. place R3 host 0,0 next   → also hands turn to the other side
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 5) throw new Error("Use: place TYPE OWNER x,y [next]");
  const type = toTypeId(parts[1]);
  const owner = toOwner(parts[2]);
  const { x, y } = xyFromString(parts[3]);
  const advance = (parts[4]?.toLowerCase() === "next");

  b.setAtIndex(idx1(x, y), packPiece(type, owner));
  console.log(boardWithSidebar(b));

  // If you placed for the current side, we usually want to pass the move.
  // Also allow explicit 'next' to force passing the move.
  const ownerSide: Side = owner === Owner.Host ? "host" : "guest";
  if (advance || ownerSide === toMove) {
    toMove = toMove === "host" ? "guest" : "host";
  }
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
main().catch(e => { console.error(e); process.exit(1); });
