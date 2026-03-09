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
- FS = heightmap buffer (CS + 0x0E07)
- GS = colormap buffer (CS + 0x1E07)
- VGA framebuffer: A000:0000

## Key DS variables (BSS, beyond file end)
| Offset | Name | Notes |
|--------|------|-------|
| DS:0351 | pos_x | Camera X, init 1000 |
| DS:0353 | pos_y | Camera Y, init 1000 |
| DS:0355 | prev_x | Saved pos_x each frame |
| DS:0357 | prev_y | Saved pos_y each frame |
| DS:0359 | heading | Angle/direction (binary: 0 or 0xFFFF only) |
| DS:035B | mouse_present | Flag from INT 33h |
| DS:035D | random_seed | From BIOS timer INT 1Ah |
| DS:035F | quit_flag | Set on keypress |
| DS:03A0 | distance_counter | Step table word offset, starts 0x78=120 |
| DS:03A2 | perspective_scale | heading/SI + 100 (≈100 always) |
| DS:03A4 | height_scale | 0x10000 / SI |
| DS:03A6 | step_size | SI << 6 (dword) |
| DS:03AA | horizon_buf | 256 words, init 0x7D00 (=125) |
| DS:07AA | render_buf | 256×200 bytes, blitted to VGA cols 32-287 |

## Web Port

The `web/index.html` is a reimplementation of the voxel terrain renderer.

### Key algorithms ported
1. **PRNG**: `seed = (seed * 0xAB + 0x2BCD) % 0xCF85`; perturbation = `(half * (seed - 0x67C2)) >> 13`, CBW-clamped to signed byte
2. **Diamond-square**: uses binary's BX register walk (BL=X, BH=Y, byte-wrapping at 256). Seeds corners, computes 4 edge midpoints + center, recurses on 4 quadrants
3. **Heightmap post-processing**: smooth → slope calc (`h[i]-h[i+3]+32`, clamp 0..63) → smooth again
4. **Colormap**: same fractal, transformed to palette indices 64-95 (`byte>>3 + 0x40`)
5. **Renderer**: Comanche-style planar voxel ray caster. Far-to-near iteration using step table for LOD. Horizon buffer tracks highest drawn pixel per column
6. **Palette**: 96 entries extracted from binary at file offset 0x14CA (6-bit VGA DAC values)
7. **Sky gradient**: `val = clamp((heading>>>1 + 10) / row) >>> 7, 63)` for 40 rows

### Rendering constants (verified against binary)
| Constant | Binary value | Source |
|----------|-------------|--------|
| Horizon init | 125 (0x7D) | 0xC32: `66 B8 00 7D 00 7D` |
| Angle offset | 0x4000 | 0x66D: `05 00 40` (ADD AX, 0x4000) |
| Angle shift | SHR (unsigned) | 0x66A: `C1 E8 03` |
| Perspective center | 100 (0x64) | 0xC69: `05 64 00` |
| Height scale | 0x10000/SI | 0xC90: `F7 F6` (DIV SI) |
| Map position | posX>>4, posY>>4 | 0xCB2: `C1 E2 04` (SHL DX,4 → DH=high) |
| Sky fill | 1 row + 40 gradient | 0xBE4: CX=0x40 (64 dwords) |
| Sky gradient input | heading>>>1 | 0xBED: `D1 EE` (SHR SI,1) |

### Binary → web mapping
| Binary function | File offset | Web equivalent |
|----------------|-------------|----------------|
| entry + init | 0x200-0x2A5 | `genColormap()`, `genHeightmap()` |
| gen_colormap | 0x2F3 | `genColormap()` |
| gen_heightmap | 0x353 | `genHeightmap()` |
| subdivide | 0x419 | `subdivide(buf, start, size)` |
| handle_input | 0x608 | mouse/touch/keyboard handlers |
| render_columns | 0x659 | `render()` — ray direction setup |
| unrolled column draw | 0x6D9-0xBD7 | (uses dispatch table approach instead) |
| fill_sky | 0xBDA | sky gradient in `render()` |
| ray_march | 0xC1F | distance-step loop in `render()` |
| dispatch table draw | 0xD3E+ | column fill loop in `render()` |
| interpolation | 0x125C | (simplified — no bilinear interp yet) |
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
- **Unrolled loops**: 200-iteration column draw at 0x6D9-0xBD7 (pattern: A4 03 D8 13 F5 = MOVSB + ADD BX,AX + ADC SI,BP + CMC)
- **Jump table dispatch**: 200-entry table at 0x12C0 for entering unrolled draw at correct scanline

### Pitfalls discovered
- `B9 40 00` is MOV CX, 0x0040 (64), NOT 0x4000 (16384) — easy to misread in hex dumps
- Binary heading is effectively 0 or 0xFFFF (not continuous) — heading rotation is minimal
- Map coordinates use posX>>4 / posY>>4, not raw position values
- `05 00 40` = ADD AX, 0x4000 (not +64) — the 0x4000 is a quarter-turn in 16-bit angle space

### Known differences from binary
- Web uses cos/sin for ray direction; binary uses fixed-point DDA
- Web lacks bilinear height interpolation (binary interpolates between samples)
- Binary has two rendering passes (MOVSB-based + dispatch table); web has one
- Keyboard heading control added for interactivity (binary only uses mouse position)
- Render buffer is cleared each frame (binary retains previous frame data below row 125)
