"""
circuit-backend/value_reader.py
================================
Reads handwritten component values ("4V", "0.7 mH", "7kΩ", "0.6µF") that
sit next to each detected symbol, so generated circuits keep the drawn
values instead of defaults.

  run_ocr(image)                  → OcrItem list (easyocr if installed, else [])
  parse_value(text, cls_name)     → (SI value, unit) from one label string
  value_near_box(box, cls, items) → (SI value, unit) for one component
  assign_values(boxes, items)     → best label per component, each label used once
  format_spice(value, unit, cls)  → "7k", "0.6u", "DC 4", …

OCR is optional: without an engine every component keeps its default value.
Handwriting OCR is noisy, so parsing is deliberately forgiving (O→0, l→1,
µ read as u/U/M on a capacitor) and uses the component's class to settle
ambiguous prefixes (an "M" next to a capacitor is micro, never mega).
"""

import math
import re
from dataclasses import dataclass

import numpy as np

# Canonical unit per detected class.
CLASS_UNIT = {
    "Resistor": "ohm",
    "Capacitor": "F",
    "Inductor": "H",
    "Voltage": "V",
    "Battery": "V",
    "AC Source": "V",
    "Dep. Voltage": "V",
}

# Unit letters as they show up in OCR output.
_UNIT_ALIASES = {
    "ohm": ("Ω", "Ω", "ohm", "ohms", "Q", "R", "n", "O", "o", "S", "2"),
    "F": ("F", "f"),
    "H": ("H", "h"),
    "V": ("V", "v"),
}

# Plausible prefixes per unit (OCR letter → multiplier). Case is unreliable in
# handwriting, so each table only contains the readings that make physical
# sense for that part: µ is often read as u/U/M, mega-farads don't exist, and
# milli-ohm resistors are rare enough that "m" on a resistor means mega.
_PREFIXES = {
    "ohm": {"k": 1e3, "K": 1e3, "M": 1e6, "m": 1e6, "G": 1e9, "g": 1e9},
    "F": {"m": 1e-3, "u": 1e-6, "U": 1e-6, "µ": 1e-6, "μ": 1e-6, "M": 1e-6,
          "n": 1e-9, "N": 1e-9, "p": 1e-12, "P": 1e-12},
    "H": {"m": 1e-3, "M": 1e-3, "u": 1e-6, "U": 1e-6, "µ": 1e-6, "μ": 1e-6,
          "n": 1e-9, "N": 1e-9},
    "V": {"m": 1e-3, "k": 1e3, "K": 1e3},
}

# Values outside these ranges are treated as misreads (e.g. "45µF" read as
# "4545" → 4545 F): a wrong value is worse than the default.
_PLAUSIBLE = {"ohm": (0.1, 1e9), "F": (1e-12, 0.1), "H": (1e-9, 10.0), "V": (1e-3, 1e4)}

# The prefix letter is often not read as a letter at all but as a digit that
# gets glued onto the number: "4k" -> "43" / "46", "47k" -> "476", "0.6µF" ->
# "0.64F", "47u" -> "470". Which digit depends on the letter and the
# handwriting; these are the ones observed (rendered script fonts read k as 6
# and u as 4/6/0; real handwriting read k as 3). Applied only when no prefix
# letter was read, and the result is reported as *inferred* because a genuine
# "43" (ohms) looks identical.
_TRAILING_DIGIT_PREFIX = {
    "ohm": {"3": 1e3, "6": 1e3},
    "F": {"4": 1e-6, "6": 1e-6, "0": 1e-6},
    "H": {"4": 1e-6},
}

# OCR confusions inside the numeric part only.
_DIGIT_FIXES = str.maketrans({"O": "0", "o": "0", "D": "0", "l": "1", "I": "1",
                              "|": "1", "i": "1", ",": ".", "·": "."})

_NUMBER_RE = re.compile(r"^\s*([0-9OoDlIi|]*[.,·]?[0-9OoDlIi|]+)\s*(.*)$")


@dataclass
class OcrItem:
    text: str
    x1: int
    y1: int
    x2: int
    y2: int
    conf: float = 1.0

    @property
    def center(self) -> tuple[float, float]:
        return (self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2


# ── OCR engine ──────────────────────────────────────────────────

_reader = None


def ocr_available() -> bool:
    try:
        import easyocr  # noqa: F401
        return True
    except ImportError:
        return False


# Only characters a value label can contain. easyocr's English charset has no
# Ω or µ; they come back as look-alikes (n, 4, u, …) handled in parse_value.
_OCR_ALLOWLIST = "0123456789.kKmMuUnNpPvVfFhH"
# Long side (px) the image is resampled to for OCR. Chosen empirically on
# the canvas test drawing; larger was slower and read fewer labels.
OCR_LONG_SIDE = 1650


def run_ocr(image: np.ndarray) -> list[OcrItem]:
    """Text boxes in the image, with neighbouring words on one line merged
    ("0.7" + "mH" → "0.7mH"). Returns [] when no OCR engine is installed.

    Thin pen strokes OCR badly and results shift with resolution, so the
    image is resampled to a fixed working size and strokes are thickened
    before recognition."""
    global _reader
    if not ocr_available():
        return []
    import cv2
    import easyocr
    if _reader is None:
        _reader = easyocr.Reader(["en"], gpu=False, verbose=False)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    scale = OCR_LONG_SIDE / max(gray.shape)
    gray = cv2.resize(gray, None, fx=scale, fy=scale,
                      interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    gray = cv2.erode(gray, np.ones((3, 3), np.uint8))   # dark ink → thicker

    items = []
    for quad, text, conf in _reader.readtext(gray, allowlist=_OCR_ALLOWLIST):
        xs = [p[0] / scale for p in quad]
        ys = [p[1] / scale for p in quad]
        items.append(OcrItem(text, int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)), float(conf)))
    return merge_line_items(items)


def merge_line_items(items: list[OcrItem]) -> list[OcrItem]:
    """Join words that sit side by side on the same text line. A gap up to
    one text height counts as the same label, so "0.7 mH" stays together."""
    items = sorted(items, key=lambda i: i.x1)
    merged: list[OcrItem] = []
    for it in items:
        for m in merged:
            h = max(m.y2 - m.y1, it.y2 - it.y1, 1)
            same_line = abs(m.center[1] - it.center[1]) < 0.5 * h
            if same_line and 0 <= it.x1 - m.x2 <= h:
                m.text += it.text
                m.x2, m.y1, m.y2 = it.x2, min(m.y1, it.y1), max(m.y2, it.y2)
                m.conf = min(m.conf, it.conf)
                break
        else:
            merged.append(OcrItem(it.text, it.x1, it.y1, it.x2, it.y2, it.conf))
    return merged


# ── Parsing ─────────────────────────────────────────────────────

def _unit_of(suffix: str) -> str | None:
    """Explicit unit named at the end of a suffix like 'kΩ' / 'mH', if any."""
    s = suffix.strip()
    if not s:
        return None
    for unit, aliases in _UNIT_ALIASES.items():
        for a in sorted(aliases, key=len, reverse=True):
            if s.endswith(a) and (unit != "ohm" or len(a) > 1 or a in "ΩΩ"):
                return unit
    return None


def parse_value(text: str, cls_name: str | None = None) -> tuple[float | None, str | None]:
    """Returns (numeric_value, unit) for one label string, value in SI base
    units (7kΩ → (7000.0, "ohm")), or (None, None) if it isn't a value.

    `cls_name` selects the expected unit, which resolves ambiguous prefixes;
    a label whose explicit unit contradicts the class is rejected."""
    value, unit, _ = parse_value_ex(text, cls_name)
    return value, unit


def parse_value_ex(text: str, cls_name: str | None = None
                   ) -> tuple[float | None, str | None, bool]:
    """Like parse_value, plus `inferred`: True when a trailing digit was
    reinterpreted as a prefix ("43" → 4k), i.e. the value is a guess."""
    m = _NUMBER_RE.match(text.replace(" ", ""))
    if not m:
        return None, None, False
    digits = m.group(1)
    try:
        number = float(digits.translate(_DIGIT_FIXES))
    except ValueError:
        return None, None, False
    suffix = m.group(2)

    expected = CLASS_UNIT.get(cls_name) if cls_name else None
    explicit = _unit_of(suffix)
    if expected and explicit and explicit != expected:
        return None, None, False
    unit = expected or explicit
    if unit is None:
        return None, None, False

    multiplier = 1.0
    if suffix:
        prefix = suffix[0]
        prefixes = _PREFIXES[unit]
        # A lone letter that *is* the unit ("5V", "10F") isn't a prefix.
        is_unit_letter = len(suffix) == 1 and _unit_of(suffix) == unit
        if prefix in prefixes and not is_unit_letter:
            multiplier = prefixes[prefix]

    lo, hi = _PLAUSIBLE[unit]
    inferred = False
    trailing = _TRAILING_DIGIT_PREFIX.get(unit, {}).get(digits[-1:].translate(_DIGIT_FIXES))
    if multiplier == 1.0 and trailing and len(digits) > 1:
        if unit == "ohm":
            # bare number, or number + the ohm sign / a stray "n"
            eligible = suffix == "" or explicit == "ohm"
        else:
            # a bare farad/henry is implausible on a hand-drawn schematic, so
            # either the unit letter was written or the raw value is out of range
            eligible = explicit == unit or not (lo <= number <= hi)
        try:
            stripped = float(digits[:-1].translate(_DIGIT_FIXES))
        except ValueError:
            stripped = 0.0
        if eligible and stripped > 0:
            number, multiplier, inferred = stripped, trailing, True

    value = number * multiplier
    if lo <= value <= hi:
        return value, unit, inferred
    return None, None, False


# ── Matching labels to components ───────────────────────────────

def _box_distance(box, item: OcrItem) -> float:
    """Gap between the component box and the text box (0 if they overlap)."""
    dx = max(box.x1 - item.x2, item.x1 - box.x2, 0)
    dy = max(box.y1 - item.y2, item.y1 - box.y2, 0)
    return math.hypot(dx, dy)


def value_near_box(box, cls_name: str, items: list[OcrItem],
                   max_dist: float | None = None,
                   exclude: set[int] | None = None) -> tuple[float | None, str | None]:
    """Returns (numeric_value, unit) parsed from OCR text near the box, or (None, None) if nothing usable is found."""
    idx = _best_item(box, cls_name, items, max_dist, exclude)
    return parse_value(items[idx].text, cls_name) if idx is not None else (None, None)


def _best_item(box, cls_name, items, max_dist=None, exclude=None) -> int | None:
    """Index of the closest OCR item that parses as a value for this class."""
    if cls_name not in CLASS_UNIT:
        return None
    if max_dist is None:
        # labels are written beside the symbol: allow about one symbol-size away
        max_dist = 1.2 * max(box.x2 - box.x1, box.y2 - box.y1)
    best, best_d = None, float("inf")
    for i, item in enumerate(items):
        if exclude and i in exclude:
            continue
        d = _box_distance(box, item)
        if d > max_dist or d >= best_d:
            continue
        if parse_value(item.text, cls_name)[0] is None:
            continue
        best, best_d = i, d
    return best


def assign_values(components, items: list[OcrItem]) -> dict[str, tuple[float, str, bool]]:
    """Match labels to components ({ref_des: (value, unit)}). Each label is
    used at most once, closest pairs first, so a label between two parts
    goes to the nearer one and the other part looks further out.
    Each result is (value, unit, inferred); see parse_value_ex."""
    pairs = []
    for comp in components:
        for i, item in enumerate(items):
            if _best_item(comp.box, comp.cls_name, [item]) is not None:
                pairs.append((_box_distance(comp.box, item), comp, i))
    pairs.sort(key=lambda p: p[0])

    values: dict[str, tuple[float, str, bool]] = {}
    used: set[int] = set()
    for _, comp, i in pairs:
        if comp.component_id in values or i in used:
            continue
        value, unit, inferred = parse_value_ex(items[i].text, comp.cls_name)
        values[comp.component_id] = (value, unit, inferred)
        used.add(i)
    return values


# ── Output ──────────────────────────────────────────────────────

_SPICE_PREFIXES = [(1e9, "G"), (1e6, "Meg"), (1e3, "k"), (1, ""),
                   (1e-3, "m"), (1e-6, "u"), (1e-9, "n"), (1e-12, "p")]


def format_spice(value: float, unit: str, cls_name: str) -> str:
    """SI value → the value string NetlistGenerator / the frontend expect.
    'Meg' (not 'M') because SPICE reads 'M' as milli."""
    for mult, sym in _SPICE_PREFIXES:
        if value >= mult * 0.999:
            text = f"{value / mult:.4g}{sym}"
            break
    else:
        text = f"{value:.4g}"
    if cls_name in ("Voltage", "Battery", "Dep. Voltage"):
        return f"DC {text}"
    if cls_name == "AC Source":
        return f"AC {text}"
    return text
