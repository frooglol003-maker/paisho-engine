// src/play.ts
import readline from "readline";
import { performance } from "perf_hooks";

import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";
import { validateArrange } from "./move";
import { getGardenType } from "./rules";   // <-- add this line

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
const BOARD_RADIUS = 8; // coords x,y ∈ [-8..8]

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

// Standard starting pool for BOTH players
const STANDARD_POOL: CountMap = {
  R3: 3, R4: 3, R5: 3,
  W3: 3, W4: 3, W5: 3,
  Lotus: 1, Orchid: 1,
  Rock: 1, Wheel: 1, Boat: 1, Knotweed: 1,
};

// Live pools
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

function isWhiteFlower(t: TypeId): boolean {
  return t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5;
}

function isRedFlower(t: TypeId): boolean {
  return t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5;
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

function gateFor(side: Side): { x: number; y: number } {
  // Guest plants in SOUTH, host in NORTH (canonical coords)
  return side === "guest" ? SOUTH_GATE : NORTH_GATE;
}

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

  b.setAtIndex(gi, packPiece(type, who === "host" ? Owner.Host : Owner.Guest));
  const otherOwner = who === "host" ? Owner.Guest : Owner.Host;
  b.setAtIndex(mi, packPiece(type, otherOwner));

  const key = PIECE_KEYS.find(([tid]) => tid === type)![1];
  POOL.host[key] = Math.max(0, (POOL.host[key] ?? 0) - 1);
  POOL.guest[key] = Math.max(0, (POOL.guest[key] ?? 0) - 1);
}

function enginePickOpeningType(side: Side): TypeId | null {
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

const FG_HOST  = FG(39);   // blue-ish
const FG_GUEST = FG(213);  // magenta-ish
const GRID_DOT = FG(240);  // faint dot color

const BG_NEUTRAL = BG(137); // brown
const BG_RED     = BG(166); // red
const BG_WHITE   = BG(230); // light wood
const BG_GATE    = BG(34);  // green

function isGatePoint(x: number, y: number): boolean {
  return (x === -8 && y === 0) ||
         (x ===  8 && y === 0) ||
         (x ===  0 && y === 8) ||
         (x ===  0 && y === -8);
}

// FINAL coloring formula (canonical coords)
function cellBg(x: number, y: number): string {
  // 1) midlines are brown (overridden for gates)
  if (x === 0 || y === 0) {
    return isGatePoint(x, y) ? BG_GATE : BG_NEUTRAL;
  }

  // 2) inner diamond
  const manhattan = Math.abs(x) + Math.abs(y);
  if (manhattan < 7) {
    const q1 = x > 0 && y > 0;
    const q3 = x < 0 && y < 0;
    if (q1 || q3) return BG_RED;   // quadrants 1 & 3
    return BG_WHITE;               // quadrants 2 & 4
  }

  // 3) outside diamond
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
    if (!Number.isInteger(idx1Val) || idx1Val < 1) return "<?>"; 
    const xy = coordsOf(idx1Val - 1) as { x: number; y: number } | undefined;
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
    if (v !== 0) {
      any = true;
      rows.push(`${color}${key.padEnd(8)} ${BOLD}${String(v).padStart(2)}${RESET}`);
    }
  }
  if (!any) rows.push(`${DIM}(none)${RESET}`);
  return rows;
}

// ---------- Board renderer (flipped so y=+8 is at top visually) ----------
function boardWithSidebar(board: Board): string {
  const widths = [9,11,13,15, 17,17,17,17,17,17,17,17,17, 15,13,11,9];
  const rowStarts: number[] = [];
  let base = 1;
  for (let r = 0; r < widths.length; r++) {
    rowStarts[r] = base;
    base += widths[r];
  }

  // Side panel data
  const onBoard = countsOnBoard(board);
  const hostOn = countsToLines("HOST on board", onBoard.host, FG_HOST);
  const guestOn = countsToLines("GUEST on board", onBoard.guest, FG_GUEST);

  const hostRemaining = minusCounts(POOL.host, onBoard.host);
  const guestRemaining = minusCounts(POOL.guest, onBoard.guest);
  const hostRem = countsToLines("HOST remaining", hostRemaining, FG_HOST);
  const guestRem = countsToLines("GUEST remaining", guestRemaining, FG_GUEST);

  const sidebar: string[] = [];
  sidebar.push(
    ...hostOn,
    "",
    ...guestOn,
    "",
    `${DIM}Pools (remaining)${RESET}`,
    ...hostRem,
    "",
    ...guestRem
  );

  const sidebarPad = "   ";
  const boardLines: string[] = [];

  // Flip vertically: start from highest-y row
  for (let vr = 0; vr < widths.length; vr++) {
    const r = widths.length - 1 - vr;
    const w = widths[r];
    const rowBase = rowStarts[r];

    const padLeft = " ".repeat(17 - w);
    const cells: string[] = [];

    for (let c = 0; c < w; c++) {
      const idx = rowBase + c;
      const p = board.getAtIndex(idx);
      const xy = coordsOf(idx - 1) as { x: number; y: number } | undefined;
      if (!xy) {
        cells.push(`${BG_NEUTRAL}${DIM}· ${RESET}`);
        continue;
      }
      const { x, y } = xy;
      const bg = cellBg(x, y);
      if (!p) {
        cells.push(`${bg}${GRID_DOT}· ${RESET}`);
      } else {
        const d = unpackPiece(p)!;
        const fg = d.owner === Owner.Host ? FG_HOST : FG_GUEST;
        const sym = symOf(d.type);
        cells.push(`${bg}${fg}${BOLD}${sym}${RESET}`);
      }
    }

    boardLines.push(padLeft + cells.join("") + padLeft);
  }

  const lines: string[] = [];
  for (let i = 0; i < widths.length; i++) {
    const sideLine = sidebar[i] ?? "";
    lines.push(boardLines[i] + sidebarPad + sideLine);
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

// ---------- Undo support ----------
type HistoryEntry = { cells: number[]; toMove: Side };
const history: HistoryEntry[] = [];

function snapshotBoard(src: Board): number[] {
  const N = (src as any).size1Based ?? 249;
  const arr = new Array<number>(N + 1);
  for (let i = 1; i <= N; i++) {
    arr[i] = src.getAtIndex(i) || 0;
  }
  return arr;
}

function restoreBoard(dst: Board, cells: number[]) {
  const N = (dst as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    dst.setAtIndex(i, cells[i] || 0);
  }
}

function pushHistory(board: Board, toMove: Side) {
  history.push({ cells: snapshotBoard(board), toMove });
}

// ---------- Misc helpers ----------
function help() {
  console.log(`
Commands:
  plant TYPE                   opening plant at your gate; mirrors opponent
                               TYPE: R3 R4 R5 W3 W4 W5 Lotus Orchid
  engine [host|guest|me|other] let engine move/plant (optionally pick side)
  arr x,y -> a,b; c,d; ...     arrange move with path
                               (with a single destination, path is auto-built)
  wheel x,y                    rotate neighbors around wheel at x,y
  boatf boatX,boatY fromX,fromY -> toX,toY
  boata boatX,boatY targetX,targetY
  place TYPE OWNER x,y [next]  force-place a tile; 'next' hands over move
  undo                         undo last move (engine or human)
  print                        redraw the board
  help                         show this help
  quit
`);
}

function other(side: Side): Side {
  return side === "host" ? "guest" : "host";
}

// ---------- Main loop ----------
async function main() {
  const b = new Board(); // EMPTY START
  let toMove: Side = FIRST;

  console.log(`You are ${HUMAN}. ${FIRST} moves first. Depth=${DEPTH}${TIMEMS ? ` Time=${TIMEMS}ms` : ""}`);
  console.log(boardWithSidebar(b));
  help();

  // If engine is first and board is empty, let it plant the opening
  if (toMove !== HUMAN && isEmptyBoard(b)) {
    const t = enginePickOpeningType(toMove);
    if (t) {
      pushHistory(b, toMove);
      plantOpening(b, toMove, t);
    }
    console.log(boardWithSidebar(b));
    if (toMove !== "guest") toMove = "guest"; // guest has second move
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>(res => rl.question(q, res));

  while (true) {
    const line = (await ask(`${toMove === HUMAN ? "Your" : "Engine's"} turn [${toMove}] > `)).trim();
    if (!line) continue;

    const lower = line.toLowerCase();
    if (lower === "quit") break;
    if (lower === "help") { help(); continue; }
    if (lower === "print") { console.log(boardWithSidebar(b)); continue; }

    // Undo
    if (lower === "undo") {
      const last = history.pop();
      if (!last) {
        console.log("Nothing to undo.");
      } else {
        restoreBoard(b, last.cells);
        toMove = last.toMove;
        console.log(boardWithSidebar(b));
      }
      continue;
    }

    try {
      // Opening: plant by hand
      if (lower.startsWith("plant ")) {
        const typ = toTypeId(line.slice(6).trim());
        const g = gateFor(toMove), m = mirrorGateFor(toMove);
        const gateOccupied = b.getAtIndex(idx1(g.x, g.y)) || b.getAtIndex(idx1(m.x, m.y));
        if (!isEmptyBoard(b) && gateOccupied) {
          console.log("Planting phase seems over; use moves instead.");
        } else {
          pushHistory(b, toMove);
          plantOpening(b, toMove, typ);
          console.log(boardWithSidebar(b));
          if (toMove === "host") toMove = "guest"; // guest gets the extra move
        }
        continue;
      }

      // Engine (plant if opening, else search)
      const engMatch = lower.match(/^engine(?:\s+(host|guest|me|other))?$/);
      if (engMatch) {
        const want = engMatch[1];
        let sideToPlay: Side = toMove;

        if (want === "host" || want === "guest") {
          sideToPlay = want as Side;
        } else if (want === "me") {
          sideToPlay = HUMAN;
        } else if (want === "other") {
          sideToPlay = HUMAN === "host" ? "guest" : "host";
        }

        if (sideToPlay !== toMove) {
          console.log(`(switching turn to ${sideToPlay})`);
          toMove = sideToPlay;
        }

        const t0 = performance.now();

        if (isEmptyBoard(b)) {
          const t = enginePickOpeningType(toMove);
          if (t) {
            pushHistory(b, toMove);
            plantOpening(b, toMove, t);
            const t1 = performance.now();
            const g = gateFor(toMove);
            console.log(`Engine → PLANT ${TypeId[t]} at gate (${g.x},${g.y}) (mirrored)`);
            if (toMove === "host") toMove = "guest";
            console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
            console.log(boardWithSidebar(b));
            continue;
          }
        }

        pushHistory(b, toMove);
        const mv = pickBestMove(b, toMove, DEPTH, TIMEMS ? { maxMs: TIMEMS } : undefined);
        const t1 = performance.now();

        if (!mv) {
          console.log("Engine: no move.");
          history.pop(); // no change
        } else {
          printMove(mv);
          try {
            const nb = applyAnyMove(b, toMove, mv);
            copyBoard(b, nb);
            toMove = other(toMove);
          } catch (e: any) {
            console.log(`Apply failed: ${e?.message ?? e}. Skipping.`);
            history.pop(); // rollback
          }
        }
        console.log(`search: ${((t1 - t0)/1000).toFixed(3)}s`);
        console.log(boardWithSidebar(b));
        continue;
      }

      // Arrange:
      // - If you give multiple waypoints, we use them literally.
      // - If you give a single destination, we auto-build a Manhattan path.
      //   We try H-then-V, and if that hits a block, we try V-then-H.
      if (lower.startsWith("arr ")) {
        const m = line.slice(4).split("->");
        if (m.length !== 2) throw new Error("Use: arr x,y -> a,b; c,d; ...");

        const fromCoord = xyFromString(m[0].trim());
        const fromIdx = idx1(fromCoord.x, fromCoord.y);

        const rhs = m[1].trim();
        const parts = rhs.split(";").map(p => p.trim()).filter(Boolean);
        if (parts.length === 0) throw new Error("Empty path");

        let pathIdx: number[] | null = null;
        let lastReason: string | undefined;

        if (parts.length === 1) {
          // --- single-destination QoL ---
          const dest = xyFromString(parts[0]);

          const tryOrder = (horizontalFirst: boolean) => {
            const coordPath: { x: number; y: number }[] = [];
            let x = fromCoord.x;
            let y = fromCoord.y;
            const dx = Math.sign(dest.x - fromCoord.x);
            const dy = Math.sign(dest.y - fromCoord.y);

            if (horizontalFirst) {
              while (x !== dest.x) {
                x += dx;
                coordPath.push({ x, y });
              }
              while (y !== dest.y) {
                y += dy;
                coordPath.push({ x, y });
              }
            } else {
              while (y !== dest.y) {
                y += dy;
                coordPath.push({ x, y });
              }
              while (x !== dest.x) {
                x += dx;
                coordPath.push({ x, y });
              }
            }

            const idxPath = coordPath.map(c => idx1(c.x, c.y));
            const res = validateArrange(b, fromIdx, idxPath);
            return { res, idxPath };
          };

          // Try horizontal-then-vertical first
          let attempt = tryOrder(true);
          if (attempt.res.ok) {
            pathIdx = attempt.idxPath;
          } else {
            lastReason = attempt.res.reason;
            // If blocked somewhere, try vertical-then-horizontal
            const attempt2 = tryOrder(false);
            if (attempt2.res.ok) {
              pathIdx = attempt2.idxPath;
            } else {
              // keep the second reason if the first was undefined
              if (!lastReason) lastReason = attempt2.res.reason;
            }
          }

          if (!pathIdx) {
            console.log(`Illegal arrange: ${lastReason ?? "invalid path"}`);
            continue;
          }
        } else {
          // --- literal multi-waypoint path ---
          const coords = parts.map(p => xyFromString(p));
          pathIdx = coords.map(({ x, y }) => idx1(x, y));
          const res = validateArrange(b, fromIdx, pathIdx);
          if (!res.ok) {
            console.log(`Illegal arrange: ${res.reason ?? "invalid path"}`);
            continue;
          }
        }
                // --- garden color legality: only final landing matters ---
        const lastIdx = pathIdx[pathIdx.length - 1];
        const lastXY  = coordsOf(lastIdx - 1);
        const garden  = getGardenType(lastXY.x, lastXY.y); // "red" | "white" | undefined

        const pieceVal = b.getAtIndex(fromIdx);
        if (!pieceVal) {
          console.log("Illegal arrange: no piece at source.");
          continue;
        }
        const piece = unpackPiece(pieceVal)!;

        if (isWhiteFlower(piece.type) && garden === "red") {
          console.log("Illegal arrange: white flowers cannot land in the red garden.");
          continue;
        }
        if (isRedFlower(piece.type) && garden === "white") {
          console.log("Illegal arrange: red flowers cannot land in the white garden.");
          continue;
        }

        pushHistory(b, toMove);
        const mv = { kind: "arrange", from: fromIdx, path: pathIdx };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardWithSidebar(b));
        continue;
      }

      // Wheel
      if (lower.startsWith("wheel ")) {
        const cxy = xyFromString(line.slice(6).trim());
        pushHistory(b, toMove);
        const mv = { kind: "wheel", center: idx1(cxy.x, cxy.y) };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardWithSidebar(b));
        continue;
      }

      // Boat on flower
      if (lower.startsWith("boatf ")) {
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
        pushHistory(b, toMove);
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardWithSidebar(b));
        continue;
      }

      // Boat on accent
      if (lower.startsWith("boata ")) {
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
        pushHistory(b, toMove);
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
        toMove = other(toMove);
        console.log(boardWithSidebar(b));
        continue;
      }

      // Force place (debug)
      if (lower.startsWith("place ")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts.length > 5) throw new Error("Use: place TYPE OWNER x,y [next]");
        const type = toTypeId(parts[1]);
        const owner = toOwner(parts[2]);
        const { x, y } = xyFromString(parts[3]);
        const advance = (parts[4]?.toLowerCase() === "next");

        pushHistory(b, toMove);
        b.setAtIndex(idx1(x, y), packPiece(type, owner));
        console.log(boardWithSidebar(b));

        const ownerSide: Side = owner === Owner.Host ? "host" : "guest";
        if (advance || ownerSide === toMove) {
          toMove = other(toMove);
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
