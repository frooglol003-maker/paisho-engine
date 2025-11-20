// src/play.ts
import readline from "readline";
import { performance } from "perf_hooks";

import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";
import { validateArrange, detectAnyClash, listHarmonyEdges } from "./move";
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

// ---------- Pools & counting ----------
type CountMap = Record<string, number>;
const PIECE_KEYS: [TypeId, string][] = [
  [TypeId.R3, "R3"], [TypeId.R4, "R4"], [TypeId.R5, "R5"],
  [TypeId.W3, "W3"], [TypeId.W4, "W4"], [TypeId.W5, "W5"],
  [TypeId.Lotus, "Lotus"], [TypeId.Orchid, "Orchid"],
  [TypeId.Rock, "Rock"], [TypeId.Wheel, "Wheel"],
  [TypeId.Boat, "Boat"], [TypeId.Knotweed, "Knotweed"],
];

// **Total** starting pool for EACH player.
const STANDARD_POOL: CountMap = {
  R3: 3, R4: 3, R5: 3,
  W3: 3, W4: 3, W5: 3,
  Lotus: 1, Orchid: 1,
  Rock: 1, Wheel: 1, Boat: 1, Knotweed: 1,
};

function keyForType(type: TypeId): string | undefined {
  const pair = PIECE_KEYS.find(([tid]) => tid === type);
  return pair ? pair[1] : undefined;
}

function zeroCounts(): CountMap {
  const out: CountMap = {};
  for (const [, key] of PIECE_KEYS) out[key] = 0;
  return out;
}

/** Count pieces currently on the board, split by owner. */
function countsOnBoard(board: Board): { host: CountMap; guest: CountMap } {
  const host = zeroCounts();
  const guest = zeroCounts();

  const N: number =
    (board as any).size ??
    (board as any).size1Based ??
    249;

  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const key = keyForType(d.type);
    if (!key) continue;

    if (d.owner === Owner.Host) host[key] = (host[key] || 0) + 1;
    else                        guest[key] = (guest[key] || 0) + 1;
  }
  return { host, guest };
}

/** Derive remaining pool per side from board state + STANDARD_POOL. */
function remainingFromBoard(board: Board): { host: CountMap; guest: CountMap } {
  const onBoard = countsOnBoard(board);
  const hostRem = zeroCounts();
  const guestRem = zeroCounts();

  for (const [, key] of PIECE_KEYS) {
    const total = STANDARD_POOL[key] ?? 0;
    hostRem[key] = Math.max(0, total - (onBoard.host[key] ?? 0));
    guestRem[key] = Math.max(0, total - (onBoard.guest[key] ?? 0));
  }
  return { host: hostRem, guest: guestRem };
}

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

// Bright cyan for harmony “wires” between pieces
const FG_HARMONY = FG(51);

/**
 * Compute all board indices (1-based) that lie on an active harmony segment
 * between two tiles of the same side. We mark the EMPTY intersections in
 * between them so the UI can draw a bright line.
 */
function computeHarmonySegments(board: Board): Set<number> {
  const segs = new Set<number>();
  const edges = listHarmonyEdges(board);

  for (const e of edges) {
    const a = coordsOf(e.aIdx1 - 1);
    const b = coordsOf(e.bIdx1 - 1);
    if (!a || !b) continue;

    // Same file (vertical)
    if (a.x === b.x) {
      const x = a.x;
      const step = a.y < b.y ? 1 : -1;
      for (let y = a.y + step; y !== b.y; y += step) {
        const i0 = indexOf(x, y);
        if (i0 !== -1) segs.add(i0 + 1);
      }
    }
    // Same rank (horizontal)
    else if (a.y === b.y) {
      const y = a.y;
      const step = a.x < b.x ? 1 : -1;
      for (let x = a.x + step; x !== b.x; x += step) {
        const i0 = indexOf(x, y);
        if (i0 !== -1) segs.add(i0 + 1);
      }
    }
  }

  return segs;
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
  // Enforce pool limit for the planting side
  const rem = remainingFromBoard(b);
  const pool = who === "host" ? rem.host : rem.guest;
  const key = keyForType(type);
  if (!key) throw new Error(`Unknown type for pool: ${type}`);
  if ((pool[key] ?? 0) <= 0) {
    throw new Error(`No ${key} tiles remaining for ${who}`);
  }

  const g = gateFor(who);
  const m = mirrorGateFor(who);
  const gi = idx1(g.x, g.y);
  const mi = idx1(m.x, m.y);

  if (b.getAtIndex(gi)) throw new Error(`Gate ${g.x},${g.y} occupied`);
  if (b.getAtIndex(mi)) throw new Error(`Mirror gate ${m.x},${m.y} occupied`);

  b.setAtIndex(gi, packPiece(type, who === "host" ? Owner.Host : Owner.Guest));
  const otherOwner = who === "host" ? Owner.Guest : Owner.Host;
  b.setAtIndex(mi, packPiece(type, otherOwner));
}

function enginePickOpeningType(board: Board, side: Side): TypeId | null {
  const rem = remainingFromBoard(board);
  const pool = side === "host" ? rem.host : rem.guest;

  // Only basic numbered flowers for openings
  const order = ["R3","W3","R4","W4","R5","W5"] as const;
  for (const k of order) {
    if ((pool[k] ?? 0) > 0) return toTypeId(k);
  }
  return null;
}

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

// ---------- Helper conversions ----------
function toTypeId(name: string): TypeId {
  const normalized = name.trim().toUpperCase();
  switch (normalized) {
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
    default:
      throw new Error(`Unknown piece type: ${name}`);
  }
}

function toOwner(name: string): Owner {
  const n = name.trim().toLowerCase();
  if (n === "host" || n === "h") return Owner.Host;
  if (n === "guest" || n === "g") return Owner.Guest;
  throw new Error(`Unknown owner: ${name}`);
}

function isWhiteFlower(type: TypeId): boolean {
  return type === TypeId.W3 || type === TypeId.W4 || type === TypeId.W5;
}

function isRedFlower(type: TypeId): boolean {
  return type === TypeId.R3 || type === TypeId.R4 || type === TypeId.R5;
}

function boardViolatesGarden(board: Board): boolean {
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    const packed = board.getAtIndex(i);
    if (!packed) continue;

    const piece = unpackPiece(packed)!;
    const t = piece.type;

    // Flowers + special flowers are garden-sensitive
    if (
      t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5 ||
      t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5 ||
      t === TypeId.Lotus || t === TypeId.Orchid
    ) {
      const { x, y } = coordsOf(i - 1);
      const g = getGardenType(x, y); // "red" | "white" | "neutral"

      if (g === "red" && isWhiteFlower(t)) return true;
      if (g === "white" && isRedFlower(t)) return true;
    }
  }
  return false;
}

// ---------- Board renderer (flipped so y=+8 is at top visually) ----------
function boardWithSidebar(board: Board): string {
  const harmonySegs = computeHarmonySegments(board);
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

  const rem = remainingFromBoard(board);
  const hostRem = countsToLines("HOST remaining", rem.host, FG_HOST);
  const guestRem = countsToLines("GUEST remaining", rem.guest, FG_GUEST);

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
        const onHarmony = harmonySegs.has(idx);
        const dotColor = onHarmony ? FG_HARMONY : GRID_DOT;
        cells.push(`${bg}${dotColor}· ${RESET}`);
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
  // Apply on a fresh Board so we can validate the result before committing.
  const trial = new Board();
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    trial.setAtIndex(i, board.getAtIndex(i) || 0);
  }

  // Actually apply the move to the trial board.
  let result: Board;
  switch (m.kind) {
    case "arrange":
      result = applyPlannedArrange(trial, { from: m.from, path: m.path });
      break;
    case "wheel":
      result = applyWheel(trial, side, m.center);
      break;
    case "boatFlower":
      result = applyBoatFlower(trial, side, m.boat, m.from, m.to);
      break;
    case "boatAccent":
      result = applyBoatAccent(trial, side, m.boat, m.target);
      break;
    default:
      throw new Error(`unknown move kind: ${m.kind}`);
  }

  // === CLASH RULE ===
  if (detectAnyClash(result)) {
    throw new Error("illegal: move produces a clash position");
  }

  return result;
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

// ---------- Harmony bonus helpers ----------

// listHarmonyEdges return type shim
type HarmonyEdgeLite = { aIdx1: number; bIdx1: number; owner: Side };

// Player can plant only if they have NO tile in ANY gate, and some gate is empty.
function playerCanPlant(b: Board, side: Side): boolean {
  const myOwner = side === "host" ? Owner.Host : Owner.Guest;

  const gates = [
    { x: 0,  y:  8 },
    { x: 0,  y: -8 },
    { x: -8, y:  0 },
    { x: 8,  y:  0 },
  ];

  let hasOwnInGate = false;
  let hasEmptyGate = false;

  for (const g of gates) {
    const idx = idx1(g.x, g.y);
    const packed = b.getAtIndex(idx);
    if (!packed) {
      hasEmptyGate = true;
      continue;
    }
    const dec = unpackPiece(packed)!;
    if (dec.owner === myOwner) hasOwnInGate = true;
  }

  if (hasOwnInGate) return false;
  return hasEmptyGate;
}

async function handleBonusAccent(
  b: Board,
  side: Side,
  ask: (q: string) => Promise<string>
): Promise<void> {
  const myOwner = side === "host" ? Owner.Host : Owner.Guest;

  // --- choose accent type ---
  const ACCENT_CHOICES = ["Rock", "Wheel", "Boat", "Knotweed"] as const;
  let chosenType: (typeof ACCENT_CHOICES)[number] | null = null;

  console.log("Accent types:", ACCENT_CHOICES.join(", "));

  while (!chosenType) {
    const ans = (await ask("Accent type (Rock/Wheel/Boat/Knotweed) > "))
      .trim()
      .toLowerCase();

    const match = ACCENT_CHOICES.find(t => t.toLowerCase() === ans);
    if (!match) {
      console.log("Please choose one of:", ACCENT_CHOICES.join(", "));
      continue;
    }
    chosenType = match;
  }

  // ====== NON-Boat accents (Rock / Wheel / Knotweed) ======
  if (chosenType !== "Boat") {
    while (true) {
      const raw = (await ask("Accent position x,y > ")).trim();
      if (!raw) continue;

      let x: number, y: number;
      try {
        const xy = xyFromString(raw);
        x = xy.x; y = xy.y;
      } catch {
        console.log("Bad coord. Use x,y.");
        continue;
      }

      const i0 = indexOf(x, y);
      if (i0 === -1) {
        console.log("That coord is off-board.");
        continue;
      }
      const idx1 = i0 + 1;

      if (b.getAtIndex(idx1)) {
        console.log("Illegal accent: intersection already occupied.");
        continue;
      }

      // Trial board
      const trial = b.clone();
      const tId = toTypeId(chosenType);
      trial.setAtIndex(idx1, packPiece(tId, myOwner));

      // Special case: Wheel should immediately rotate the ring.
      if (chosenType === "Wheel") {
        try {
          applyWheel(trial, side, idx1);
        } catch (e: any) {
          console.log(
            `Illegal wheel: ${e?.message ?? "cannot rotate from that position."}`
          );
          continue;
        }
      }

      // Global legality checks AFTER accent (and wheel rotation if any)
      if (detectAnyClash(trial)) {
        console.log("Illegal accent: creates a clash.");
        continue;
      }
      if (boardViolatesGarden(trial)) {
        console.log("Illegal accent: leaves a flower in the wrong garden.");
        continue;
      }

      // Commit
      copyBoard(b, trial);
      if (chosenType === "Wheel") {
        console.log("Wheel placed and neighbors rotated.");
      } else {
        console.log("Accent placed.");
      }
      console.log(boardWithSidebar(b));
      return;
    }
  }

  // ====== Boat accent (can hit flower OR accent) ======
  while (true) {
    const raw = (await ask("Boat target x,y (enemy flower or accent) > ")).trim();
    if (!raw) continue;

    let x: number, y: number;
    try {
      const xy = xyFromString(raw);
      x = xy.x; y = xy.y;
    } catch {
      console.log("Bad coord. Use x,y.");
      continue;
    }

    const i0 = indexOf(x, y);
    if (i0 === -1) {
      console.log("That coord is off-board.");
      continue;
    }
    const idx1 = i0 + 1;
    const packed = b.getAtIndex(idx1);
    if (!packed) {
      console.log("Boat must target an existing piece (flower or accent).");
      continue;
    }

    const piece = unpackPiece(packed)!;
    const t = piece.type;

    const isAccent =
      t === TypeId.Rock ||
      t === TypeId.Wheel ||
      t === TypeId.Boat ||
      t === TypeId.Knotweed;

    const isFlower =
      t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5 ||
      t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5 ||
      t === TypeId.Lotus || t === TypeId.Orchid;

    if (!isAccent && !isFlower) {
      console.log("Boat can only target a flower or an accent.");
      continue;
    }

    const srcXY = coordsOf(idx1 - 1);
    if (!srcXY) {
      console.log("Internal error: bad coords for source.");
      continue;
    }

    // --- Case 1: Boat on ACCENT → remove that accent, boat consumed ---
    if (isAccent) {
      const trial = b.clone();
      trial.setAtIndex(idx1, 0); // remove accent; boat is "used" and not left anywhere

      if (detectAnyClash(trial) || boardViolatesGarden(trial)) {
        console.log("Illegal accent: result would be a clash or wrong garden.");
        continue;
      }

      copyBoard(b, trial);
      console.log("Boat removed the accent.");
      console.log(boardWithSidebar(b));
      return;
    }

    // --- Case 2: Boat on FLOWER → move flower to one of 8 surrounding spaces ---
    const { x: sx, y: sy } = srcXY;

    const neighbors = [
      { x: sx - 1, y: sy + 1 },
      { x: sx,     y: sy + 1 },
      { x: sx + 1, y: sy + 1 },
      { x: sx + 1, y: sy     },
      { x: sx + 1, y: sy - 1 },
      { x: sx,     y: sy - 1 },
      { x: sx - 1, y: sy - 1 },
      { x: sx - 1, y: sy     },
    ].filter(p => indexOf(p.x, p.y) !== -1); // on-board only

    if (neighbors.length === 0) {
      console.log("No valid adjacent squares to move the flower to.");
      return;
    }

    console.log("Boat can move the flower to one of:");
    for (const n of neighbors) {
      console.log(`  (${n.x},${n.y})`);
    }

    while (true) {
      const destRaw = (await ask("Destination x,y > ")).trim();
      if (!destRaw) continue;

      let dx: number, dy: number;
      try {
        const dxy = xyFromString(destRaw);
        dx = dxy.x; dy = dxy.y;
      } catch {
        console.log("Bad coord. Use x,y.");
        continue;
      }

      const destOk = neighbors.find(n => n.x === dx && n.y === dy);
      if (!destOk) {
        console.log("Destination must be one of the surrounding 8 spaces.");
        continue;
      }

      const di0 = indexOf(dx, dy);
      if (di0 === -1) {
        console.log("Destination off-board.");
        continue;
      }
      const destIdx1 = di0 + 1;

      if (b.getAtIndex(destIdx1)) {
        console.log("Destination must be empty.");
        continue;
      }

      const trial = b.clone();

      // Remove flower from source
      trial.setAtIndex(idx1, 0);
      // Place flower at destination
      trial.setAtIndex(destIdx1, packed);
      // Leave inert boat on original flower square
      trial.setAtIndex(idx1, packPiece(TypeId.Boat, myOwner));

      if (detectAnyClash(trial)) {
        console.log("Illegal accent: creates a clash. Try another destination.");
        continue;
      }
      if (boardViolatesGarden(trial)) {
        console.log(
          "Illegal accent: leaves a flower in the wrong garden. Try another destination."
        );
        continue;
      }

      copyBoard(b, trial);
      console.log("Boat moved the flower.");
      console.log(boardWithSidebar(b));
      return;
    }
  }
}


// Bonus: plant a flower into ANY empty gate
async function handleBonusPlant(
  b: Board,
  side: Side,
  ask: (q: string) => Promise<string>
): Promise<void> {
  const myOwner = side === "host" ? Owner.Host : Owner.Guest;

  if (!playerCanPlant(b, side)) {
    console.log("You cannot plant: you already have a tile in a gate or there is no empty gate.");
    return;
  }

  const rem = remainingFromBoard(b);
  const pool = side === "host" ? rem.host : rem.guest;

  const FLOWERS = ["R3","R4","R5","W3","W4","W5","Lotus","Orchid"] as const;
  const available = FLOWERS.filter(k => (pool[k] ?? 0) > 0);

  if (available.length === 0) {
    console.log("No flowers remaining to plant.");
    return;
  }

  console.log("Available flowers to plant:", available.join(", "));

  let chosenType: TypeId | null = null;
  while (!chosenType) {
    const ans = (await ask("Plant which type? > ")).trim().toUpperCase();
    if (!available.includes(ans as any)) {
      console.log("Please choose one of:", available.join(", "));
      continue;
    }
    try {
      chosenType = toTypeId(ans);
    } catch {
      console.log("Unknown type, try again.");
    }
  }

  const ALL_GATES = [
    { label: "A", x:  0, y:  8 },
    { label: "B", x:  0, y: -8 },
    { label: "C", x: -8, y:  0 },
    { label: "D", x:  8, y:  0 },
  ];
  const emptyGates = ALL_GATES.filter(g => !b.getAtIndex(idx1(g.x, g.y)));

  if (emptyGates.length === 0) {
    console.log("No empty gates to plant into.");
    return;
  }

  console.log("Available gates for bonus plant:");
  for (const g of emptyGates) {
    console.log(`  ${g.label}: (${g.x},${g.y})`);
  }

  let targetGate: { x: number; y: number } | null = null;
  while (!targetGate) {
    const raw = (await ask("Choose gate (A/B/C/D or coord x,y) > ")).trim();
    if (!raw) continue;

    const up = raw.toUpperCase();

    const byLabel = emptyGates.find(g => g.label === up);
    if (byLabel) {
      targetGate = { x: byLabel.x, y: byLabel.y };
      break;
    }

    try {
      const { x, y } = xyFromString(raw);
      const byCoord = emptyGates.find(g => g.x === x && g.y === y);
      if (byCoord) {
        targetGate = { x: byCoord.x, y: byCoord.y };
        break;
      }
      console.log("That coord is not an empty gate.");
    } catch {
      console.log("Please enter a gate letter (A/B/C/D) or coord x,y.");
    }
  }

  const idx = idx1(targetGate!.x, targetGate!.y);
  b.setAtIndex(idx, packPiece(chosenType!, myOwner));
  console.log("Bonus plant applied.");
}

// Decide what to do with a harmony bonus
async function handleHarmonyBonus(
  b: Board,
  side: Side,
  ask: (q: string) => Promise<string>
): Promise<void> {
  console.log("Harmony bonus! A new harmony was created.");

  while (true) {
    const ans = (await ask("Bonus? (accent / plant / skip) > ")).trim().toLowerCase();

    if (ans === "skip") {
      console.log("Bonus skipped.");
      return;
    }

    if (ans === "accent") {
      await handleBonusAccent(b, side, ask);
      return;
    }

    if (ans === "plant") {
      if (!playerCanPlant(b, side)) {
        console.log("You cannot plant: you already have a tile in a gate or there is no empty gate.");
        continue;
      }
      await handleBonusPlant(b, side, ask);
      return;
    }

    console.log("Please choose: accent / plant / skip");
  }
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
    const t = enginePickOpeningType(b, toMove);
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

        // Lotus and Orchid may ONLY be planted as harmony bonuses.
        if (typ === TypeId.Lotus || typ === TypeId.Orchid) {
          console.log("Lotus and Orchid may only be planted as a harmony bonus.");
          continue;
        }

        const g = gateFor(toMove), m = mirrorGateFor(toMove);
        const gateOccupied =
          b.getAtIndex(idx1(g.x, g.y)) ||
          b.getAtIndex(idx1(m.x, m.y));

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
          const t = enginePickOpeningType(b, toMove);
          if (t) {
            pushHistory(b, toMove);
            plantOpening(b, toMove, t);
            const t1 = performance.now();
            const g = gateFor(toMove);
            console.log(`Engine → PLANT ${TypeId[t]} at gate (${g.x},${g.y}) (mirrored)`);
            if (toMove === "host") toMove = "guest";
            console.log(`search: ${((t1 - t0) / 1000).toFixed(3)}s`);
            console.log(boardWithSidebar(b));
            continue;
          }
        }

        pushHistory(b, toMove);
        const mv = pickBestMove(
          b,
          toMove,
          DEPTH,
          TIMEMS ? { maxMs: TIMEMS } : undefined
        );
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
        console.log(`search: ${((t1 - t0) / 1000).toFixed(3)}s`);
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

        // Capture harmony edges BEFORE move (for this side),
        // so we can see which partners the moving piece already had.
        const beforeEdgesAll = (listHarmonyEdges(b) as HarmonyEdgeLite[]).filter(
          e => e.owner === toMove
        );

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
        const garden  = getGardenType(lastXY.x, lastXY.y); // "red" | "white" | "neutral"

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

        // --- actually apply move ---
        pushHistory(b, toMove);
        const mv = { kind: "arrange", from: fromIdx, path: pathIdx };
        const nb = applyAnyMove(b, toMove, mv);
        copyBoard(b, nb);
      // --- harmony bonus detection (only for the moving side) ---
      
      // BEFORE the move, we recorded:
      const beforeCount = beforeEdgesAll.length;
      
      // AFTER the move:
      const afterEdges = (listHarmonyEdges(b) as HarmonyEdgeLite[]).filter(
        e => e.owner === toMove
      );
      const afterCount = afterEdges.length;
      
      // You get a bonus ONLY if your total harmony count increased
      const newHarmony = afterCount > beforeCount;
      
      if (newHarmony && toMove === HUMAN) {
        await handleHarmonyBonus(b, toMove, ask);
      }
      
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
        const body = line.slice(6).trim();
        // New syntax: boatf boatX,boatY fromX,fromY   (we'll prompt for destination)
        const parts = body.split(/\s+/).map(s => s.trim()).filter(Boolean);
        if (parts.length !== 2) {
          throw new Error("Use: boatf boatX,boatY fromX,fromY");
        }

        const boatCoord = xyFromString(parts[0]);
        const fromCoord = xyFromString(parts[1]);
        const boatIdx   = idx1(boatCoord.x, boatCoord.y);
        const fromIdx   = idx1(fromCoord.x, fromCoord.y);

        // --- Check boat piece ---
        const boatVal = b.getAtIndex(boatIdx);
        if (!boatVal) {
          console.log("Illegal boat: no boat at that coordinate.");
          continue;
        }
        const boatPiece = unpackPiece(boatVal)!;
        if (boatPiece.type !== TypeId.Boat) {
          console.log("Illegal boat: piece at boatX,boatY is not a Boat.");
          continue;
        }

        // --- Check flower piece ---
        const flowerVal = b.getAtIndex(fromIdx);
        if (!flowerVal) {
          console.log("Illegal boat: no flower at fromX,fromY.");
          continue;
        }
        const flower = unpackPiece(flowerVal)!;
        const isFlower =
          flower.type === TypeId.R3 || flower.type === TypeId.R4 || flower.type === TypeId.R5 ||
          flower.type === TypeId.W3 || flower.type === TypeId.W4 || flower.type === TypeId.W5 ||
          flower.type === TypeId.Lotus || flower.type === TypeId.Orchid;
        if (!isFlower) {
          console.log("Illegal boat: target piece is not a flower.");
          continue;
        }

        // --- Find 8 surrounding legal destinations around the flower ---
        const basis = coordsOf(fromIdx - 1) as { x: number; y: number } | undefined;
        if (!basis) {
          console.log("Illegal boat: source coordinate invalid.");
          continue;
        }

        const dirs: [number, number][] = [
          [-1,  1], [0,  1], [1,  1],  // A, B, C
          [ 1,  0],                    // D
          [ 1, -1], [0, -1], [-1, -1], // E, F, G
          [-1,  0],                    // H
        ];
        const labels = ["A","B","C","D","E","F","G","H"];

        const neighbors: { label: string; x: number; y: number; idx1: number }[] = [];

        for (let i = 0; i < dirs.length; i++) {
          const [dx, dy] = dirs[i];
          const x = basis.x + dx;
          const y = basis.y + dy;
          const i0 = indexOf(x, y);
          if (i0 === -1) continue;          // off board
          const idx1Val = i0 + 1;
          if (b.getAtIndex(idx1Val)) continue; // must be empty

          // Garden-color legality for flowers, same rule as arrange:
          const g = getGardenType(x, y); // "red" | "white" | "neutral"
          if (isWhiteFlower(flower.type) && g === "red") continue;
          if (isRedFlower(flower.type) && g === "white") continue;

          neighbors.push({ label: labels[i], x, y, idx1: idx1Val });
        }

        if (neighbors.length === 0) {
          console.log("Illegal boat: no legal destination adjacent to the flower.");
          continue;
        }

        console.log("Boat activated. Legal destinations:");
        for (const n of neighbors) {
          console.log(`  ${n.label}: (${n.x},${n.y})`);
        }

        let destIdx: number | null = null;
        while (destIdx === null) {
          const ansRaw = (await ask("Choose destination (letter or x,y) > ")).trim();
          if (!ansRaw) continue;
          const up = ansRaw.toUpperCase();

          // by letter
          const byLabel = neighbors.find(n => n.label === up);
          if (byLabel) {
            destIdx = byLabel.idx1;
            break;
          }

          // or by coord
          try {
            const { x, y } = xyFromString(ansRaw);
            const byCoord = neighbors.find(n => n.x === x && n.y === y);
            if (!byCoord) {
              console.log("That coordinate is not a legal destination for this boat move.");
              continue;
            }
            destIdx = byCoord.idx1;
            break;
          } catch {
            console.log("Please enter a valid letter or x,y coordinate.");
          }
        }

        // Apply the move (with clash & gate checks via applyAnyMove / rules)
        pushHistory(b, toMove);
        const mv = { kind: "boatFlower", boat: boatIdx, from: fromIdx, to: destIdx! };
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

      // Force place (debug, but still respect per-side pools)
      if (lower.startsWith("place ")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts.length > 5) {
          throw new Error("Use: place TYPE OWNER x,y [next]");
        }

        const type  = toTypeId(parts[1]);
        const owner = toOwner(parts[2]);
        const { x, y } = xyFromString(parts[3]);
        const advance = (parts[4]?.toLowerCase() === "next");

        const targetIdx = idx1(x, y);
        if (b.getAtIndex(targetIdx)) {
          console.log("Illegal place: intersection already occupied.");
          continue;
        }

        const rem  = remainingFromBoard(b);
        const pool = owner === Owner.Host ? rem.host : rem.guest;
        const key  = keyForType(type);

        if (!key) {
          throw new Error(`Unknown type for pool: ${parts[1]}`);
        }
        if ((pool[key] ?? 0) <= 0) {
          console.log(`Illegal place: no ${key} tiles remaining for that side.`);
          continue;
        }

        pushHistory(b, toMove);
        b.setAtIndex(targetIdx, packPiece(type, owner));
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
