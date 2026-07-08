# Royal Game of Ur — fix + reskin task for Deepseek

You are picking up work on the Royal Game of Ur mini-game inside this cardgame project
(Node/Express + socket.io backend, vanilla-JS frontend, no build step). Claude did the
investigation below; you do the implementation. Read this whole file before touching code —
the ordering matters (bug fixes first, then the reskin, in that order, with tests between).

## Context: why this file exists

The user reported "the royal game of ur part doesn't work at all, and looks bad, we need to
put this image as the table exactly." Claude's analysis found the game is currently **fully
broken** (server-side syntax error crashes the module) plus a rendering bug, and the user
supplied reference artwork that needs to become the board skin. Everything needed to do both
is below — exact line numbers, exact pixel coordinates, exact position mappings. You should
not need to re-derive anything; if something below doesn't match what you see in the files,
stop and flag the discrepancy rather than guessing.

---

## PART 0 — file map

- `game/ur/engine.js` — pure game logic (no networking). Exports used by `server.js`.
- `game/ur/bot.js` — bot AI, reads engine constants. Not broken, no changes needed.
- `public/ur/index.html` — page shell.
- `public/ur/client.js` — all client-side rendering + socket wiring. `POSITIONS` array here
  defines the visual (col,row) grid placement for each of the 20 board positions.
- `public/ur/style.css` — styling. Currently has duplicated/conflicting rule blocks (see Part 1).
- `public/ur/board-source.png` — the exact reference image the user provided, currently
  521×1299px (the user re-exported it once already; **check its actual current dimensions
  first** — `file public/ur/board-source.png` or open it — since it may have changed again by
  the time you read this, and the percentages in Part 3e are only valid for the exact file they
  were measured against). This is the "table" they want reproduced — use it as ONE single,
  unmodified background image for the whole board (see Part 3: no slicing, no per-cell tiles —
  an earlier version of this doc cropped it into 6 separate tile PNGs for verification purposes,
  but that was overkill for the actual implementation and has been removed; ignore any mention
  of a `tiles/` folder if you see one referenced stale anywhere).
- `public/ur/board.png` — an old, unrelated placeholder (colorful red/blue board) from a
  previous session. Not the user's image. Delete it once `board-source.png` is wired in and
  nothing references it anymore (check `style.css` for `url('board.png')` first).
- `public/ur/index.html.bak` and `test-ur-client.js` (project root) — stray debris from a
  previous broken session. Verified: neither is referenced anywhere in the repo (grepped for
  both filenames, only match is this doc). Safe to delete directly, no further check needed.

Run the app with `npm start` (runs `node server.js`, confirmed in `package.json`) or
`npm run dev` for auto-restart on change. Server listens on `http://localhost:3000` (or
`$PORT` env var if set). Exercise it at `http://localhost:3000/ur/` in a browser after each
part below. Note: this is actually a Hungarian card game project ("Bürge/Hühü") with the Ur
game as a secondary mini-game bolted on — don't be thrown by the `package.json` name/description
not mentioning Ur.

---

## PART 1 — fix the crash (do this first, it's why "doesn't work at all")

`game/ur/engine.js` fails to even load: `node -e "require('./game/ur/engine.js')"` throws
`SyntaxError: Unexpected token '}'` at line 158. Confirm this yourself before and after your
fix by running that exact command — it should print nothing (module loads cleanly) once fixed.

**Root cause**: the `legalMoves` function (lines ~113–186) contains the body of its inner
`addMove` helper duplicated three times in a row, with the 2nd and 3rd copies pasted as loose
statements outside any function (referencing an undefined `m`), left over from a bad edit in
an earlier session. Only the **first** copy (the one properly wrapped in
`function addMove(m) { ... }`) is real code.

**Fix**: delete the two orphaned duplicate blocks entirely. Keep exactly this structure and
nothing else in between:

```js
function legalMoves(state, player, roll) {
  if (state.turn !== player || roll === 0) return [];
  const pl = state.players[player];
  const path = pathFor(player);
  const moves = [];
  const seen = new Set();

  function addMove(m) {
    const key = m.action === 'bearOff' ? 'B' + m.piece : 'M' + m.piece + '_' + m.dest;
    if (seen.has(key)) return;
    seen.add(key);

    if (m.action === 'move') {
      const destPos = path[m.dest];
      const occ = occupant(state, destPos);
      if (occ && occ.player === player) return; // blocked by own piece
      if (occ && occ.player !== player && (!SHARED.has(destPos) || ROSETTES.has(destPos))) return; // can't capture on safe or rosette square
    }
    moves.push(m);
  }

  // Move existing pieces
  for (let i = 0; i < PIECE_COUNT; i++) {
    const curStep = pl.pieces[i];
    if (curStep === -1) continue; // at home

    const remaining = path.length - curStep;
    if (roll === remaining) {
      addMove({ piece: i, action: 'bearOff' });
    } else if (roll < remaining) {
      addMove({ piece: i, action: 'move', dest: curStep + roll });
    }
    // roll > remaining: cannot move this piece
  }

  // Enter new pieces from home
  const entryPos = path[0];
  const entryOcc = occupant(state, entryPos);
  if (!entryOcc || entryOcc.player !== player) {
    for (let i = 0; i < PIECE_COUNT; i++) {
      if (pl.pieces[i] === -1) {
        addMove({ piece: i, action: 'move', dest: 0 });
      }
    }
  }

  return moves;
}
```

That's it — the current file has the real code duplicated: `addMove`'s body appears once
properly (lines 120–132, ending `}`), then a first orphaned duplicate (lines 134–146, starting
with a stray `// Move existing pieces` comment), then a second orphaned duplicate (lines
147–159), then the REAL `// Move existing pieces` comment and working for-loop at line 160
onward (already shown in the code block above). Delete lines 134–159 entirely — everything
from the first stray `// Move existing pieces` comment up to (not including) the second,
real `// Move existing pieces` comment at line 160. Do not change `applyMove`, `checkWin`,
`viewFor`, etc. — those are fine.

After fixing, verify: `node -e "require('./game/ur/engine.js'); console.log('ok')"` prints `ok`.
Then run `node test/smoke-ur.js` — it plays 100 full bot-vs-bot games through the engine and
prints `✓ N/100 UR games completed with no integrity errors.`. It only calls the public API
(`createGame`, `rollDice`, `legalMoves`, `applyMove`, `currentActor`) and never hardcodes
position numbers, so it stays valid after the `ROSETTES` change in Part 3d too — run it again
after that change as a second checkpoint. Expect 100/100; investigate before proceeding if any
game errors out.

---

## PART 2 — fix `style.css` duplication

`public/ur/style.css` has the same problem as the engine: two conflicting `.board` and `.sq`
rule blocks back to back. Lines 80–94 are the **first** `.board` (sets
`background: url('board.png') ...`, the intended image-backed board), lines 96–119 are the
first `.sq` + tile-type rules (safe/shared/rosette, transparent, meant to let the board image
show through). Immediately after, **lines 120–155 are an exact duplicate**: a second `.board`
(sets `background: #5a3a20`, flat color, `grid-template-columns: repeat(8, 56px)`) and a second
`.sq`/tile-type block (opaque colors). This second block, being later in the file at equal
specificity, silently wins — that's why the board currently renders as a flat brown grid
instead of any image. Lines 156 onward (`.rosette-star`, hover/`.selectable`/`.legal-dest`,
`@keyframes pulse-dest`, and everything after) are NOT duplicated — leave those alone.

**Fix**: delete lines 120–155 entirely (the second `.board`, second `.sq`, and second tile-type
block only — stop right before the `/* Rosette star */` comment). You're about to replace the
first block's board CSS anyway for Part 3 (new vertical layout), so just remove the dead
duplicate now and build the new rules cleanly in Part 3.

---

## PART 3 — the reskin: vertical board matching the user's image

### 3a. Why the board is changing orientation

The current board is **horizontal**: `client.js`'s `POSITIONS` array lays out an 8-column ×
3-row CSS grid (`.board { grid-template-columns: repeat(8, 64px); grid-template-rows: repeat(3, 64px); }`).

The user's reference image (`public/ur/board-source.png`, currently 521×1299px — the user
re-exported it once after this doc was first written, with tighter cropping and two of the
icon motifs redrawn (the plain cross is now an Eye-of-Ra symbol, the square-in-square is now an
ankh-like symbol); the grid layout itself is unchanged, only the canvas margins and some icon
art changed, and all measurements below are re-verified against this current file) is
**vertical**: a 3-column-wide board, 8 rows tall, shaped like the classic Ur "dumbbell" rotated
90°. Claude measured it pixel-by-pixel (script-based, not eyeballed) and confirmed it is
**exactly** the 20-square topology the engine needs:

- Rows 1–2 (3 cols each) = the "small block" (6 squares)
- Rows 3–4 (middle column only) = the bridge (2 squares)
- Rows 5–8 (3 cols each) = the "big block" (12 squares)
- 6 + 2 + 12 = 20 ✓ — matches `PIECE_COUNT`-driven path lengths exactly, no invented squares.

So: rebuild the board as a **3-column × 8-row** logical grid instead of 8×3, and reposition all
20 squares into it using the mapping in 3c. This is a full replacement of `POSITIONS` in
`client.js` and the `.board`/`.sq` CSS — not a patch.

**Rendering approach (do this, it's simpler and more faithful than tiling):** display
`board-source.png` as a single, unmodified, unstretched-aspect-ratio background image filling
the whole `.board` container (`background-image: url('board-source.png'); background-size: 100% 100%`,
with `.board`'s width:height ratio locked to 521:1299 so it never distorts). Then place the 20
`.sq` elements as `position: absolute` boxes on top, sized/positioned with percentages (table in
3c-percent below) so each one sits exactly over its matching printed cell. Make `.sq` fully
transparent (no background, no border) by default — it exists only to catch clicks and to host
the piece element(s) and hover/legal-dest highlight styling, never to draw its own tile art.
This means you do **not** need per-square tile images at all; the single background image
already shows every cell's icon. This is simpler than tiling, has zero risk of visible seams
between adjacent tiles, and is a more literal reading of "use this image as the table exactly."

### 3b. IMPORTANT — a second bug found during this analysis, fix it as part of the rewrite

While deriving the new layout, Claude found the **current** `POSITIONS` array in `client.js`
(the old horizontal one) has a real adjacency bug, independent of the reskin: it places some
squares so that consecutive steps of a player's path are not neighboring cells on screen. This
was invisible before because the engine crash prevented anyone from ever seeing the board
render. Since you're rewriting `POSITIONS` from scratch for the vertical layout anyway, this
is moot for the old grid — just don't reproduce the bug in the new one. The mapping below (3c)
was derived directly from `PATH_0`/`PATH_1` adjacency (every consecutive pair of steps in both
paths is a physically neighboring cell in the new grid) and independently cross-checked against
where the image actually draws its rosette icons — trust it as-is rather than re-deriving.

### 3c. The verified position → (column, row) mapping

3-column × 8-row grid, 1-indexed, columns left→right, rows top→bottom (row 1 = top of image):

| pos | col | row | | pos | col | row |
|-----|-----|-----|-|-----|-----|-----|
| 0   | 1   | 5   | | 10  | 3   | 7   |
| 1   | 1   | 6   | | 11  | 3   | 8   |
| 2   | 1   | 7   | | 12  | 2   | 4   |
| 3   | 1   | 8   | | 13  | 2   | 3   |
| 4   | 2   | 5   | | 14  | 1   | 2   |
| 5   | 2   | 6   | | 15  | 1   | 1   |
| 6   | 2   | 7   | | 16  | 2   | 1   |
| 7   | 2   | 8   | | 17  | 2   | 2   |
| 8   | 3   | 5   | | 18  | 3   | 2   |
| 9   | 3   | 6   | | 19  | 3   | 1   |

Column identity is NOT "belongs to one player" throughout the whole board — it flips meaning
between the big block and the small block. Column 1 carries positions 0,1,2,3 (rows 5–8, part
of player 0's entry lane in the big block), but *also* carries positions 15,14 (rows 1–2, part
of player 1's exit lane in the small block). Don't try to color columns by player; just use
this table as literal coordinates.

Sanity check (do this yourself before wiring it up): trace `PATH_1` —
0→1→2→3→7→6→5→4→12→13→17→16→15→14 — through the table above. It should produce an unbroken
chain of orthogonally-adjacent cells: down column 1 (rows 5→8), across to column 2 at row 8, up
column 2 through the bridge to row 1, across to column 1 at row 1, down to row 2. Do the same
trace for `PATH_0` (8→9→10→11→7→6→5→4→12→13→17→16→19→18) — it mirrors `PATH_1` but runs down
column 3 instead of column 1, joining the same shared column-2 spine through the bridge, then
exiting via column 3 at row 1. If either trace has a jump between non-adjacent cells, the table
has an error — stop and flag it rather than continuing.

Replace `client.js`'s `POSITIONS` array with these 20 entries (`{ id, col, row }`), and change
the board CSS to a 3-column × 8-row grid.

### 3d. Rosette squares — deliberate rule change to match the artwork

Current engine: `ROSETTES = new Set([0, 4, 8, 14, 18])` (5 rosettes).

The image draws its 8-pointed-star "rosette" icon at exactly 4 cells: row1-col1, row1-col3,
row5-col1, row5-col3. Via the table above that's positions **19, 15, 0, 8**.

Recommendation (do this): change `game/ur/engine.js` to
`const ROSETTES = new Set([0, 8, 15, 19]);` — i.e. drop the old middle-of-shared-lane rosette
(old position 4) and shift the exit-lane rosette from 14/18 to 15/19. This makes the rosette
squares land exactly on the star-icon tiles with zero special-casing, and it's symmetric (each
player gets exactly one rosette in their entry lane at the point nearest the bridge, and one in
their exit lane at the point farthest from the bridge, right before the final bear-off square).
Verified by tracing both paths: `PATH_0` and `PATH_1` each pass through exactly 2 of these 4
squares.

Do NOT keep the old `{0,4,8,14,18}` set and paper over the mismatch with a star drawn on top of
a non-rosette tile — that was considered and rejected, it's more code for a worse result. If
the user later says they want 5 rosettes back for historical-accuracy reasons, that's a
one-line revert of this Set plus re-adding a star overlay; flag it to Claude/the user if it
comes up rather than deciding unilaterally.

This is the **only** gameplay-rule change in this task. Everything else (`SHARED`, `PATH_0`,
`PATH_1`, piece count, dice, capture rules) stays exactly as-is.

### 3e. Percentage-based cell rects — for positioning the invisible overlay squares

`board-source.png` is currently 521×1299px — check its actual dimensions first thing (it's been
re-exported twice already during this task; the percentages below are only valid for THIS exact
file). If it's changed size since, don't reuse this table — re-measure using the same method
Claude used: load the PNG, find the bounding box of near-white pixels (the artwork is white
line-art on a black background), then for each row/column find where the "span width of white
pixels" jumps between ~full-width (a block row) and ~one-column-wide (a bridge row) to locate
the 3 macro-regions, then within each region scan a couple of x/y lines just inside each cell's
border (not through the icon's center) and find where consecutive columns/rows agree on a
transition — that agreement is what separates a real grid line from icon linework. Convert the
resulting pixel boundaries to percentages of image width/height. Any general-purpose PNG
library (`pngjs`, `sharp`, etc.) works fine for this — it's about 40 lines of code, same as what
produced the numbers below. Cells are not perfectly uniform (hand-drawn source, rows range
~150–167px, columns ~167–170px at current resolution) — that's expected, don't treat small
variance as an error.

Column rects (`left` / `width`, as % of image width):
| col | left   | width  |
|-----|--------|--------|
| 1   | 1.73%  | 32.15% |
| 2   | 33.88% | 32.63% |
| 3   | 66.51% | 32.15% |

Row rects (`top` / `height`, as % of image height):
| row | top    | height |
|-----|--------|--------|
| 1   | 0.58%  | 12.63% |
| 2   | 13.20% | 12.39% |
| 3   | 25.60% | 12.59% |
| 4   | 38.18% | 12.51% |
| 5   | 50.69% | 12.24% |
| 6   | 62.93% | 12.16% |
| 7   | 75.10% | 11.70% |
| 8   | 86.80% | 12.51% |

(For context/audit trail only, not for use: the previous export had columns at roughly 26/42/58%
left and rows starting around 7/18/29/40/52/62/73/84% — visibly different from the table above
because that version had a wide black margin around the artwork that this crop removed. This is
exactly why re-measuring after any image edit matters, rather than assuming percentages carry
over.)

For each of the 20 positions, look up its (col,row) in the 3c table, then use that column's
(left,width) and that row's (top,height) here to set the `.sq`'s `position:absolute; left:_%;
top:_%; width:_%; height:_%` (all relative to `.board`, which must have the image as its
background and the locked aspect ratio — e.g. `aspect-ratio: 521/1299` or a fixed px size in
that ratio, matched to whatever `board-source.png`'s actual current dimensions are). Bridge
cells (positions 12, 13) only exist in column 2 — same lookup, they just happen to only ever be
referenced with `col=2`.

Rosette star indicator: `client.js` currently overlays a unicode ★ (`rosette-star` span) on
rosette cells. The source image already draws an 8-pointed star icon on its 4 rosette-look
cells, and (per 3d) the new `ROSETTES` set is defined to match those exact 4 cells — so the
unicode star overlay is now fully redundant on top of the image's own art. Remove the
`rosette-star` overlay entirely; the image already communicates it.

The `legal-dest` glow/pulse and `hover`/`selectable` outline styles (already in `style.css`,
untouched by Part 2's deletion) should still work unmodified on the transparent `.sq` elements —
they draw a border/box-shadow on the (now invisible) square, which will show up as a highlight
ring sitting on top of the background image. Verify this still looks good against the new
artwork (the image's own white grid-lines might make a thin highlight border harder to see —
if so, thicken it or add a subtle background-color tint only in the `legal-dest`/`hover` states,
not as a permanent per-square background).

---

## PART 4 — cleanup

Once the above is working and verified in a browser:
- Delete `public/ur/board.png` (old unrelated placeholder) if nothing still references it.
- Delete `public/ur/index.html.bak` and `test-ur-client.js` (project-root) — confirm via grep
  that `server.js` and `public/index.html` don't reference either before deleting.
- Leave `public/ur/board-source.png` in place — it's the real asset now in use, referenced
  directly from `style.css`/`client.js` as the board's background image.

---

## PART 5 — how to verify before handing back

1. `node -e "require('./game/ur/engine.js'); console.log('engine ok')"` → must print cleanly,
   no SyntaxError.
2. Start the server, open `/ur/`, start a singleplayer game vs bot.
3. Confirm the board renders as a **vertical** 3-wide board matching `board-source.png`'s
   general shape (small block top, bridge waist, big block bottom), not the old horizontal strip.
   It should look like the exact source image with no visible seams, gaps, or stretching — since
   it's one unmodified background image, any misalignment will show up as pieces appearing
   slightly off-center within their printed cell, not as a broken image; nudge the percentage
   rects in 3e only if you see that.
4. Roll dice, make a move, confirm: (a) legal-destination highlighting still works (this was
   the whole point of the last working commit, "one-click interaction" — don't regress it),
   (b) pieces render in the correct new cells, (c) landing on positions 0/8/15/19 grants an
   extra roll and is capture-safe, landing on 4/14/18 does NOT (since they're no longer
   rosettes) but is still capture-safe if simply not in `SHARED` (14/18 aren't shared anyway;
   only double check position 4, which IS in `SHARED` and is no longer a rosette — confirm it's
   now capturable, that's the intended behavior change).
5. Play at least one full game through to a win to confirm bear-off still triggers correctly
   (this exercises the full `PATH` array end-to-end and would catch a mis-mapped position fast).
6. Report back what you changed, and flag anything in this doc that turned out to be wrong
   when checked against the actual files/image — don't silently paper over a mismatch.
