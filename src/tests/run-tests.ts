// minimal tests
import { totalIntersections } from "../coords";
import { Board } from "../board";
import { TypeId, packPiece } from "../board";
import { indexOf } from "../coords";
import { validateArrange } from "../move";

function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || "assert failed");
}

function testBoardSize() {
  console.log("Test: total intersections");
  const t = totalIntersections();
  console.log("Total intersections:", t);
  assert(t === 249, `expected 249 intersections, got ${t}`);
}

function testSimpleArrange() {
  console.log("Test: simple arrange validation");
  const b = new Board();
  // place a Host R3 at (-1,0) (just left of center on midline)
  const from = indexOf(-1, 0);
  b.setAtIndex(from, packPiece(TypeId.R3, 0));
  // move it two steps right to (1,0) via (0,0) (but cannot stop in gate — center is neutral so ok)
  const mid = indexOf(0, 0);
  const to = indexOf(1, 0);
  const result = validateArrange(b, from, [mid, to]);
  assert(result.ok, "expected arrange up to 3 steps to be valid");
}

function run() {
  testBoardSize();
  testSimpleArrange();
  console.log("All tests passed.");
}

run();
import { Board } from "../board";
import { pickBestMove } from "../engine";

console.log("Test: engine can suggest a move (may be null on empty board)");
const b = new Board();
// If your Board starts empty, this will be null (that's ok).
// Once you have a setup that places starting tiles, it should return a move.
const mv = pickBestMove(b, "host", 2);
console.log("Best move for host @ depth 2:", mv);
