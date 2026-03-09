# Mars (DOS) — Reverse Engineering Project

## Platform: DOS MZ executable, 16-bit x86 (386+)

## Binary
- Path: `rom/mars.exe`
- Format: MZ, 5649 bytes, single code+data segment
- Entry: CS:IP = 0000:0000 (file offset 0x200)

## Address conventions
- File offsets: `0xXXXX` (hex with 0x prefix)
- labels.csv format: `offset,name,comment` — offset with 0x prefix

## Tool prefix
```
python3 tools/
```

## Key segments
- CS = load segment (code + inline data)
- DS = CS + 0x10C (runtime data, heightmap pointers, variables)
- VGA framebuffer: A000:0000

## Web Port

The `web/index.html` is a pixel-accurate reimplementation of the voxel terrain renderer.

### Key algorithms ported
1. **PRNG**: `seed = (seed * 0xAB + 0x2BCD) % 0xCF85`; perturbation = `(half * (seed - 0x67C2)) >> 13`, CBW-clamped to signed byte
2. **Diamond-square**: uses binary's BX register walk (BL=X, BH=Y, byte-wrapping at 256). Seeds corners, computes 4 edge midpoints + center, recurses on 4 quadrants
3. **Heightmap post-processing**: smooth → slope calc (`h[i]-h[i+3]+32`, clamp 0..63) → smooth again
4. **Colormap**: same fractal, transformed to palette indices 64-95 (`byte>>3 + 0x40`)
5. **Renderer**: Comanche-style planar voxel ray caster. Far-to-near iteration using step table for LOD. Horizon buffer tracks highest drawn pixel per column
6. **Palette**: 96 entries extracted from binary at file offset 0x14CA (6-bit VGA DAC values)
7. **Sky gradient**: `val = clamp((heading/2+10) / row) >> 7, 63)` for rows 0-39

### Binary → web mapping
| Binary function | File offset | Web equivalent |
|----------------|-------------|----------------|
| entry + init | 0x200-0x2A5 | `genColormap()`, `genHeightmap()` |
| gen_colormap | 0x2F3 | `genColormap()` |
| gen_heightmap | 0x353 | `genHeightmap()` |
| subdivide | 0x419 | `subdivide(buf, start, size)` |
| handle_input | 0x608 | mouse/touch/keyboard handlers |
| render_columns | 0x659 | `render()` ray casting loop |
| fill_sky | 0xBDA | sky gradient in `render()` |
| ray_march | 0xC1F | distance-step loop in `render()` |
| Palette data | 0x14CA | `PAL6[]` array |
| Step table | 0x1450 | `stepTable[]` array |
