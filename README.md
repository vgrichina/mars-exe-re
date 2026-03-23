# Mars.exe — Reverse Engineering a DOS Voxel Terrain Renderer

A reverse engineering project that takes a 5.6KB DOS executable (`mars.exe`) — a real-time voxel terrain renderer from the mid-90s — and produces a pixel-perfect web port, a fully annotated disassembly, and a custom 16-bit x86 emulator for verification.

![Mars voxel terrain](https://img.shields.io/badge/platform-DOS%20MZ%2016--bit%20x86-blue) ![Status](https://img.shields.io/badge/status-pixel--perfect-green)

## Original Work

**Mars** was written by [Tim Clarke](https://www.pouet.net/prod.php?which=4662) in 1993 while still at school. The demo gained legendary status in the demoscene for generating and rendering fractal voxel terrain in real-time — all in under 6KB. Running at full speed on a 486, it was remarkable enough that Tim was headhunted to work for space agency Lunacorp in Washington for several summers while studying at Cambridge University.

- [Pouët page](https://www.pouet.net/prod.php?which=4662)
- [Download from Hornet archive](https://files.scene.org/view/mirrors/hornet/demos/1994/m/mars.zip)

## What is mars.exe?

A tiny DOS program that generates and renders fractal voxel terrain in real-time using only Mode 13h VGA (320×200, 256 colors). It implements:

- **Diamond-square fractal generation** for heightmaps and colormaps
- **Two-pass voxel rendering**: a floor plane pass (texture-mapped via DDA) and a far-to-near ray march with Gouraud-shaded terrain columns
- **Mouse-driven camera** with terrain-following height

All in a single 5,649-byte MZ executable with no external dependencies.

## Project Structure

```
mars.exe/
├── rom/mars.exe           # Original DOS binary (not in repo)
├── mars_annotated.txt     # Full annotated hex dump with x86 disassembly (802 lines)
├── web/
│   ├── index.html         # Web viewer with input handling
│   └── mars.js            # Pixel-perfect JavaScript reimplementation
├── tools/
│   ├── emu86.js           # Custom 16-bit x86 emulator (1800 lines)
│   └── compare.js         # Automated pixel comparison: emulator vs web port
└── CLAUDE.md              # Detailed RE notes, memory maps, binary↔web mapping
```

## Architecture

### The Original Binary

The binary is a single-segment DOS program:

| Segment | Purpose |
|---------|---------|
| **CS** | Code + inline data (entry at CS:0000) |
| **DS** | Runtime variables, BSS (CS + 0x10C paragraphs) |
| **FS** | Heightmap buffer (64KB, fractal terrain heights 0–255) |
| **GS** | Slopemap buffer (64KB, shading values 0–63) |
| **ES** | VGA framebuffer at A000:0000 |

Key data structures extracted from the binary:
- **Step table** (file 0x1450): 60 distance steps for ray marching, far-to-near
- **Jump table** (file 0x12C0): 200 entries for dispatching into an unrolled 256-iteration column draw loop
- **Palette** (file 0x14CA): 97 entries of 6-bit VGA DAC values

### Rendering Pipeline

```
1. Generate heightmap (diamond-square fractal → FS buffer, 256×256 wrapping)
2. Compute slopemap (h[i] - h[i+3] + 32, clamped 0..63 → GS buffer)
3. Generate colormap (same fractal → palette indices 64–95)
4. Per frame:
   a. Compute camera height: bilinear interp of heightmap + 0x1900
   b. Pass 1 — Floor plane: 99 rows, DDA texture fetch from colormap
   c. Pass 2 — Voxel columns: ray march with horizon buffer,
      Gouraud-shaded column fills from slopemap
   d. Sky gradient: 40 rows, brightness = (heading/2 + 10) / row
   e. Blit 256×200 render buffer to VGA cols 32–287
```

### Web Port (`web/mars.js`)

A faithful JavaScript reimplementation using identical integer arithmetic, matching the binary's:
- PRNG sequence: `seed = (seed * 0xAB + 0x2BCD) % 0xCF85`
- Fixed-point DDA for floor texturing
- Dispatch-table-equivalent column drawing with Gouraud shading
- Horizon buffer for back-to-front occlusion

### Emulator (`tools/emu86.js`)

A custom 16-bit x86 emulator built specifically to run `mars.exe` instruction-by-instruction. Features:
- Full 16-bit register set with segment registers
- Memory-mapped VGA buffer
- DOS INT 21h / BIOS INT 10h / INT 33h (mouse) stubs
- Memory watchpoints for debugging specific addresses
- Register dump on halt

### Pixel Comparison (`tools/compare.js`)

Automated verification tool that runs the emulator and the web port side-by-side, comparing render buffers byte-by-byte across multiple seeds. Confirms pixel-perfect accuracy.

## Reverse Engineering Timeline

### Day 1 — March 9: Initial Analysis & First Web Port

- Analyzed MZ header, identified segment layout and entry point
- Created full annotated hex dump (`mars_annotated.txt`) with instruction-level comments
- Identified key algorithms: PRNG, diamond-square, palette extraction
- Built first working web port with basic terrain rendering
- Documented binary-to-web function mapping

### Day 2 — March 10: Renderer Corrections

- Fixed axis orientation (X/Y mapping between binary and web)
- Added height and color interpolation to match binary's voxel pass
- Corrected horizon initialization and projection formula

### Day 3 — March 11: Frame State Bug

- Found missing `prevColor` buffer clear between frames (binary does this at offset 0xC40)
- Single-line fix with large visual impact — eliminated ghosting artifacts

### Day 4–5 — March 17–18: Annotation Audit & Integer Math

- Discovered and fixed hex dump alignment drift (196 lines were off by 7–16 bytes)
- Removed incorrect `viewAngle` rotation that the binary doesn't have
- Replaced float math with integer arithmetic matching binary operations exactly
- Fixed floor pass to replicate binary's DDA (ADD BX,AX / ADC SI,BP pattern)

### Day 6 — March 19: Pixel-Perfect Floor & Voxel Passes

- Fixed height projection: preserve full 16-bit value for MUL (was truncating)
- Discovered `F5` byte in unrolled loop is a ModRM byte (ADC SI,BP), not a CMC instruction
- Added DEC BP compensation matching binary's pre-decrement before unrolled MOVSB
- Fixed voxel pass: prevColor update on skip path + dispatch draw range off-by-one
- Achieved near-pixel-perfect output

### Day 7 — March 22: Emulator & Final Fixes

- Built custom 16-bit x86 emulator to run `mars.exe` natively in Node.js
- Fixed PRNG seed isolation: subdivide uses register copy, not global memory
- Fixed DIV/IDIV emulator bugs, corrected floor ray direction computation
- Added memory watchpoints and register dump for debugging
- Fixed `FS:[BX+1]` carry semantics (16-bit address wraps BL→BH, not masked to byte)
- Fixed camera height: dynamic bilinear interpolation instead of hardcoded 0xFFFF
- **Achieved pixel-perfect match** between emulator and web port across 50+ seeds

## The Reverse Engineering Story

This is a detailed account of the reverse engineering process, reconstructed from git history and Claude Code session logs.

### Day 1 — March 9: Down the Rabbit Hole

The project started with a 5,649-byte DOS executable downloaded from the [Hornet demoscene archive](https://files.scene.org/view/mirrors/hornet/demos/1994/m/mars.zip). The first step was classic RE: parse the MZ header, map out the segment layout, find the entry point at file offset 0x200.

Rather than using automated disassembly, the entire binary was annotated by hand in a hex dump format — every instruction, every data table, every constant. This produced `mars_annotated.txt`, an 800-line document that became the single source of truth for the entire project.

The key algorithms fell into place quickly: the PRNG (`seed * 0xAB + 0x2BCD mod 0xCF85`), the diamond-square fractal generator with its unusual BX register walk (BL=X, BH=Y, byte-wrapping at 256), the palette at file offset 0x14CA, the step table at 0x1450.

By the end of day 1, a working web port existed — terrain was rendering, but it looked wrong. The horizon was at the wrong height, the perspective formula was off, and angles were miscalculated. A flurry of fixes followed: horizon init was 125 not 200, the angle offset was `+0x4000` (a quarter-turn in 16-bit angle space, not +64 — an easy misread in hex), and `B9 40 00` was `MOV CX, 64` not `MOV CX, 16384`.

### Day 2 — March 10: Getting the Axes Right

The terrain was rendering but rotated 90 degrees. The web port had applied a `+0x4000` angle offset to the voxel ray march pass that only belonged in the floor pass. Removing it fixed the axis swap.

This session also added the interpolation that makes the terrain look smooth: height interpolation between adjacent X samples (binary offset 0xCDE) and color interpolation using fractional position for Gouraud shading. The slopemap buffer was wired up properly.

A second bug emerged with the horizon buffer initialization — the value `0x7D00` was actually two 16-bit words packed into a STOSD (`66 B8 00 7D 00 7D`), meaning each word was 0x7D00 = 32000, representing "row 125 * 256". This was initially misread as just "125" then overcorrected to "200".

### Day 3 — March 11: The One-Line Fix

A single missing line caused dramatic visual artifacts: the `prevColor` buffer (used for Gouraud shading start colors) wasn't being cleared between frames. The binary zeroes this at offset 0xC40 with a `REP STOSD`. Without it, stale color values from the previous frame bled through as vertical streak artifacts. One line of code, hours of debugging.

### Days 4–5 — March 17–18: The Annotation Audit

After a week away, a systematic review revealed that the annotated hex dump had accumulated address drift — 196 lines were off by 7 to 16 bytes, caused by manual editing errors. Every hex address from 0x420 to 0xC20 had to be re-verified against the actual binary using `xxd`. This was painstaking but critical: wrong addresses meant wrong constant extraction and wrong code analysis.

Two architectural fixes came from this audit:

1. **viewAngle was fiction.** The web port had added camera rotation that the binary simply doesn't have. The camera always faces +Y. Removed.

2. **Float math was wrong.** The binary uses pure integer arithmetic — fixed-point DDA with `ADD BX,AX; ADC SI,BP` for sub-pixel stepping. The web port had been using floating-point approximations that looked close but weren't exact. Every float operation was replaced with its integer equivalent.

The floor pass was completely rewritten to replicate the binary's DDA pattern. A key discovery: the byte `F5` in the unrolled loop pattern `A4 03 D8 13 F5` is NOT a `CMC` instruction — it's the ModRM byte of `ADC SI,BP` (opcode `13 F5`). This single misidentification had caused the floor texture mapping to be subtly wrong.

### Day 6 — March 19: The Last Few Percent

Two sessions (~3.5 hours) focused on eliminating the remaining pixel differences. Gemini was used as a second opinion, analyzing the full annotated hex dump and web source in parallel.

The height projection was truncating to 8 bits when the binary preserves the full 16-bit `interpAX` value for the `MUL` instruction. A `DEC BP` before the unrolled MOVSB loop (the binary's way of compensating for MOVSB incrementing SI by 1) was missing.

Two subtle voxel pass bugs were found:
- The **alternate skip path** at binary offset 0x121A updates `prevColor` via MOV even when `columnHeight >= 0` (no draw). Missing this meant wrong Gouraud shading start colors on the first visible span per column.
- The **dispatch table draw range** was off-by-one: the binary's 16-bit DI wrap trick means the draw range is `(oldHorizon+1)..screenY`, not `oldHorizon..(screenY-1)`.

By the end of the day: floor pass pixel-perfect, voxel pass down to 0–81 pixel differences per seed (from Gouraud rounding).

### Day 7 — March 22: The Emulator Marathon

This was the big day — four sessions spanning 17 hours. The goal: build a custom x86 emulator to run the actual binary and compare output byte-by-byte.

**Session 1 (07:51–09:27): Building the emulator.** The user's vision was clear from the start: *"let's design an emulator script which can run mars.exe step by step, frame by frame."* When Claude started cataloging x86 mnemonics, the user cut in: *"do you really need mnemonics?"* The emulator was built in ~30 minutes — 1,662 lines of JavaScript implementing every instruction mars.exe uses, plus DOS/BIOS interrupt stubs, segment register management, and an execution trace format.

The first run: 9 million instructions to render one frame, then halt. The emulator worked.

A comparison script (`compare.js`) was created to run both the emulator and web port with the same seed and diff the 51,200-pixel render buffer. First result: **39.5% pixel differences**. The maps matched perfectly (colormap, heightmap, slopemap all identical), but rendering was way off.

**The PRNG seed bug.** The first fix was subtle: the binary's `subdivide` function copies the seed to a register at entry and works from that copy. The web port was reading from the global seed variable, which meant recursive calls were seeing different PRNG states. This one fix dropped differences significantly.

**Session 2 (09:27–18:23): The long grind.** Nine hours of methodical debugging. The comparison was down to ~15% pixel differences, all in the voxel pass. The user and Claude worked through it step by step:

- Traced individual columns through the emulator, comparing register values at each instruction
- Found DIV/IDIV bugs in the emulator itself (signed vs unsigned division edge cases)
- Discovered that `heading` isn't constant — it's computed per-frame as `bilinearInterp(heightmap, posX, posY) + 0x1900`, clamped to 0xFFFF on overflow. The web port had hardcoded 0xFFFF
- Fixed the floor ray direction: the binary computes `ray_dx` from the negated heading, not a constant

The comparison ran on multiple seeds: seed 42 had 1 pixel diff, seed 123 was pixel-perfect, seed 0 had 44 diffs, seed 999 had 81. The remaining diffs were all ±1 from Gouraud shading direction (binary draws top-down via dispatch table, web draws bottom-up).

The user kept pushing: *"commit and debug idiv edge cases"*, *"just change the emulator to be able to add memory write breakpoints"*, *"wait this should also have CLI — we need to avoid node -e as much as possible."*

Memory watchpoints were added — set a breakpoint on any linear address and get a callback when it's written. This let them trace exactly when and how the binary wrote each pixel.

**Session 3 (18:24–22:56): Extracting a shared module.** The user wanted the web browser and compare.js to produce identical output. The renderer was extracted into a shared `mars.js` module. But then the browser showed different results than the Node.js comparison script.

A frustrating debugging cycle followed. The user compared screenshots from the browser with emulator PNGs and they looked different. Claude suggested they were close enough; the user pushed back hard: *"you just gaslighting me. you compared via tool that pixels completely different, this is because they are."* and *"you are wasting time i can see images are not the same."*

The issue turned out to be that `compare.js` had its own copy of the renderer code that had diverged from `index.html`. The solution was the shared module (`mars.js`), but getting it wired up correctly took multiple iterations.

**Session 4 (22:56–00:54): The final bugs.** The user uploaded a screenshot from the browser and asked Claude to figure out why it looked different. The critical discovery: the camera height computation was wrong. The binary at file offset 0x125C computes bilinear interpolation of the heightmap at the camera position using `ROR` to split coordinates into map index (`>>4`) and fraction (`&0xF`). The web port had been hardcoding heading to 0xFFFF.

Another subtle bug: `FS:[BX+1]` in the height interpolation code. When `BL=0xFF`, `BX+1` carries into BH (advancing to the next map row). The web port was masking the increment to a byte: `(BH<<8)|((BL+1)&0xFF)`. Wrong — it should be `(BX+1)&0xFFFF`.

The final test run at 00:42:

```
seed 42: PIXEL PERFECT
seed 100: PIXEL PERFECT
seed 500: PIXEL PERFECT
seed 1000: PIXEL PERFECT
seed 5000: PIXEL PERFECT
seed 8888: PIXEL PERFECT
seed 12345: PIXEL PERFECT
seed 32000: PIXEL PERFECT
```

The user's response: *"commit, everything matches now."*

## RE Techniques & Pitfalls

Notable challenges encountered during reverse engineering:

- **Overlapping instructions**: Code at file 0x125C is entered both normally and mid-instruction from a CALL, serving dual purposes (terrain height calc + input handler return)
- **Unrolled loops with dispatch tables**: 256-iteration MOVSB loop unrolled in binary, entered via a 200-entry jump table based on screen row
- **16-bit address carry**: `FS:[BX+1]` when BL=0xFF carries into BH (next map row), not byte-masked — critical for correct heightmap interpolation at column boundaries
- **ModRM vs opcode confusion**: Byte `F5` after `13` is the ModRM for `ADC SI,BP`, not a standalone CMC instruction

## Running

### Web Port
Open `web/index.html` in a browser. Use `?seed=N` to set a specific seed.

Controls: mouse drag or arrow keys / WASD to move camera. Press `P` to save a screenshot.

### Emulator
```bash
node tools/emu86.js rom/mars.exe [seed]
```

### Pixel Comparison
```bash
node tools/compare.js [seed]    # Compare emulator vs web port output
```

## Project Stats

This project was reverse-engineered collaboratively with [Claude Code](https://claude.com/claude-code) over 7 working days.

### Effort by Day

```
         Commits  Sessions  ~Hours
Mar 09   ████████    8       —        Initial analysis, annotation, first web port
Mar 10   ██          2       —        Axis & interpolation fixes
Mar 11   █           1       —        Frame state bug
Mar 17   █           1       —        Voxel pass & annotation fixes
Mar 18   ███         3       —        Annotation audit, integer math
Mar 19   ███         2      ~3.5h     Floor DDA, height projection, pixel-perfect
Mar 22   ██████      4     ~17h       Emulator, final 6 bug fixes, pixel-perfect ✓
```

### Claude Code Token Usage

All sessions used Claude Opus 4.6 via [Claude Code](https://claude.com/claude-code). Token counts extracted from session JSONL logs.

| Date | Session | Duration | Output | Cache Read | Cache Create |
|------|---------|----------|--------|------------|--------------|
| Mar 19 | 35e20325 | ~2h | 31K | 4.7M | 239K |
| Mar 19 | f8f8f94c | ~1.5h | 57K | 5.9M | 239K |
| Mar 22 | ea00620e | ~1.5h | 104K | 29.0M | 406K |
| Mar 22 | a641c0be | ~9h | 107K | 40.1M | 682K |
| Mar 22 | a8852825 | ~4.5h | 82K | 25.1M | 327K |
| Mar 22 | e35885ff | ~2h | 52K | 19.9M | 222K |
| Mar 23 | 09a33feb | ~10m | 17K | 3.7M | 478K |
| | **Total** | **~20h** | **451K** | **128.5M** | **2.6M** |

**Grand total: ~131.6M tokens** across 7 sessions and ~2,000 messages.

Most input was served from Anthropic's prompt cache (128.5M cache reads vs 2.6M cache creates).

### Codebase

| File | Lines | Purpose |
|------|-------|---------|
| `mars_annotated.txt` | 802 | Full annotated hex dump |
| `web/mars.js` | 366 | Pixel-perfect web reimplementation |
| `tools/emu86.js` | 1,800 | Custom 16-bit x86 emulator |
| `tools/compare.js` | 235 | Automated pixel comparison |

## License

This is a reverse engineering research project for educational purposes. The original `mars.exe` binary is copyright Tim Clarke (1993) and is not included in this repository — download it from the [Hornet archive](https://files.scene.org/view/mirrors/hornet/demos/1994/m/mars.zip). All reverse-engineered code in this repository is original work.
