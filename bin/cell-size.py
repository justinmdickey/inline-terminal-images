"""Print a terminal cell's size in pixels, "width height", from the window size
the terminal reports (TIOCGWINSZ); nothing when it reports no pixels.

Asks the controlling terminal first, then the tmux pane's tty."""

import fcntl
import os
import struct
import subprocess
import sys
import termios


def cell(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOCTTY)
    try:
        rows, cols, xpx, ypx = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
    finally:
        os.close(fd)
    return (xpx / cols, ypx / rows) if rows and cols and xpx and ypx else None


def ttys():
    yield "/dev/tty"
    pane = os.environ.get("TMUX_PANE")
    if pane:
        out = subprocess.run(["tmux", "display", "-p", "-t", pane, "#{pane_tty}"], capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            yield out.stdout.strip()


def main():
    for tty in ttys():
        try:
            size = cell(tty)
        except OSError:
            continue
        if size:
            print(f"{size[0]:.3f} {size[1]:.3f}")
            return
    sys.exit(1)


if __name__ == "__main__":
    main()
