// src/parse.ts
// Parse & apply high-ELO game records to Board states.
// Supports setup placements, Arrange paths, Wheel rotation, Boat-on-flower, Boat-on-accent.
// Now also supports XY-friendly actions to avoid index guesswork.

import * as fs from "fs";
import * as readline from "readline";
import { Board, TypeId, Owner, unpackPiece, packPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { planWheelRotate, planBoatOnFlower, planBoatOnAccent } from "./rules";
import { validateArrange } from "./move";
import { applyPlannedArrange } from "./engine";

// ====== Types ======
export type Side = "host" | "guest";
export type Result = "host" | "guest" | "draw";

export type Placement = {
  owner: Side;
  type: keyof typeof TypeIdNames; // "R3"|"W4"|...
  index?: number; // 1-based index
  x?: number;     // optional (x,y) instead of index
  y?: number;
};

// Index-based actions (backward compatible)
export type ActionIndex =
  | { kind: "arrange"; side: Side; from: number; path: number[] } // indices 1-based
  | { kind: "wheel"; side: Side; center: number }
  | { kind: "boatFlower"; side: Side; boat: number; from: number; to: number }
  | { kind: "boatAccent"; side: Side; boat: number; target: number };

// XY-based actions (new)
export type ActionXY =
  | { kind: "arrangeXY"; side: Side; fromXY: [number, number]; pathXY: [number, number][] }
  | { kind: "wheelXY"; side: Side; centerXY: [number, number] }
  | { kind: "boatFlowerXY"; side: Side; boatXY: [number, number]; fromXY: [number, number]; toXY: [number, number] }
  | { kind: "boatAccentXY"; side: Side; boatXY: [number, number]; targetXY: [number, number] };

// Union of all accepted actions
export type Action = ActionIndex | ActionXY;

export type GameRecord = {
  id?: string;
  setup?: Placement[];
  moves: Action[];
  result: Result;
};

// ====== Mapping piece names -> TypeId ======
export const TypeIdNames: Record<string, TypeId> = {
  R3: TypeId.R3,
  R4: TypeId.R4,
  R5: TypeId.R5,
  W3: TypeId.W3,
  W4: TypeId.W4,
  W5: TypeId.W5,
  Lotus: TypeId.Lotus,
  Orchid: TypeId.Orchid,
  Rock: TypeId.Rock,
  Wheel: TypeId.Wheel,
  Boat: TypeId.Boat,
  Knotweed: TypeId.Knotweed,
};

// ====== Helpers ======
function toIndex1FromPlacement(p: Placement): number {
  if (typeof p.index === "number") return p.index;
  if (typeof p.x === "number" && typeof p.y === "number") {
    const i0 = indexOf(p.x, p.y);
    if (i0 === -1) throw new Error(`invalid (x,y)=(${p.x},${p.y})`);
    return i0 + 1;
  }
  throw new Error("Placement needs either index or (x,y).");
}

function xyToIndex1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function toOwnerEnum(owner: Side): Owner {
  return owner === "host" ? Owner.Host : Owner.Guest;
}

function typeFromName(name: string): TypeId {
  const t = TypeIdNames[name];
  if (t === undefined) throw new Error(`Unknown piece type name: ${name}`);
  return t;
}

export function applySetup(board: Board, setup?: Placement[]) {
  if (!setup) return;
  for (const pl of setup) {
    const idx1 = toIndex1FromPlacement(pl);
    // IMPORTANT: your packPiece signature is (type, owner)
    const packed = packPiece(typeFromName(pl.type), toOwnerEnum(pl.owner));
    board.setAtIndex(idx1, packed);
  }
}

// ----- Arrange (index-based) via validator + apply
export function applyArrange(board: Board, _side: Side, from: number, path: number[]) {
  const ok = validateArrange(board, from, path);
  if (!ok.ok) throw new Error(`arrange invalid: ${ok.reason ?? "unknown"}`);
  return applyPlannedArrange(board, { from, path });
}

// ----- Arrange (XY-based) convenience wrapper
export function applyArrangeXY(
  board: Board,
  side: Side,
  fromXY: [number, number],
  pathXY: [number, number][]
) {
  const from = xyToIndex1(fromXY[0], fromXY[1]);
  const path = pathXY.map(([x, y]) => xyToIndex1(x, y));
  return applyArrange(board, side, from, path);
}

/**
 * Wheel: move all adjacent pieces one step clockwise around the wheel.
 * - Center stays where it is.
 * - We look at up to 8 surrounding squares in this order:
 *   N, NE, E, SE, S, SW, W, NW
 * - Only on-board neighbors are used (off-board positions are ignored).
 */
// ... keep whatever other code you already have here ...

// Rotate all 8 neighbors around a wheel center clockwise.
// Disallowed if any neighbor is a Rock or a flower sitting in a gate.
export function applyWheel(
  board: Board,
  _side: "host" | "guest",
  centerIdx1: number
): Board {
  // Clone the board into result
  const result = new Board();
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    result.setAtIndex(i, board.getAtIndex(i) || 0);
  }

  // Center coords
  const centerXY = coordsOf(centerIdx1 - 1) as { x: number; y: number } | undefined;
  if (!centerXY) throw new Error("Invalid wheel center index");
  const { x: cx, y: cy } = centerXY;

  // 8 neighbors in clockwise order: N, NE, E, SE, S, SW, W, NW
  const neighbors = [
    { x: cx,     y: cy + 1 }, // N
    { x: cx + 1, y: cy + 1 }, // NE
    { x: cx + 1, y: cy     }, // E
    { x: cx + 1, y: cy - 1 }, // SE
    { x: cx,     y: cy - 1 }, // S
    { x: cx - 1, y: cy - 1 }, // SW
    { x: cx - 1, y: cy     }, // W
    { x: cx - 1, y: cy + 1 }, // NW
  ];

  // Map each neighbor to its 1-based board index (or null if off-board)
  const idxs: (number | null)[] = neighbors.map(({ x, y }) => {
    const i0 = indexOf(x, y);
    return i0 === -1 ? null : i0 + 1;
  });

  const isGateCoord = (x: number, y: number) =>
    (x === 0 && (y === 8 || y === -8)) ||
    (y === 0 && (x === 8 || x === -8));

  const isFlower = (t: TypeId) =>
    t === TypeId.R3 || t === TypeId.R4 || t === TypeId.R5 ||
    t === TypeId.W3 || t === TypeId.W4 || t === TypeId.W5 ||
    t === TypeId.Lotus || t === TypeId.Orchid;

  // --- legality check: cannot wheel if touching rock or gate-flower ---
  for (let i = 0; i < idxs.length; i++) {
    const idx1 = idxs[i];
    if (idx1 == null) continue;          // off-board, ignore
    const packed = board.getAtIndex(idx1);
    if (!packed) continue;               // empty, ignore

    const piece = unpackPiece(packed)!;
    const { x, y } = neighbors[i];

    if (piece.type === TypeId.Rock) {
      throw new Error("Illegal wheel: adjacent to a Rock.");
    }

    if (isGateCoord(x, y) && isFlower(piece.type)) {
      throw new Error("Illegal wheel: cannot move a flower that is in a gate.");
    }
  }

  // --- rotate the ring contents (including empties) clockwise ---

  // Grab the current values around the ring (0 for off-board / empty)
  const vals: number[] = idxs.map(idx1 =>
    idx1 == null ? 0 : board.getAtIndex(idx1) || 0
  );

  // newVals[i] = vals[(i + 7) % 8]  (clockwise rotation)
  const newVals = vals.slice();
  for (let i = 0; i < 8; i++) {
    const from = (i + 7) % 8; // previous position in ring
    newVals[i] = vals[from];
  }

  // Write back into the result board (only where there is a real square)
  for (let i = 0; i < idxs.length; i++) {
    const idx1 = idxs[i];
    if (idx1 == null) continue;
    result.setAtIndex(idx1, newVals[i]);
  }

  return result;
}

// ----- Wheel (XY-based)
export function applyWheelXY(board: Board, _side: Side, centerXY: [number, number]) {
  const center = xyToIndex1(centerXY[0], centerXY[1]);
  return applyWheel(board, _side, center);
}

// ----- Boat-on-flower (index-based)
export function applyBoatFlower(board: Board, _side: Side, _boat: number, from: number, to: number) {
  const plan = planBoatOnFlower(board, from, to);
  if (!plan.ok) throw new Error(`boatFlower invalid: ${plan.reason}`);
  const cloned = board.clone();
  const piece = cloned.getAtIndex(from);
  const dest = cloned.getAtIndex(to);
  if (dest) throw new Error("boatFlower: target occupied");
  cloned.setAtIndex(from, 0);
  if (piece) cloned.setAtIndex(to, piece);
  return cloned;
}

// ----- Boat-on-flower (XY-based)
export function applyBoatFlowerXY(
  board: Board,
  _side: Side,
  _boatXY: [number, number], // present for parity; engine doesn't need it to move the flower
  fromXY: [number, number],
  toXY: [number, number]
) {
  const from = xyToIndex1(fromXY[0], fromXY[1]);
  const to = xyToIndex1(toXY[0], toXY[1]);
  return applyBoatFlower(board, _side, 0, from, to);
}

// ----- Boat-on-accent (index-based): remove BOTH the boat and the target accent
export function applyBoatAccent(board: Board, _side: Side, boat: number, target: number) {
  const res = planBoatOnAccent(board, target, boat);
  if (!res.ok) throw new Error(`boatAccent invalid: ${res.reason}`);
  const cloned = board.clone();
  for (const r of res.remove) cloned.setAtIndex(r.remove, 0);
  return cloned;
}

// ----- Boat-on-accent (XY-based)
export function applyBoatAccentXY(
  board: Board,
  _side: Side,
  boatXY: [number, number],
  targetXY: [number, number]
) {
  const boat = xyToIndex1(boatXY[0], boatXY[1]);
  const target = xyToIndex1(targetXY[0], targetXY[1]);
  return applyBoatAccent(board, _side, boat, target);
}

// ----- Apply any action -----
export function applyAction(board: Board, action: Action): Board {
  switch (action.kind) {
    // Index-based
    case "arrange":       return applyArrange(board, action.side, action.from, action.path);
    case "wheel":         return applyWheel(board, action.side, action.center);
    case "boatFlower":    return applyBoatFlower(board, action.side, action.boat, action.from, action.to);
    case "boatAccent":    return applyBoatAccent(board, action.side, action.boat, action.target);

    // XY-based
    case "arrangeXY":     return applyArrangeXY(board, action.side, action.fromXY, action.pathXY);
    case "wheelXY":       return applyWheelXY(board, action.side, action.centerXY);
    case "boatFlowerXY":  return applyBoatFlowerXY(board, action.side, action.boatXY, action.fromXY, action.toXY);
    case "boatAccentXY":  return applyBoatAccentXY(board, action.side, action.boatXY, action.targetXY);

    default:
      // Exhaustiveness check
      const _never: never = action as never;
      throw new Error(`Unknown action kind: ${(action as any).kind}`);
  }
}

// Load JSONL file -> GameRecord[] (with line numbers on errors)
export async function loadGames(jsonlPath: string): Promise<GameRecord[]> {
  const games: GameRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    try {
      games.push(JSON.parse(trimmed));
    } catch (e: any) {
      throw new Error(`JSONL parse error at ${jsonlPath}:${lineNo}\nLine: ${trimmed}\n${e.message}`);
    }
  }
  return games;
}
