// src/parse.ts
// Parse & apply high-ELO game records to Board states.
// Supports setup placements, Arrange paths, Wheel rotation, Boat-on-flower, Boat-on-accent.

import * as fs from "fs";
import * as readline from "readline";
import { Board, TypeId, unpackPiece, packPiece } from "./board";
import { indexOf } from "./coords";
import {
  planWheelRotate,
  planBoatOnFlower,
  planBoatOnAccent,
} from "./rules";
import {
  validateArrange,
} from "./move";
import {
  applyPlannedArrange,
} from "./engine";

// ====== Types ======

export type Side = "host" | "guest";
export type Result = "host" | "guest" | "draw";

export type Placement = {
  owner: Side;
  type: keyof typeof TypeIdNames;
  index?: number;
  x?: number;
  y?: number;
};

export type Action =
  | { kind: "arrange"; side: Side; from: number; path: number[] }
  | { kind: "wheel"; side: Side; center: number }
  | { kind: "boatFlower"; side: Side; boat: number; from: number; to: number }
  | { kind: "boatAccent"; side: Side; boat: number; target: number };

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

function toOwnerBit(owner: Side): 0 | 1 {
  return owner === "host" ? 0 : 1;
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
    const packed = packPiece(toOwnerBit(pl.owner), typeFromName(pl.type));
    board.setAtIndex(idx1, packed);
  }
}

export function applyArrange(board: Board, side: Side, from: number, path: number[]) {
  const ok = validateArrange(board, from, path);
  if (!ok.ok) throw new Error(`arrange invalid: ${ok.reason ?? "unknown"}`);
  return applyPlannedArrange(board, { from, path });
}

export function applyWheel(board: Board, side: Side, center: number) {
  const plan = planWheelRotate(board, center);
  if (!plan.ok) throw new Error(`wheel invalid: ${plan.reason}`);
  const cloned = board.clone();
  const pulled: { from: number; piece: number }[] = [];
  for (const m of plan.moves) {
    const p = cloned.getAtIndex(m.from);
    if (p) pulled.push({ from: m.from, piece: p });
    cloned.setAtIndex(m.from, 0);
  }
  for (const m of plan.moves) {
    const found = pulled.find(pp => pp.from === m.from)!;
    cloned.setAtIndex(m.to, found.piece);
  }
  return cloned;
}

export function applyBoatFlower(board: Board, side: Side, boat: number, from: number, to: number) {
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

export function applyBoatAccent(board: Board, side: Side, boat: number, target: number) {
  const res = planBoatOnAccent(board, target, boat);
  if (!res.ok) throw new Error(`boatAccent invalid: ${res.reason}`);
  const cloned = board.clone();
  for (const r of res.remove) cloned.setAtIndex(r.remove, 0);
  return cloned;
}

export function applyAction(board: Board, action: Action): Board {
  switch (action.kind) {
    case "arrange": return applyArrange(board, action.side, action.from, action.path);
    case "wheel": return applyWheel(board, action.side, action.center);
    case "boatFlower": return applyBoatFlower(board, action.side, action.boat, action.from, action.to);
    case "boatAccent": return applyBoatAccent(board, action.side, action.boat, action.target);
    default: throw new Error(`Unknown action kind: ${(action as any).kind}`);
  }
}

export async function loadGames(jsonlPath: string): Promise<GameRecord[]> {
  const games: GameRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    games.push(JSON.parse(trimmed));
  }
  return games;
}
