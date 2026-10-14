"""Forward Kitty images through tmux.

Claude Code draws an Image as Unicode placeholder cells (U+10EEEE with the
image id in the foreground colour and the cell's row and column as combining
diacritics) and transmits the pixels in an APC that tmux drops, so the box
stays blank. This finds the placeholder blocks in the pane, works out which
image each one is, and transmits that image again under the block's id,
wrapped in tmux passthrough so it reaches the terminal.

A block is known by the tag line the mod draws right above it ("#<tag> ...").
A block whose first row is scrolled off the top has no tag line in the pane;
that one is the image whose message the mod reported clipped at the top.

stdin: {"images": [{"tag", "file", "c", "r", "top"}, ...]}; top: the message's
first rows are off screen now (unknown where the terminal does not say).
With --pane %N (from a tmux hook), the images that pane's last run was given.
stdout: a JSON summary, for the log.
"""

import base64
import fcntl
import json
import os
import re
import subprocess
import sys

CACHE_DIR = "/tmp/claude-inline-images"
PLACEHOLDER = "\U0010eeee"
# Row and column diacritics in the order the Kitty protocol numbers them.
DIACRITICS = [
    773, 781, 782, 784, 786, 829, 830, 831, 838, 842, 843, 844, 848, 849, 850, 855, 859, 867,
    868, 869, 870, 871, 872, 873, 874, 875, 876, 877, 878, 879, 1155, 1156, 1157, 1158, 1159,
    1426, 1427, 1428, 1429, 1431, 1432, 1433, 1436, 1437, 1438, 1439, 1440, 1441, 1448, 1449,
    1451, 1452, 1455, 1476, 1552, 1553, 1554, 1555, 1556, 1557, 1558, 1559, 1623, 1624, 1625,
    1626, 1627, 1629, 1630, 1750, 1751, 1752, 1753, 1754, 1755, 1756, 1759, 1760, 1761, 1762,
    1764, 1767, 1768, 1771, 1772, 1840, 1842, 1843, 1845, 1846, 1850, 1853, 1855, 1856, 1857,
    1859, 1861, 1863, 1865, 1866, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2035, 2070, 2071,
    2072, 2073, 2075, 2076, 2077, 2078, 2079, 2080, 2081, 2082, 2083, 2085, 2086, 2087, 2089,
    2090, 2091, 2092, 2093, 2385, 2387, 2388, 3970, 3971, 3974, 3975, 4957, 4958, 4959, 6109,
    6458, 6679, 6773, 6774, 6775, 6776, 6777, 6778, 6779, 6780, 7019, 7021, 7022, 7023, 7024,
    7025, 7026, 7027, 7376, 7377, 7378, 7386, 7387, 7392, 7616, 7617, 7619, 7620, 7621, 7622,
    7623, 7624, 7625, 7627, 7628, 7633, 7634, 7635, 7636, 7637, 7638, 7639, 7640, 7641, 7642,
    7643, 7644, 7645, 7646, 7647, 7648, 7649, 7650, 7651, 7652, 7653, 7654, 7678, 8400, 8401,
    8404, 8405, 8406, 8407, 8411, 8412, 8417, 8423, 8425, 8432, 11503, 11504, 11505, 11744,
    11745, 11746, 11747, 11748, 11749, 11750, 11751, 11752, 11753, 11754, 11755, 11756, 11757,
    11758, 11759, 11760, 11761, 11762, 11763, 11764, 11765, 11766, 11767, 11768, 11769, 11770,
    11771, 11772, 11773, 11774, 11775, 42607, 42620, 42621, 42736, 42737, 43232, 43233, 43234,
    43235, 43236, 43237, 43238, 43239, 43240, 43241, 43242, 43243, 43244, 43245, 43246, 43247,
    43248, 43249, 43696, 43698, 43699, 43703, 43704, 43710, 43711, 43713, 65056, 65057, 65058,
    65059, 65060, 65061, 65062, 68111, 68152, 119173, 119174, 119175, 119176, 119177, 119210,
    119211, 119212, 119213, 119362, 119363, 119364,
]
INDEX = {chr(cp): i for i, cp in enumerate(DIACRITICS)}
SGR = re.compile(r"\x1b\[([0-9;:]*)m")
ESCAPE = re.compile(r"\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b[^[]")
TAG = re.compile(r"^[\s⎿]*#(\w+)\b")


def fg_after(params, fg):
    """The foreground colour after an SGR sequence: an index or 0xRRGGBB."""
    parts = re.split("[;:]", params) if params else ["0"]
    i = 0
    while i < len(parts):
        p = int(parts[i] or 0)
        if p in (0, 39):
            fg = None
        elif 30 <= p <= 37:
            fg = p - 30
        elif 90 <= p <= 97:
            fg = p - 90 + 8
        elif p == 38 and i + 2 < len(parts) and parts[i + 1] == "5":
            fg = int(parts[i + 2] or 0)
            i += 2
        elif p == 38 and i + 4 < len(parts) and parts[i + 1] == "2":
            r, g, b = (int(x or 0) for x in parts[i + 2 : i + 5])
            fg = (r << 16) | (g << 8) | b
            i += 4
        i += 1
    return fg


def cells(line):
    """Each placeholder cell of a captured line: (image id, row, column)."""
    out, fg, pos = [], None, 0
    for m in list(SGR.finditer(line)) + [None]:
        chunk = line[pos : m.start()] if m else line[pos:]
        if fg is not None:
            for k, ch in enumerate(chunk):
                if ch == PLACEHOLDER:
                    row = INDEX.get(chunk[k + 1] if k + 1 < len(chunk) else "")
                    col = INDEX.get(chunk[k + 2] if k + 2 < len(chunk) else "")
                    out.append((fg, row, col))
        if m:
            fg, pos = fg_after(m.group(1), fg), m.end()
    return out


def plain(line):
    return ESCAPE.sub("", line)


def blocks(lines):
    """The placeholder blocks in the pane, top to bottom: one image id over
    consecutive lines, the rows counting up from where the block starts
    (rows unknown where the capture lost the diacritics)."""
    found, open_ = [], {}  # id -> the block the line above left open
    for y, line in enumerate(lines):
        here = {}
        for image_id, row, col in cells(line):
            b = here.get(image_id)
            if b is None:
                b = here[image_id] = {"cols": 0, "row": row, "ok": True}
            b["ok"] = b["ok"] and row == b["row"] and col in (None, b["cols"])
            b["cols"] += 1
        nxt = {}
        for image_id, b in here.items():
            prev = open_.get(image_id)
            if prev and b["ok"] and prev["cols"] == b["cols"] and (b["row"] is None or prev["row_last"] == b["row"] - 1):
                prev["row_last"], prev["bottom"] = b["row"], y
                nxt[image_id] = prev
            else:
                nxt[image_id] = {"id": image_id, "top": y, "bottom": y, "cols": b["cols"], "row_first": b["row"], "row_last": b["row"], "ok": b["ok"]}
                found.append(nxt[image_id])
        open_ = nxt
    return [b for b in found if b["ok"]]


def fits(b, img):
    return b["cols"] == img["c"] and (b["row_last"] is None or b["row_last"] < img["r"])


def pair(lines, images):
    """Which image each block is: {id: image}, and the blocks nothing fits
    with the reason. Blocks under a tag line first; then a block with no tag
    line (its first rows, or the line above, off the top of the capture) is
    the one message reported clipped at the top that is not already placed.
    An id drawn twice (an old frame left in the scrollback) takes the lowest
    block, the live screen."""
    by_tag, dup = {}, set()
    for img in images:
        if img["tag"] in by_tag:
            dup.add(img["tag"])
        by_tag[img["tag"]] = img
    paired, skipped, headless = {}, [], []
    for b in blocks(lines):
        above = plain(lines[b["top"] - 1]) if b["top"] > 0 else ""
        m = TAG.match(above) if b["row_first"] in (0, None) else None
        if m is None:
            headless.append(b)
            continue
        img = None if m.group(1) in dup else by_tag.get(m.group(1))
        why = "two images share the tag" if m.group(1) in dup else None if img else "no image has the tag"
        if img and not fits(b, img):
            img, why = None, f"{b['cols']} columns, rows {b['row_first']}..{b['row_last']}: not {img['c']}x{img['r']}"
        if img:
            paired[b["id"]] = img
        else:
            skipped.append({"id": b["id"], "line": b["top"], "why": why})
    placed = {id(img) for img in paired.values()}
    tops = [img for img in images if img.get("top") and id(img) not in placed]
    for b in headless:
        fit = [img for img in tops if fits(b, img)]
        if len(fit) == 1 and (b["row_first"] or b["top"] == 0):
            paired[b["id"]] = fit[0]
        else:
            skipped.append({"id": b["id"], "line": b["top"], "why": f"no tag line above, {len(fit)} clipped messages fit"})
    return paired, skipped


def transmit(image_id, img):
    path = base64.b64encode(img["file"].encode()).decode()
    apc = f"\x1b_Ga=T,U=1,q=2,f=100,t=f,i={image_id},c={img['c']},r={img['r']};{path}\x1b\\"
    return "\x1bPtmux;" + apc.replace("\x1b", "\x1b\x1b") + "\x1b\\"


def decide(paired, sent, pane, active, visible):
    """Which paired images to send: {id: image}, and the ones left to another
    pane. Every Claude Code session counts its ids from 1, and all the panes
    of one client draw into one terminal, so `sent` (id -> [file, c, r, pane],
    shared by those panes) says what the terminal holds under each id. A pane
    takes an id another pane holds unless that pane is on screen and this one
    is not the focused one; `visible(pane)` says whether a pane is on screen."""
    sends, yielded = {}, {}
    for image_id, img in paired.items():
        held = sent.get(str(image_id))
        if held and held[:3] == [img["file"], img["c"], img["r"]]:
            continue
        if held and held[3] != pane and not active and visible(held[3]):
            yielded[image_id] = held[3]
        else:
            sends[image_id] = img
    return sends, yielded


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, check=True).stdout


# A pane's tty and client, whether it is on screen (its window current in an
# attached session, and not hidden behind a zoomed pane), and whether focused.
PANE_INFO = (
    "#{pane_id}\n#{pane_tty}\n#{client_pid}:#{client_created}\n"
    "#{?#{&&:#{session_attached},#{window_active}},#{?window_zoomed_flag,#{pane_active},1},0}\n#{pane_active}"
)
# The tmux hooks the mod sets per pane (by its number) to run this again.
HOOKS = ("session-window-changed", "after-select-pane", "client-session-changed")


def pane_info(pane):
    """[tty, client, on screen, focused], or None once the pane is gone (tmux
    answers for the current pane when the one named does not exist)."""
    try:
        info = tmux("display", "-p", "-t", pane, PANE_INFO).split("\n")
    except subprocess.CalledProcessError:
        return None
    return info[1:5] if info[0] == pane else None


def on_screen(pane):
    info = pane_info(pane)
    return bool(info) and info[2] == "1"


def main():
    # Run by the mod with this draw's images on stdin, or by a tmux hook
    # (--pane %N) when the pane may have come back on screen.
    replay = len(sys.argv) == 3 and sys.argv[1] == "--pane"
    pane = sys.argv[2] if replay else os.environ.get("TMUX_PANE")
    if not pane:
        return
    number = pane.strip("%")
    images_path = f"{CACHE_DIR}/pane-{number}.json"
    info = pane_info(pane)
    if info is None:
        if replay:  # the pane is gone: its hooks and images too
            for hook in HOOKS:
                subprocess.run(["tmux", "set-hook", "-gu", f"{hook}[{number}]"], capture_output=True)
            try:
                os.remove(images_path)
            except OSError:
                pass
        return
    tty, client, visible, active = info
    if replay:
        try:
            with open(images_path) as f:
                images = json.load(f)
        except (OSError, ValueError):
            return
    else:
        images = json.load(sys.stdin)["images"]
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(images_path, "w") as f:
            json.dump(images, f)
    # tmux drops passthrough from a pane that is not on screen.
    if visible != "1":
        print(json.dumps({"hidden": True}))
        return

    lines = tmux("capture-pane", "-e", "-p", "-t", pane, "-S", "-200").split("\n")
    paired, skipped = pair(lines, images)

    # What the terminal holds per id, shared by every pane of the client.
    os.makedirs(CACHE_DIR, exist_ok=True)
    state_path = f"{CACHE_DIR}/sent-{client.replace(':', '-')}.json"
    with open(state_path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(state_path) as f:
                sent = json.load(f)
        except (OSError, ValueError):
            sent = {}
        sends, yielded = decide(paired, sent, pane, active == "1", on_screen)
        if sends:
            with open(tty, "w") as t:
                for image_id, img in sends.items():
                    t.write(transmit(image_id, img))
            for image_id, img in sends.items():
                sent[str(image_id)] = [img["file"], img["c"], img["r"], pane]
            with open(state_path, "w") as f:
                json.dump(sent, f)
    print(json.dumps({
        "sent": {i: img["tag"] for i, img in sends.items()},
        "held": len(paired) - len(sends) - len(yielded),
        "yielded": yielded,
        "skipped": skipped,
    }))


if __name__ == "__main__":
    main()
