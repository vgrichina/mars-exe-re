# Mars (DOS) — Reverse Engineering Notes

## Binary Identification

| Field | Value |
|-------|-------|
| File | `rom/mars.exe` |
| Format | MZ executable |
| Platform | MS-DOS |
| CPU | Intel 16-bit x86 (386+) |
| ROM/File size | 5649 bytes |
| Header size | 512 bytes (0x200) |
| Code/data size | 5137 bytes (0x1411) |
| Entry point | CS:IP = 0000:0000 → file offset 0x200 |
| SS:SP | 3E07:0400 |
| Relocations | 6 entries |
| min_alloc | 15622 paragraphs (~244 KB) |

### Relocations

| # | Location | File Offset | Notes |
|---|----------|-------------|-------|
| 0 | 0000:0001 | 0x201 | DS/ES segment setup |
| 1 | 010C:0343 | 0x1603 | Segment reference |
| 2 | 010C:0345 | 0x1605 | Segment reference |
| 3 | 010C:0347 | 0x1607 | Segment reference |
| 4 | 010C:0349 | 0x1609 | Segment reference |
| 5 | 010C:034B | 0x160B | Segment reference |

---

## Memory Map

| Address Range | Purpose |
|---------------|---------|
| 0000:0000–FFFF | Code segment (CS = load segment) |
| DS:0000–FFFF | Data segment (DS = CS + 0x10C) |
| SS:0000–03FF | Stack (SS = CS + 0x3E07) |
| A000:0000–FFFF | VGA mode 13h framebuffer (320×200, 256 colors) |
| 03C8–03C9 | VGA DAC palette ports |

---

## Data-Range Map

| Start | End | Size | Classification | Notes |
|-------|-----|------|----------------|-------|
| 0x000 | 0x1FF | 512 | MZ header | Mostly zero-padded, 6 relocs at 0x3E |
| 0x200 | 0x20F | 16 | code | Entry: set DS/ES, seed RNG via INT 1Ah |
| 0x210 | 0x21F | 16 | code | INT 10h mode 13h, INT 33h mouse init |
| 0x220 | 0x2A5 | ~134 | code | VGA palette setup (ports 3C8/3C9), terrain init |
| 0x2A6 | 0x2EF | ~74 | code | Main loop: call terrain gen, render, input, exit |
| 0x2F0 | 0x5DF | ~752 | code | Terrain generation (diamond-square fractal?) |
| 0x5E0 | 0x60F | ~48 | code | Recursive subdivide helper |
| 0x610 | 0x65F | ~80 | code | Mouse input + main loop control |
| 0x660 | 0xBD9 | ~1402 | code | Voxel ray-casting renderer (inner loop) |
| 0xBDA | 0xC1D | ~68 | code | Sky/background fill + gradient |
| 0xC1E | 0x125F | ~1602 | code | Heightmap ray-march + column draw (unrolled) |
| 0x1260 | 0x12BF | ~96 | code | Interpolation / bilinear sampling |
| 0x12C0 | 0x144F | ~400 | data | Jump table (200 word entries for scanlines) |
| 0x1450 | 0x14CF | ~128 | data | Scale/step table (distance-based) |
| 0x14D0 | 0x15E9 | ~282 | data | Color/palette lookup table |
| 0x15EA | 0x1611 | ~40 | data | Variables + relocation targets |

---

## Key Findings

### Architecture

- **Single-segment flat code**: all code + data in one load module (CS-relative), plus a separate DS segment at CS+0x10C
- **Entry point** (0x200): sets DS = CS+0x10C, ES = same, seeds PRNG from BIOS timer (INT 1Ah)
- **Video**: Mode 13h (320×200, 256 colors), palette set via port 3C8/3C9
- **Mouse**: INT 33h init, polled each frame for movement deltas
- **No compression**: the file is already small (5KB code), the pouet comment about "apack" refers to an external packer not embedded in the binary

### Rendering

- **Voxel terrain ray-casting**: the classic "Comanche-style" column renderer
- **Heightmap**: 256×256 generated at startup via fractal algorithm (diamond-square)
- **Unrolled inner loop**: bytes 0x6D0–0xBD9 contain a massively unrolled loop (repeating pattern `A4 03 D8 13 F5`) — this is the per-pixel column draw, unrolled for 200 scanlines
- **Jump table** at 0x12C0: 200 word entries pointing into the unrolled draw loop, indexed by visible column height
- **Scale table** at 0x1450: distance-to-step mapping for ray-march

### Palette

- Set at startup (0x222–0x22F): writes 3 bytes (R,G,B) to port 3C9 after setting index via 3C8
- Appears to be a simple earth-tone gradient (browns/greens for terrain, blue for sky)

### Data Structures

- **Heightmap**: 256×256 byte array in allocated memory (pointed to by segment at DS)
- **Color map**: 256×256 byte array (paired with heightmap, separate segment)
- **Screen buffer**: likely direct writes to A000:0000 (mode 13h)

---

## Intermediate Output Files

| File | Contents |
|------|----------|

---

## Verification Checklist

- [ ] Ph3: 3+ functions traced and cross-checked against emulator trace
- [ ] Ph4: 5+ sprites/tiles extracted and visually compared to emulator
- [ ] Ph5: key data struct confirmed in emulator memory dump, all fields match
- [ ] Ph6: full game session played, no major logic gaps found
- [ ] Ph7: web port pixel-compared against emulator screenshots

---

## Reference Resources

- [Pouet page](https://www.pouet.net/prod.php?which=4662)
- Tim Clarke's voxel terrain renderer, 1993/1994
- Comanche-style voxel rendering technique
- VGA Mode 13h: 320×200, 256 colors, linear framebuffer at A000:0000

---

## Next Tasks

### RE Investigation

- [x] Ph1: identify binary header and platform
- [ ] Ph3: build instruction_set.py for 16-bit x86 (386)
- [ ] Ph3: build dis.py — targeted disassembler with labels.csv support
- [ ] Ph3: build search_bytes.py and xref.py
- [ ] Ph3: disassemble entry point (0x200) and trace initialization sequence
- [ ] Ph3: disassemble palette setup routine (0x222)
- [ ] Ph3: disassemble terrain generation (0x2F0–0x5DF) — identify fractal algorithm
- [ ] Ph3: disassemble voxel renderer (0x660–0xBD9) — trace ray-casting logic
- [ ] Ph3: disassemble main loop (0x610–0x65F) — mouse input + frame loop
- [ ] Ph5: decode jump table at 0x12C0 (200 entries)
- [ ] Ph5: decode scale/step table at 0x1450
- [ ] Ph5: decode color/palette table at 0x14D0
- [ ] Ph4: extract and document the VGA palette (RGB values)

### Web Port Fixes

### Documentation
