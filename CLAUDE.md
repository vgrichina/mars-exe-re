# Mars (DOS) — Reverse Engineering Project

## Platform: DOS MZ executable, 16-bit x86 (386+)

## Binary
- Path: `rom/mars.exe`
- Format: MZ, 5649 bytes, single code+data segment
- Entry: CS:IP = 0000:0000 (file offset 0x200)

## Address conventions
- File offsets: `0xXXXX` (hex with 0x prefix)
- CS:0000 = file 0x200. Code offset = file_offset - 0x200
- DS:0000 = file 0x12C0 (CS + 0x10C segments)
- labels.csv format: `offset,name,comment` — offset with 0x prefix

## Annotated source
- `mars_annotated.txt` — full annotated hex dump with instruction-level comments
- Use annotated hex NOT ndisasm for analysis (user preference)

## Key segments
- CS = load segment (code + inline data)
- DS = CS + 0x10C (runtime data, heightmap pointers, variables)
- FS = heightmap buffer (CS + 0x0E07) — buffer1, smoothed fractal heights
- GS = slope/shading buffer (CS + 0x1E07) — buffer2, h[i]-h[i+3]+32 clamped 0..63
- VGA framebuffer: A000:0000

## Key DS variables (BSS, beyond file end)
| Offset | Name | Notes |
|--------|------|-------|
| DS:032F | smooth_offsets | 4 words: {0x0000, 0x0004, 0x0202, 0xFEFF} — neighbor offsets for first smooth kernel |
| DS:033D | vga_seg | 0xA000 (VGA framebuffer segment) |
| DS:034D | prng_mod | 0xCF85 (PRNG modulus constant) |
| DS:034F | smooth_sel | 0x0001 (kernel selector: val<<4 indexes into offset table at DS:031F) |
| DS:0351 | pos_x | Camera X, init 1000 |
| DS:0353 | pos_y | Camera Y, init 1000 |
| DS:0355 | prev_x | Saved pos_x each frame |
| DS:0357 | prev_y | Saved pos_y each frame |
| DS:0359 | heading | Camera terrain height: bilinear_interp(heightmap, posX, posY) + 0x1900, clamped to 0xFFFF on overflow. Controls perspScale (heading/SI+100) |
| DS:035B | mouse_present | Flag from INT 33h |
| DS:035D | random_seed | From BIOS timer INT 1Ah |
| DS:035F | quit_flag | Set on keypress |
| DS:03A0 | distance_counter | Step table word offset, starts 0x78=120 |
| DS:03A2 | perspective_scale | heading/SI + 100 (dynamic, not constant) |
| DS:03A4 | height_scale | 0x10000 / SI |
| DS:03A6 | step_size | SI << 6 (dword) |
| DS:03AA | horizon_buf | 256 words, init 0x7D00 (=125) |
| DS:07AA | render_buf | 256×200 bytes, blitted to VGA cols 32-287 |

## Web Port

The `web/index.html` is a reimplementation of the voxel terrain renderer.

### Key algorithms ported
1. **PRNG**: `seed = (seed * 0xAB + 0x2BCD) % 0xCF85`; perturbation = `(half * (seed - 0x67C2)) >> 13`, CBW-clamped to signed byte
2. **Diamond-square**: uses binary's BX register walk (BL=X, BH=Y, byte-wrapping at 256). Seeds corners, computes 4 edge midpoints + center, recurses on 4 quadrants
3. **Heightmap post-processing**: First smooth uses table-driven asymmetric kernel with offsets {0, +4, +514, -257} loaded from DS:032F-0335 via `[034F]<<4` index → slope calc from buffer1 to buffer2/slopemap (`h[i]-h[i+3]+32`, clamp 0..63) → second smooth uses standard 2×2 box {0, +1, +256, +257}. Heightmap retains fractal heights (0-255 range), slopemap has slope/shading values (0-63)
4. **Colormap**: same fractal, transformed to palette indices 64-95 (`byte>>3 + 0x40`)
5. **Renderer**: Two-pass architecture:
   - **Pass 1 (floor plane)**: render_columns (0x659). Draws flat ground texture from colormap using 1/y perspective scaling (DIV ECX). Per row: ray_x/ray_y reloaded from [0364]/[0368], offset by ±step (ray_x -= step centers X sweep, ray_y += step provides forward depth). DEC BP before unrolled loop compensates for MOVSB SI++. 256 MOVSB per row with DDA (ADD BX,AX; ADC SI,BP). Note: F5 in pattern A4 03 D8 13 F5 is the ModRM byte of ADC SI,BP, NOT a CMC instruction. 99 rows (ECX=99→1).
   - **Pass 2 (voxel heights)**: ray_march (0xC1F). Far-to-near with horizon buffer, draws 3D terrain columns over floor. Height interpolation between adjacent heightmap samples. Slopemap Gouraud shading via dispatch table (MOV [DI+off],DH; ADD DX,AX).
6. **Palette**: 97 entries (indices 0-96) extracted from binary at file offset 0x14CA (6-bit VGA DAC values). Entry 96 = white (compass indicator)
7. **Sky gradient**: `val = clamp((heading>>>1 + 10) / row) >>> 7, 63)` for 40 rows

### Rendering constants (verified against binary)
| Constant | Binary value | Source |
|----------|-------------|--------|
| Horizon init | 0x7D00 (row 125 × 256) | 0xC27: `66 B8 00 7D 00 7D` (STOSD fills words with 0x7D00) |
| Angle offset | 0x4000 | 0x66D: `05 00 40` (ADD AX, 0x4000) |
| Angle shift | SHR (unsigned) | 0x66A: `C1 E8 03` |
| Perspective center | heading/SI + 100 | 0xC60: `33 D2 F7 F6 05 64 00` (XOR DX; DIV SI; ADD AX,100) |
| Height scale | 0x10000/SI | 0xC91: `F7 F6` (DIV SI) |
| Map position | posX>>4, posY>>4 | 0xCB0: `C1 E2 04` (SHL DX,4 → DH=high) |
| Sky fill | 1 row + 40 gradient | 0xBE3: CX=0x40 (64 dwords) |
| Sky gradient input | heading>>>1 | 0xBED: `D1 EE` (SHR SI,1) |

### Binary → web mapping
| Binary function | File offset | Web equivalent |
|----------------|-------------|----------------|
| entry + init | 0x200-0x2A5 | `genColormap()`, `genHeightmap()` |
| gen_colormap | 0x2F3 | `genColormap()` |
| gen_heightmap | 0x353 | `genHeightmap()` |
| subdivide | 0x419 | `subdivide(buf, start, size)` |
| handle_input | 0x608 | mouse/touch/keyboard handlers |
| camera_height | 0x125C | `cameraHeight()` — bilinear heightmap interp at camera pos |
| render_columns | 0x659 | `render()` — Pass 1 floor plane loop |
| unrolled column draw | 0x6DA-0xBD4 | floor pixel loop in `render()` (per-col in JS vs unrolled MOVSB) |
| fill_sky | 0xBDC | sky gradient in `render()` |
| ray_march | 0xC1F | distance-step loop in `render()` |
| dispatch table draw | 0xD3A+ | column fill loop with Gouraud shading in `render()` |
| height interpolation | 0xCD8-0xCEE | height interp between adjacent samples in `render()` |
| color interpolation | 0xD1C-0xD36 | slopemap color interp + XCHG step blending in `render()` |
| alternate skip path | 0x121A | color compute + MOV prevColor when columnHeight >= 0 (no draw) |
| overlapping instruction | 0x125C | (not ported — handle_input trick) |
| Jump table | 0x12C0 | (not needed — web uses loop) |
| Step table | 0x1450 | `stepTable[]` array |
| Palette data | 0x14CA | `PAL6[]` array |

## RE Process

### Methodology
1. **Binary identification**: MZ header analysis, segment layout, relocation table
2. **Data extraction**: Palette (0x14CA), step table (0x1450), jump table (0x12C0) — extract with Python struct
3. **Annotated hex dump**: `mars_annotated.txt` — manually annotated hex with instruction-level comments. Preferred over automated disassembly for accuracy
4. **Cross-referencing**: Use `xxd rom/mars.exe | grep` to inspect bytes at specific offsets and verify constants
5. **Gemini second opinion**: For large-scale analysis, use `gemini -p "@mars_annotated.txt @web/index.html <question>"` with output redirect
6. **Constant verification**: Extract numerical constants from binary hex, compare against web port values
7. **Web port iteration**: Fix mismatches found in binary analysis, test in browser

### Key RE techniques used
- **Overlapping instructions**: Binary has overlapping code at file 0x125C (JNZ opcode doubles as TEST+STC+RET when entered mid-instruction from handle_input's CALL)
- **Fixed-point arithmetic**: 32-bit fixed-point DDA for ray stepping (ADD BX,AX; ADC SI,BP; CMC pattern)
- **Unrolled loops**: 256-iteration column draw at 0x6DA-0xBD4 (DEC BP at 0x6DA, then pattern: A4 03 D8 13 F5 = MOVSB + ADD BX,AX + ADC SI,BP; F5 is ModRM not CMC)
- **Jump table dispatch**: 200-entry table at 0x12C0 for entering unrolled draw at correct scanline

### Pitfalls discovered
- `B9 40 00` is MOV CX, 0x0040 (64), NOT 0x4000 (16384) — easy to misread in hex dumps
- Heading = bilinear_interp(heightmap, posX, posY) + 0x1900 — depends on terrain height at camera position
- Map coordinates use posX>>4 / posY>>4, not raw position values
- `05 00 40` = ADD AX, 0x4000 (not +64) — the 0x4000 is a quarter-turn in 16-bit angle space
- Binary alternate path (0x121A) updates prevColor via MOV even when skipping draw (columnHeight >= 0) — missing this causes wrong Gouraud shading start colors on first visible span per column
- Binary dispatch table uses 16-bit DI wrap trick: DI=screenY*256+base, dispatch offsets for rows 57-255 wrap around 65536 to land at rows (oldHorizon+1)..screenY — draw range is +1 shifted from naive (oldHorizon)..(screenY-1)
- `FS:[BX+1]` in height/slope interpolation is a 16-bit address increment: when BL=0xFF, BX+1=BX+1 carries into BH (next map row). The "next sample" is NOT `(BH<<8)|((BL+1)&0xFF)` — it's `(BX+1)&0xFFFF`. This matters at x=255 column boundaries.

### Known differences from binary
- Web uses cos/sin for ray direction; binary uses fixed-point DDA
- Binary has two rendering passes: Pass 1 (floor plane via MOVSB from colormap, per-pixel ray advance) + Pass 2 (voxel heights via dispatch table with slopemap Gouraud). Web implements both passes with float math
- Keyboard arrows/WASD move camera in fixed X/Y directions (binary only has mouse input)
- heading = cameraHeight(posX,posY) + 0x1900, clamped to 0xFFFF. CS:105C (file 0x125C) computes bilinear interpolation of heightmap at camera position using ROR to split coords into map index (>>4) and fraction (&0xF). perspScale varies with distance (heading/SI+100)
- Both smooth passes now match binary in-place behavior (each output feeds subsequent inputs)
- Sky gradient now at rows 99-139 matching binary (DI continues from floor pass)
- Gouraud color step sign now matches binary IDIV by negative BP
- Floor pass now includes forward depth offset: per-row Y = camY + 2048/ECX (binary: ray_y += step per row)
- Segment assignments in MOVSB pass: DS=colormap [034B], GS=DS segment [0345], ES=DS segment (render buffer destination). Annotation previously had DS/ES swapped.
- Binary's handle_input CALL CS:105C (file 0x125C) computes camera terrain height via bilinear heightmap interpolation. ADD AH,19h offsets by 0x1900; JNC/MOV FFFF clamps on overflow. Web port now computes this dynamically via cameraHeight().
- Web port is now pixel-perfect against binary (verified across 50+ seeds via tools/compare.js)
