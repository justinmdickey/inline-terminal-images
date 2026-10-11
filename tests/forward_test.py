"""Harness for bin/tmux-forward.py's pairing, over captures built the way the
engine draws placeholders: fg colour = id, U+10EEEE + row + column diacritics."""

import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "fwd", str(Path(__file__).resolve().parent.parent / "bin" / "tmux-forward.py")
)
fwd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fwd)

D = [chr(cp) for cp in fwd.DIACRITICS]


def block(image_id, cols, rows, first=0, wide=False, diacritics=True):
    sgr = f"\x1b[38;2;{image_id >> 16};{(image_id >> 8) & 255};{image_id & 255}m" if wide else f"\x1b[38;5;{image_id}m"
    out = []
    for r in range(first, first + rows):
        cells = "".join(fwd.PLACEHOLDER + (D[r] + D[c] if diacritics else "") for c in range(cols))
        out.append(sgr + cells + "\x1b[39m")
    return out


def tag(t, text="shot.png (200x100)", gutter="     "):
    return f"{gutter}\x1b[2m#{t} {text}\x1b[22m"


A = {"tag": "aaaaa", "file": "/tmp/a.png", "c": 80, "r": 20, "top": False}
B = {"tag": "bbbbb", "file": "/tmp/b.png", "c": 80, "r": 20, "top": False}
C = {"tag": "ccccc", "file": "/tmp/c.png", "c": 40, "r": 10, "top": False}

failures = 0


def check(name, got, want):
    global failures
    ok = got == want
    failures += not ok
    print(("pass" if ok else "FAIL"), name, "" if ok else f"\n  got  {got}\n  want {want}")


# Two same-size images on screen: the tags tell them apart whatever the ids.
lines = ["> show both", tag("aaaaa")] + block(2, 80, 20) + ["", "  ⎿  Read image (12KB)", tag("bbbbb")] + block(1, 80, 20) + ["", "> "]
paired, skipped = fwd.pair(lines, [A, B])
check("two same-size images pair by tag", ({i: p["tag"] for i, p in paired.items()}, skipped), ({2: "aaaaa", 1: "bbbbb"}, []))

# The same, after the engine reused ids the other way round.
lines = [tag("aaaaa")] + block(1, 80, 20) + [tag("bbbbb")] + block(2, 80, 20)
paired, _ = fwd.pair(lines, [A, B])
check("ids swapped", {i: p["tag"] for i, p in paired.items()}, {1: "aaaaa", 2: "bbbbb"})

# A block clipped at the top: no tag line, rows start past 0; it is the one
# message the mod reported clipped at the top.
lines = block(7, 80, 12, first=8) + ["", tag("bbbbb")] + block(3, 80, 20)
paired, skipped = fwd.pair(lines, [dict(A, top=True), B])
check("top-clipped block is the top-clipped message", ({i: p["tag"] for i, p in paired.items()}, skipped), ({7: "aaaaa", 3: "bbbbb"}, []))

# ... but not when two messages say they are clipped at the top (stale report).
paired, skipped = fwd.pair(lines, [dict(A, top=True), dict(B, top=True)])
check("the tagged block settles which message the clipped one is", ({i: p["tag"] for i, p in paired.items()}, skipped), ({7: "aaaaa", 3: "bbbbb"}, []))
paired, skipped = fwd.pair(block(7, 80, 12, first=8), [dict(A, top=True), dict(B, top=True)])
check("ambiguous top clip is skipped", (paired, [s["why"] for s in skipped]), ({}, ["no tag line above, 2 clipped messages fit"]))

# Only the blank row above B's tag line is scrolled off (B reports top too),
# so B pairs by tag and A is the one clipped message left.
paired, skipped = fwd.pair(lines, [dict(A, top=True), dict(B, top=True)][::-1])
check("a message reported clipped but tagged leaves the other", ({i: p["tag"] for i, p in paired.items()}, skipped), ({7: "aaaaa", 3: "bbbbb"}, []))

# The tag line just scrolled off: the block starts at the capture's first line with row 0.
lines = block(7, 80, 12, first=0) + ["", tag("bbbbb")] + block(3, 80, 20)
paired, skipped = fwd.pair(lines, [dict(A, top=True), B])
check("block at the capture's top with its tag line gone", ({i: p["tag"] for i, p in paired.items()}, skipped), ({7: "aaaaa", 3: "bbbbb"}, []))

# Clipped at the top, but of a different size than the clipped message.
lines = block(7, 40, 5, first=3) + ["", tag("bbbbb")] + block(3, 80, 20)
paired, skipped = fwd.pair(lines, [dict(A, top=True), B])
check("top-clipped block of another size is skipped", ({i: p["tag"] for i, p in paired.items()}, [s["why"] for s in skipped]), ({3: "bbbbb"}, ["no tag line above, 0 clipped messages fit"]))

# A block clipped at the bottom keeps its tag line.
lines = ["", tag("ccccc")] + block(5, 40, 4)
paired, skipped = fwd.pair(lines, [C])
check("bottom-clipped block pairs by its tag", ({i: p["tag"] for i, p in paired.items()}, skipped), ({5: "ccccc"}, []))

# A tag the mod does not know, and a block whose size is not the image's.
lines = [tag("zzzzz")] + block(4, 80, 20) + [tag("ccccc")] + block(6, 80, 20)
paired, skipped = fwd.pair(lines, [A, C])
check("unknown tag and wrong size are skipped", (paired, [s["why"] for s in skipped]), ({}, ["no image has the tag", "80 columns, rows 0..19: not 40x10"]))

# An old frame in the scrollback drew id 2 as A; the live screen draws id 2 as B.
lines = [tag("aaaaa")] + block(2, 80, 20) + ["", "", tag("bbbbb")] + block(2, 80, 20)
paired, _ = fwd.pair(lines, [A, B])
check("a reused id takes the lowest block", {i: p["tag"] for i, p in paired.items()}, {2: "bbbbb"})

# 24-bit ids (truecolor terminals) and tags with the ⎿ gutter.
lines = [tag("aaaaa", gutter="  ⎿  ")] + block(0x1234AB, 80, 20, wide=True)
paired, _ = fwd.pair(lines, [A])
check("24-bit id under a gutter tag line", {i: p["tag"] for i, p in paired.items()}, {0x1234AB: "aaaaa"})

# Two images sharing a tag are never guessed.
lines = [tag("aaaaa")] + block(2, 80, 20)
paired, skipped = fwd.pair(lines, [A, dict(B, tag="aaaaa")])
check("shared tag is skipped", (paired, [s["why"] for s in skipped]), ({}, ["two images share the tag"]))

# Diacritics lost: still paired by tag, rows unknown.
lines = [tag("aaaaa")] + block(2, 80, 20, diacritics=False)
paired, skipped = fwd.pair(lines, [A])
check("no diacritics still pairs by tag", ({i: p["tag"] for i, p in paired.items()}, skipped), ({2: "aaaaa"}, []))

# Lines with no placeholders at all, and a tag line with nothing under it.
check("empty pane", fwd.pair(["", tag("aaaaa"), "", "> "], [A]), ({}, []))

# The wrapped transmit names the id, box and file.
t = fwd.transmit(7, A)
check("transmit is tmux-wrapped", t.startswith("\x1bPtmux;\x1b\x1b_Ga=T,U=1,q=2,f=100,t=f,i=7,c=80,r=20;") and t.endswith("\x1b\x1b\\\x1b\\"), True)

print("failures:", failures)
sys.exit(1 if failures else 0)
