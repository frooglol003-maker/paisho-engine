"use strict";
// eval.ts
// A simple evaluation to use inside minimax. This is intentionally simple and tunable.
// Score is from the perspective of 'host' (positive => host leads).
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluate = evaluate;
const board_1 = require("./board");
const move_1 = require("./move");
// Material values (tweak as needed)
const VAL_BASIC = 10; // each basic flower tile base value
const VAL_R3 = 10, VAL_R4 = 12, VAL_R5 = 14;
const VAL_W3 = 10, VAL_W4 = 12, VAL_W5 = 14;
const VAL_LOTUS = 8;
const VAL_ORCHID = 9;
const VAL_ACCENT = 6;
function evaluate(board) {
    let score = 0;
    // material
    const size = board.toArray().length;
    for (let i = 1; i <= size; i++) {
        const packed = board.getAtIndex(i);
        if (!packed)
            continue;
        const p = (0, board_1.unpackPiece)(packed);
        const ownerSign = p.owner === 0 ? 1 : -1;
        switch (p.type) {
            case board_1.TypeId.R3:
                score += ownerSign * VAL_R3;
                break;
            case board_1.TypeId.R4:
                score += ownerSign * VAL_R4;
                break;
            case board_1.TypeId.R5:
                score += ownerSign * VAL_R5;
                break;
            case board_1.TypeId.W3:
                score += ownerSign * VAL_W3;
                break;
            case board_1.TypeId.W4:
                score += ownerSign * VAL_W4;
                break;
            case board_1.TypeId.W5:
                score += ownerSign * VAL_W5;
                break;
            case board_1.TypeId.Lotus:
                score += ownerSign * VAL_LOTUS;
                break;
            case board_1.TypeId.Orchid:
                score += ownerSign * VAL_ORCHID;
                break;
            case board_1.TypeId.Rock:
            case board_1.TypeId.Wheel:
            case board_1.TypeId.Boat:
            case board_1.TypeId.Knotweed:
                score += ownerSign * VAL_ACCENT;
                break;
        }
    }
    // harmony bonuses — count edges in harmony graph and give small bonus per harmony for owner
    try {
        const graph = (0, move_1.buildHarmonyGraph)(board);
        for (const [node, edges] of graph.entries()) {
            // each edge counted twice in adjacency list; account per-edge by half
            const descPacked = board.getAtIndex(node);
            const owner = (0, board_1.unpackPiece)(descPacked).owner;
            const ownerSign = owner === 0 ? 1 : -1;
            score += ownerSign * 0.5 * edges.length; // small bonus per adjacency
        }
    }
    catch {
        // ignore failures
    }
    // ring bonus/match end: big bonus if ring found
    try {
        const rings = (0, move_1.findHarmonyRings)(board);
        for (const ring of rings) {
            // approximate ring ownership by majority of nodes' owners
            let hostCount = 0, guestCount = 0;
            for (const idx of ring) {
                const p = (0, board_1.unpackPiece)(board.getAtIndex(idx));
                if (p.owner === 0)
                    hostCount++;
                else
                    guestCount++;
            }
            if (hostCount > guestCount)
                score += 200;
            else if (guestCount > hostCount)
                score -= 200;
            else
                score += 0;
        }
    }
    catch {
        // ignore
    }
    return score;
}
