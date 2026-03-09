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
