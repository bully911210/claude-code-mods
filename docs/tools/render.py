"""Render the captured mod drawings into the README's SVGs.

The JSONL files in docs/capture/ hold the exact element trees the mods
returned from `ui.render`, recorded with `drawn()` in the plugin test kit
(see docs/capture/*.capture.ts). This script lays those trees out the way the
Claude desktop app draws them (a pane with a title bar, number chips for
hotkeys, native buttons) and writes static and animated SVGs to docs/img/.

Run: python -I docs/tools/render.py
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass
from html import escape

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "capture"
OUT = ROOT / "img"

FONT = "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif"
MONO = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace"
SIZE = 13
CHAR = SIZE * 0.56
LINE = 20
CELL = 8  # one terminal cell of gap or margin, in pixels

PALETTE = {
    "bg": "#1f1e1d",
    "window": "#262624",
    "panel": "#2b2a28",
    "border": "#3d3c39",
    "text": "#ece9e4",
    "dim": "#8d8a85",
    "chip": "#3a3936",
    "warning": "#e08a4f",
    "suggestion": "#8aa4ff",
    "merged": "#b78cff",
    "success": "#6cc287",
    "error": "#ef6b6b",
    "subtle": "#8d8a85",
    "inactive": "#6f6d69",
    "accent": "#d97757",
    "composer": "#30302e",
}


def color_of(props: dict) -> str:
    if props.get("dimColor"):
        return PALETTE["dim"]
    return PALETTE.get(props.get("color", "text"), PALETTE["text"])


def text_of(node) -> str:
    if isinstance(node, str):
        return node
    if node is None:
        return ""
    return "".join(text_of(c) for c in node.get("children", []))


def width_of(s: str) -> float:
    # Box-drawing and symbol glyphs (the row's icons) draw about a full em wide.
    return sum(SIZE * 0.95 if 0x2190 <= ord(c) <= 0x2BFF or 0x3D0 <= ord(c) <= 0x3FF else SIZE * 0.34 if c == ' ' else CHAR for c in s)


def wrap(s: str, max_px: float) -> list[str]:
    limit = max(8, int(max_px // CHAR))
    lines: list[str] = []
    line = ""
    for word in s.split(" "):
        candidate = word if not line else f"{line} {word}"
        if len(candidate) > limit and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines or [""]


@dataclass(frozen=True)
class Drawn:
    svg: str
    width: float
    height: float


def t(x: float, y: float, s: str, fill: str, bold: bool = False, font: str = FONT, size: int = SIZE) -> str:
    weight = ' font-weight="600"' if bold else ""
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" fill="{fill}" font-family="{escape(font, quote=True)}" '
        f'font-size="{size}"{weight} xml:space="preserve" style="white-space:pre">{escape(s)}</text>'
    )


def draw_text(node: dict, x: float, y: float, avail: float) -> Drawn:
    props = node.get("props", {})
    parts = []
    # A Text may hold styled Text children; draw them in a run on one line.
    cursor = x
    if any(isinstance(c, dict) for c in node.get("children", [])):
        for c in node["children"]:
            s = text_of(c)
            fill = color_of(c.get("props", {})) if isinstance(c, dict) else color_of(props)
            parts.append(t(cursor, y + 14, s, fill, bool(props.get("bold"))))
            cursor += width_of(s)
        return Drawn("".join(parts), cursor - x, LINE)
    s = text_of(node)
    lines = wrap(s, avail) if props.get("wrap") == "wrap" else [s]
    for i, line in enumerate(lines):
        parts.append(t(x, y + 14 + i * LINE, line, color_of(props), bool(props.get("bold"))))
    w = max(width_of(line) for line in lines)
    return Drawn("".join(parts), w, LINE * len(lines))


def draw_button(node: dict, x: float, y: float) -> Drawn:
    p = node.get("props", {})
    label = p.get("label", text_of(node))
    hotkey = p.get("hotkey")
    dim = bool(p.get("dimColor"))
    fill = PALETTE["dim"] if dim else PALETTE["text"]
    parts = []
    cursor = x
    if p.get("plain"):
        if hotkey:
            parts.append(f'<rect x="{cursor:.1f}" y="{y + 2:.1f}" width="16" height="16" rx="3" fill="{PALETTE["chip"]}"/>')
            parts.append(t(cursor + 4.5, y + 14, hotkey, PALETTE["dim"], size=11))
            cursor += 24
        parts.append(t(cursor, y + 14, label, fill, bold=not dim and label.startswith("[x]")))
        return Drawn("".join(parts), cursor - x + width_of(label), LINE)
    is_primary = p.get("variant") == "primary"
    w = width_of(label) + 24
    if is_primary:
        bg = PALETTE["accent"] if not dim else "#4a3a33"
        fg = "#1f1e1d" if not dim else "#b59c90"
        parts.append(f'<rect x="{x:.1f}" y="{y - 2:.1f}" width="{w:.1f}" height="24" rx="6" fill="{bg}"/>')
        parts.append(t(x + 12, y + 14, label, fg, bold=not dim))
    else:
        stroke = PALETTE["border"] if dim else "#6a6864"
        parts.append(f'<rect x="{x + 0.5:.1f}" y="{y - 1.5:.1f}" width="{w:.1f}" height="23" rx="6" fill="none" stroke="{stroke}"/>')
        if hotkey:
            parts.append(t(x + 10, y + 14, hotkey, PALETTE["inactive"], size=11))
            parts.append(t(x + 20, y + 14, label, fill))
            w += 10
        else:
            parts.append(t(x + 12, y + 14, label, fill))
    return Drawn("".join(parts), w, LINE + 4)


def draw(node, x: float, y: float, avail: float) -> Drawn:
    if isinstance(node, str):
        return Drawn(t(x, y + 14, node, PALETTE["text"]), width_of(node), LINE)
    kind = node.get("type")
    props = node.get("props", {})
    if props.get("display") == "none" or props.get("position") == "absolute":
        return Drawn("", 0, 0)
    if kind == "Text":
        return draw_text(node, x, y, avail)
    if kind == "Button":
        return draw_button(node, x, y)
    if kind != "Box":
        return Drawn("", 0, 0)
    mt = props.get("marginTop", 0) * LINE
    mb = props.get("marginBottom", 0) * LINE
    ml = props.get("marginLeft", 0) * CELL
    x += ml
    y += mt
    kids = node.get("children", [])
    parts: list[str] = []
    if props.get("flexDirection") == "row":
        gap = props.get("gap", 0) * CELL
        drawn = []
        cursor = x
        for k in kids:
            d = draw(k, cursor, y, avail - (cursor - x))
            if d.width == 0 and d.svg == "":
                continue
            drawn.append(d)
            cursor += d.width + gap
        width = cursor - x - (gap if drawn else 0)
        if props.get("justifyContent") == "space-between" and len(kids) == 2 and len(drawn) == 2:
            # The last child is pinned to the right edge.
            right = draw(kids[-1], x + avail - drawn[-1].width, y, drawn[-1].width)
            parts = [drawn[0].svg, right.svg]
            width = avail
        else:
            parts = [d.svg for d in drawn]
        height = max((d.height for d in drawn), default=0)
        return Drawn("".join(parts), width + ml, height + mt + mb)
    cursor = y
    width = 0.0
    for k in kids:
        d = draw(k, x, cursor, avail)
        parts.append(d.svg)
        cursor += d.height
        width = max(width, d.width)
    return Drawn("".join(parts), width + ml, cursor - y + mt + mb)


def load(name: str) -> dict:
    frames = {}
    for line in (CAPTURE / f"{name}.jsonl").read_text(encoding="utf-8").splitlines():
        rec = json.loads(line)
        frames[rec["name"]] = rec
    return frames


# ---------------------------------------------------------------- scenes


def pane_box(x: float, y: float, w: float, h: float, title: str, body: str) -> str:
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{PALETTE["panel"]}" stroke="{PALETTE["border"]}"/>'
        + t(x + 14, y + 25, title, PALETTE["text"], size=14)
        + f'<g stroke="{PALETTE["dim"]}" stroke-width="1.5" fill="none">'
        + f'<path d="M{x + w - 52} {y + 22} l6 -6 m-4 0 h4 v4 M{x + w - 46} {y + 12}"/>'
        + f'<path d="M{x + w - 26} {y + 12} l10 10 m0 -10 l-10 10"/></g>'
        + f'<line x1="{x}" y1="{y + 40}" x2="{x + w}" y2="{y + 40}" stroke="{PALETTE["border"]}"/>'
        + body
    )


def composer(x: float, y: float, w: float, text: str, typed: bool) -> str:
    lines = text.split("\n") if text else []
    h = 44 + max(0, len(lines) - 1) * LINE
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{PALETTE["composer"]}" stroke="{PALETTE["border"]}"/>'
    if not lines:
        out += t(x + 16, y + 27, "Reply to Claude…", PALETTE["inactive"])
    for i, line in enumerate(lines):
        out += t(x + 16, y + 27 + i * LINE, line, PALETTE["text"] if typed else PALETTE["dim"])
    return out


def transcript(x: float, y: float, w: float, user: str, answer: list[str]) -> str:
    bubble_w = width_of(user) + 28
    out = f'<rect x="{x + w - bubble_w}" y="{y}" width="{bubble_w}" height="34" rx="10" fill="#3a3936"/>'
    out += t(x + w - bubble_w + 14, y + 22, user, PALETTE["text"])
    for i, line in enumerate(answer):
        out += t(x, y + 66 + i * LINE, line, PALETTE["text"])
    return out


def cursor_svg(cls: str) -> str:
    return (
        f'<g class="{cls}"><path d="M0 0 L0 16 L4.5 12 L7.5 18.5 L10 17.4 L7 11 L12.5 11 Z" '
        f'fill="#ffffff" stroke="#1f1e1d" stroke-width="1"/></g>'
    )


def svg_doc(w: int, h: int, body: str, style: str = "", label: str = "") -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{escape(label, quote=True)}">'
        + (f"<style>{style}</style>" if style else "")
        + f'<rect width="{w}" height="{h}" rx="14" fill="{PALETTE["bg"]}"/>'
        + body
        + "</svg>\n"
    )


def frame_style(prefix: str, slots: list[tuple[float, float]], total: float) -> str:
    """CSS that shows frame i only between slots[i] (start, end) seconds, looping."""
    css = []
    for i, (start, end) in enumerate(slots):
        a, b = start / total * 100, end / total * 100
        keys = f"0%{{opacity:0}}{max(0, a - 0.01):.2f}%{{opacity:0}}{a:.2f}%{{opacity:1}}{b:.2f}%{{opacity:1}}{min(100, b + 0.01):.2f}%{{opacity:0}}100%{{opacity:0}}"
        if start == 0:
            keys = f"0%{{opacity:1}}{b:.2f}%{{opacity:1}}{min(100, b + 0.01):.2f}%{{opacity:0}}100%{{opacity:0}}"
        css.append(f"@keyframes {prefix}{i}{{{keys}}}.{prefix}{i}{{opacity:0;animation:{prefix}{i} {total}s step-end infinite}}")
    return "".join(css)


def cursor_path(name: str, points: list[tuple[float, float, float]], total: float) -> str:
    """points: (time_s, x, y). Linear moves between them."""
    keys = "".join(f"{tm / total * 100:.2f}%{{transform:translate({x}px,{y}px)}}" for tm, x, y in points)
    return f"@keyframes {name}{{{keys}}}.{name}{{animation:{name} {total}s linear infinite}}"


def click_ring(cls: str, x: float, y: float, at: float, total: float) -> str:
    a = at / total * 100
    b = min(100, (at + 0.45) / total * 100)
    css = (
        f"@keyframes {cls}{{0%{{opacity:0;r:2}}{max(0, a - 0.01):.2f}%{{opacity:0;r:2}}{a:.2f}%{{opacity:.8;r:3}}{b:.2f}%{{opacity:0;r:16}}100%{{opacity:0;r:16}}}}"
        f".{cls}{{opacity:0;animation:{cls} {total}s linear infinite}}"
    )
    return css, f'<circle class="{cls}" cx="{x}" cy="{y}" r="2" fill="none" stroke="{PALETTE["accent"]}" stroke-width="2"/>'


def find_y(tree: dict, key: str, x: float, y: float, avail: float):
    """Where a keyed element lands: re-lays the tree with a marker on that key."""
    marker = {"found": None}

    def walk(node, nx, ny, av):
        if not isinstance(node, dict):
            return draw(node, nx, ny, av)
        if node.get("props", {}).get("key") == key and node.get("type") == "Button":
            d = draw(node, nx, ny, av)
            marker["found"] = (nx, ny, d.width, d.height)
            return d
        if node.get("type") != "Box":
            return draw(node, nx, ny, av)
        props = node.get("props", {})
        mt = props.get("marginTop", 0) * LINE
        mb = props.get("marginBottom", 0) * LINE
        ml = props.get("marginLeft", 0) * CELL
        nx += ml
        ny += mt
        if props.get("flexDirection") == "row":
            gap = props.get("gap", 0) * CELL
            cursor = nx
            height = 0
            kids = node.get("children", [])
            if props.get("justifyContent") == "space-between" and len(kids) == 2:
                last = draw(kids[-1], 0, 0, av)
                walk(kids[0], nx, ny, av)
                walk(kids[-1], nx + av - last.width, ny, last.width)
                return Drawn("", av, max(last.height, LINE) + mt + mb)
            for k in kids:
                d = walk(k, cursor, ny, av - (cursor - nx))
                if d.width == 0 and d.svg == "":
                    continue
                cursor += d.width + gap
                height = max(height, d.height)
            return Drawn("", cursor - nx, height + mt + mb)
        cursor = ny
        for k in node.get("children", []):
            d = walk(k, nx, cursor, av)
            cursor += d.height
        return Drawn("", 0, cursor - ny + mt + mb)

    walk(tree, x, y, avail)
    return marker["found"]


# ------------------------------------------------------------- outputs


def write(name: str, svg: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(svg, encoding="utf-8", newline="\n")
    print(f"wrote docs/img/{name} ({len(svg) // 1024} KB)")


def static_row(tl: dict) -> None:
    d = draw(tl["band"]["tree"], 24, 22, 892)
    write("telemetry-row.svg", svg_doc(940, 64, d.svg, label="token-ledger telemetry row above the prompt box"))


def static_pane(tree: dict, title: str, file: str, w: int = 520) -> None:
    body = draw(tree, 30, 70, w - 48)
    h = int(body.height + 110)
    write(file, svg_doc(w + 20, h, pane_box(10, 10, w, h - 20, title, body.svg), label=title))


WINDOW_W, WINDOW_H = 1440, 660
CHAT_X, CHAT_W = 28, 820
PANE_X, PANE_W = 870, 550


def composer_height(text: str) -> float:
    return 44 + max(0, len(text.split(chr(10))) - 1) * LINE if text else 44


def band_y(text: str) -> float:
    return WINDOW_H - 20 - composer_height(text) - 34


def scene_frame(tl: dict, pane_tree, pane_title: str, band_tree: dict, box_text: str, typed: bool, user: str, answer: list[str]) -> str:
    out = transcript(CHAT_X, 40, CHAT_W, user, answer)
    out += composer(CHAT_X, WINDOW_H - 20 - composer_height(box_text), CHAT_W, box_text, typed)
    if band_tree is not None:
        out += draw(band_tree, CHAT_X + 6, band_y(box_text), CHAT_W - 12).svg
    if pane_tree is not None:
        body = draw(pane_tree, PANE_X + 20, 74, PANE_W - 40)
        out += pane_box(PANE_X, 20, PANE_W, WINDOW_H - 40, pane_title, body.svg)
    return out


def loading_pane() -> dict:
    # The exact first draw of the pane while Haiku works (insightsView.tsx, status 'loading').
    return {
        "type": "Box",
        "props": {"flexDirection": "column"},
        "children": [
            {"type": "Text", "props": {"dimColor": True}, "children": ["Haiku is reading the conversation and project…"]},
            {"type": "Box", "props": {"key": "actions", "flexDirection": "row", "marginTop": 1, "gap": 2}, "children": [
                {"type": "Button", "props": {"key": "close", "label": "Close", "plain": True, "dimColor": True}},
            ]},
        ],
    }


def busy_band(band: dict) -> dict:
    # The same row with the launcher showing "…" (askButton, status 'loading').
    s = json.dumps(band).replace('"label": "?", "plain": true, "dimColor": false', '"label": "…", "plain": true, "dimColor": true')
    return json.loads(s)


def compact(tree):
    return json.loads(json.dumps(tree, separators=(",", ":")).replace('"label":"?","plain":true,"dimColor":false', '"label":"?","plain":true,"dimColor":false'))


def animated_questions(tl: dict) -> None:
    band = tl["band"]["tree"]
    filled = tl["filled"]["fills"][0]
    user = "Add retries with backoff to the job worker"
    answer = [
        "Done. src/worker.ts now retries failed jobs with exponential",
        "backoff, capped by RETRY_MAX from the config. Tests pass.",
    ]
    states = [
        # (seconds shown, pane tree, band, composer text, typed)
        (1.6, None, band, "", False),
        (1.2, loading_pane(), busy_band(band), "", False),
        (1.6, tl["pane-0"]["tree"], band, "", False),
        (1.1, tl["pane-1"]["tree"], band, "", False),
        (1.6, tl["pane-2"]["tree"], band, "", False),
        (3.2, None, band, filled, True),
    ]
    total = sum(s[0] for s in states)
    slots, cur = [], 0.0
    for s in states:
        slots.append((cur, cur + s[0]))
        cur += s[0]
    frames = "".join(
        f'<g class="f{i}">{scene_frame(tl, p, "Questions worth asking", b, txt, typed, user, answer)}</g>'
        for i, (_, p, b, txt, typed) in enumerate(states)
    )
    ask = find_y(band, "ask", CHAT_X + 6, band_y(""), CHAT_W - 12)
    q1 = find_y(tl["pane-0"]["tree"], "q-1", PANE_X + 20, 74, PANE_W - 40)
    q3 = find_y(tl["pane-1"]["tree"], "q-3", PANE_X + 20, 74, PANE_W - 40)
    ins = find_y(tl["pane-2"]["tree"], "insert", PANE_X + 20, 74, PANE_W - 40)
    tgt = lambda f: (f[0] + 14, f[1] + 10)  # noqa: E731
    a, b1, b3, bi = tgt(ask), tgt(q1), tgt(q3), tgt(ins)
    path = [
        (0, 520, 300), (1.2, *a), (slots[2][0] + 0.2, *a), (slots[2][1] - 0.2, *b1), (slots[3][1] - 0.3, *b3),
        (slots[4][1] - 0.3, *bi), (slots[5][0] + 0.8, *bi), (total, 520, 300),
    ]
    css = frame_style("f", slots, total) + cursor_path("cur", path, total)
    rings = []
    for k, (cx, cy, at) in enumerate([(a[0], a[1], 1.4), (b1[0], b1[1], slots[3][0]), (b3[0], b3[1], slots[4][0]), (bi[0], bi[1], slots[5][0])]):
        c, el = click_ring(f"r{k}", cx, cy, at, total)
        css += c
        rings.append(el)
    body = frames + "".join(rings) + cursor_svg("cur")
    write("demo-questions.svg", svg_doc(WINDOW_W, WINDOW_H, body, css, "Animated demo: click ?, tick two questions, insert them into the prompt box"))


def animated_steps(ns: dict, tl: dict) -> None:
    band = tl["band"]["tree"]
    filled = ns["steps-filled"]["fills"][0]
    user = "Add retries with backoff to the job worker"
    answer = [
        "I added exponential backoff to src/worker.ts and wired",
        "RETRY_MAX through the config. Two tests cover the new path.",
    ]
    states = [
        (1.4, None, ""),
        (1.6, ns["steps-0"]["tree"], ""),
        (1.1, ns["steps-1"]["tree"], ""),
        (1.6, ns["steps-2"]["tree"], ""),
        (3.2, None, filled),
    ]
    total = sum(s[0] for s in states)
    slots, cur = [], 0.0
    for s in states:
        slots.append((cur, cur + s[0]))
        cur += s[0]
    frames = "".join(
        f'<g class="g{i}">{scene_frame(tl, p, "Next steps", band, txt, bool(txt), user, answer)}</g>'
        for i, (_, p, txt) in enumerate(states)
    )
    s0 = find_y(ns["steps-0"]["tree"], "step-0", PANE_X + 20, 74, PANE_W - 40)
    s2 = find_y(ns["steps-1"]["tree"], "step-2", PANE_X + 20, 74, PANE_W - 40)
    ins = find_y(ns["steps-2"]["tree"], "insert", PANE_X + 20, 74, PANE_W - 40)
    tgt = lambda f: (f[0] + 40, f[1] + 10)  # noqa: E731
    b0, b2, bi = tgt(s0), tgt(s2), (ins[0] + 14, ins[1] + 10)
    path = [(0, 520, 300), (slots[1][0] + 0.2, 520, 300), (slots[1][1] - 0.3, *b0), (slots[2][1] - 0.3, *b2), (slots[3][1] - 0.3, *bi), (slots[4][0] + 0.8, *bi), (total, 520, 300)]
    css = frame_style("g", slots, total) + cursor_path("cur", path, total)
    rings = []
    for k, (cx, cy, at) in enumerate([(b0[0], b0[1], slots[2][0]), (b2[0], b2[1], slots[3][0]), (bi[0], bi[1], slots[4][0])]):
        c, el = click_ring(f"r{k}", cx, cy, at, total)
        css += c
        rings.append(el)
    body = frames + "".join(rings) + cursor_svg("cur")
    write("demo-next-steps.svg", svg_doc(WINDOW_W, WINDOW_H, body, css, "Animated demo: next-steps pane, tick two steps, insert them"))


def animated_docs() -> None:
    w, h = 940, 300
    lines_a = [
        ("$ ", PALETTE["dim"], 'git commit -m "feat: add retry backoff to the worker"', PALETTE["text"]),
        ("", "", "[main 3f9c2a1] feat: add retry backoff to the worker", PALETTE["dim"]),
        ("", "", " 2 files changed, 48 insertions(+), 6 deletions(-)", PALETTE["dim"]),
    ]
    log = [
        ("$ ", PALETTE["dim"], "git log --oneline -2", PALETTE["text"]),
        ("", "", "8d41e07 docs: sync with 3f9c2a1", PALETTE["success"]),
        ("", "", "3f9c2a1 feat: add retry backoff to the worker", PALETTE["text"]),
    ]

    def block(lines, y0):
        out = ""
        for i, (p, pc, s, c) in enumerate(lines):
            y = y0 + i * 22
            if p:
                out += t(28, y, p, pc, font=MONO)
            out += t(28 + (len(p) * 7.8), y, s, c, font=MONO)
        return out

    status = t(28, h - 22, "auto-docs: reading 3f9c2a1…", PALETTE["dim"], font=MONO, size=12)
    toast_text = "auto-docs: updated README.md for 3f9c2a1 in commit 8d41e07."
    tw = width_of(toast_text) + 32
    toast = (
        f'<rect x="{w - tw - 20}" y="20" width="{tw}" height="38" rx="8" fill="{PALETTE["panel"]}" stroke="{PALETTE["border"]}"/>'
        + t(w - tw - 4, 44, toast_text, PALETTE["text"])
    )
    a = block(lines_a, 96)
    frames = [
        (1.8, a),
        (1.6, a + status),
        (2.4, a + toast),
        (3.0, a + block(log, 190)),
    ]
    total = sum(f[0] for f in frames)
    slots, cur = [], 0.0
    for f in frames:
        slots.append((cur, cur + f[0]))
        cur += f[0]
    css = frame_style("d", slots, total)
    body = "".join(f'<g class="d{i}">{svg}</g>' for i, (_, svg) in enumerate(frames))
    write("demo-auto-docs.svg", svg_doc(w, h, body, css, "Animated demo: a commit, then auto-docs updates README.md in a follow-up commit"))


def main() -> None:
    tl = load("token-ledger")
    ns = load("next-steps")
    static_row(tl)
    static_pane(tl["pane-2"]["tree"], "Questions worth asking", "questions-pane.svg")
    static_pane(ns["steps-2"]["tree"], "Next steps", "next-steps-pane.svg")
    static_pane(tl["ledger"]["tree"], "Token ledger", "ledger-pane.svg", w=560)
    animated_questions(tl)
    animated_steps(ns, tl)
    animated_docs()


if __name__ == "__main__":
    main()
