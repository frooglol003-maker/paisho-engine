// src/demo.ts
// Rich demo runner: board rendering, CLI flags, self-play and scenarios.

import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { pickBestMove, applyPlannedArrange } from "./engine";
import { coordsOf, indexOf } from "./coords";

// ---------------- CLI ----------------

type Side = "host" | "guest";
type ScenarioName = "small" | "center" | "harmony-seed";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.startsWith("--") ? a.slice(2).split("=") : [a, "true"];
    if (k) args[k] = v ?? "true";
  }
  const depth = Number(args.depth ?? 3);
  const side = (args.side as Side) ?? "host";
  const selfplay = Number(args.selfplay ?? 0); // 0 = single suggestion
  const scenario = (args.scenario as ScenarioName) ?? "small";
  return { depth, side, selfplay, scenario };
}

// ---------------- Utilities ----------------

function idx1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function pieceGlyph(packed: number | null): string {
  if (!packed) return "·"; // empty
  const d = unpackPiece(packed)!;
  // Base letter for type
  let base =
    d.type === TypeId.R3 ? "3" :
    d.type === TypeId.R4 ? "4" :
    d.type === TypeId.R5 ? "5" :
    d.type === TypeId.W3 ? "3" :
    d.type === TypeId.W4 ? "4" :
    d.type === TypeId.W5 ? "5" :
    d.type === TypeId.Lotus ? "L" :
    d.type === TypeId.Orchid ? "O" :
    d.type === TypeId.Rock ? "R" :
    d.type === TypeId.Wheel ? "W" :
    d.type === TypeId.Boat ? "B" :
    d.type === TypeId.Knotweed ? "K" : "?";

  // Garden tint for basics: prefix 'r'/'w' conceptually by casing:
  // Host = UPPERCASE, Guest = lowercase
  // For basics, we already show the number (3/4/5). Add a subtle garden hint via case of number proxy:
  // We'll render basics as numbers but wrap with case via a small trick: keep as number, just case via owner.
  // (Uppercase/lowercase has no effect on numbers, so add a tiny garden suffix.)
  if (d.type === TypeId.R3 || d.type === TypeId.R4 || d.type === TypeId.R5) {
    base = "R" + base; // R3/R4/R5
  } else if (d.type === TypeId.W3 || d.type === TypeId.W4 || d.type === TypeId.W5) {
    base = "W" + base; // W3/W4/W5
  }

  const owned = (d.owner === 0) ? base.toUpperCase() : base.toLowerCase();
  return owned;
}

function renderBoard(b: Board): string {
  // y from +8 down to -8; x from -8..+8, using indexOf to decide real intersections
  let out = "";
  for (let y = 8; y >= -8; y--) {
    let row = "";
    for (let x = -8; x <= 8; x++) {
      const i0 = indexOf(x, y);
      if (i0 === -1) {
        row += "  "; // off-board pad
      } else {
        const i1 = i0 + 1;
        const packed = b.getAtIndex(i1);
        row += pieceGlyph(packed).padEnd(2, " ");
      }
    }
    out += row.replace(/\s+$/,"") + "\n";
  }
  return out;
}

function printMove(m: any) {
  if (!m) { console.log("Engine returned no move."); return; }
  if (m.kind === "arrange") {
    const to = m.path[m.path.length - 1];
    const fromXY = coordsOf(m.from - 1);
    const toXY = coordsOf(to - 1);
    console.log(
      `→ ARRANGE from idx ${m.from} ${JSON.stringify(fromXY)} ` +
      `to idx ${to} ${JSON.stringify(toXY)} (steps=${m.path.length})`
    );
  } else {
    console.log("→ Move:", m);
  }
}

// ---------------- Scenarios ----------------

function scenario_small(): Board {
  const b = new Board();
  // Host R3 at (0,0) [neutral midline]
  b.setAtIndex(idx1(0, 0), packPiece(TypeId.R3, Owner.Host));
  // Guest W3 at (1,0) [neutral midline]
  b.setAtIndex(idx1(1, 0), packPiece(TypeId.W3, Owner.Guest));
  // Extra host piece to create options (R4 at (0,1))
  b.setAtIndex(idx1(0, 1), packPiece(TypeId.R4, Owner.Host));
  return b;
}

function scenario_center(): Board {
  const b = new Board();
  // Place a few pieces around the center to exercise centerDiff
  b.setAtIndex(idx1(0, 0), packPiece(TypeId.R3, Owner.Host));
  b.setAtIndex(idx1(1, 1), packPiece(TypeId.W4, Owner.Guest));
  b.setAtIndex(idx1(-1, 0), packPiece(TypeId.R5, Owner.Host));
  b.setAtIndex(idx1(0, -1), packPiece(TypeId.W3, Owner.Guest));
  return b;
}

function scenario_harmony_seed(): Board {
  const b = new Board();
  // Try to place compatible basics on the same axis with clear LoS to seed harmonyDegDiff
  // Host: R3 at (-1,0), R4 at (1,0) — can align via midline if you move
  b.setAtIndex(idx1(-1, 0), packPiece(TypeId.R3, Owner.Host));
  b.setAtIndex(idx1(1, 0),  packPiece(TypeId.R4, Owner.Host));
  // Guest blockers around
  b.setAtIndex(idx1(0, 1),  packPiece(TypeId.W3, Owner.Guest));
  b.setAtIndex(idx1(0, -1), packPiece(TypeId.W5, Owner.Guest));
  return b;
}

function buildScenario(name: ScenarioName): Board {
  switch (name) {
    case "center": return scenario_center();
    case "harmony-seed": return scenario_harmony_seed();
    case "small":
    default: return scenario_small();
  }
}

// ---------------- Main ----------------

async function main() {
  const { depth, side, selfplay, scenario } = parseArgs(process.argv);

  let board = buildScenario(scenario);
  console.log(`Scenario: ${scenario} | Side: ${side} | Depth: ${depth} | Self-play plies: ${selfplay}`);
  console.log(renderBoard(board));

  if (selfplay > 0) {
    let toMove: Side = side;
    for (let ply = 1; ply <= selfplay; ply++) {
      console.log(`\nPly ${ply}: ${toMove} to move`);
      console.time("search");
      const mv = pickBestMove(board, toMove, depth);
      console.timeEnd("search");
      printMove(mv);
      if (!mv) { console.log("No legal move — stopping."); break; }
      board = applyPlannedArrange(board, mv);
      console.log(renderBoard(board));
      toMove = (toMove === "host" ? "guest" : "host");
    }
  } else {
    console.time("search");
    const mv = pickBestMove(board, side, depth);
    console.timeEnd("search");
    printMove(mv);
  }
}
main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
