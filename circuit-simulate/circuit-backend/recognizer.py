"""
circuit-backend/recognizer.py
==============================
Runs YOLO component detection from circuitmodel, then derives terminals and
connectivity from the wire ink (drawn_topology.py), then builds the netlist on a single in-memory image and returns the same
netlist JSON dict that `circuit_pipeline.py` writes to netlist.json, so the
frontend's loadNetlistJson() can consume it directly.

The pipeline modules live in the sibling `circuitmodel` repo. Its location
defaults to <FYPPP>/circuitmodel and can be overridden with CIRCUIT_MODEL_DIR.
The weights file defaults to the hand-drawn fine-tuned model and can be
overridden with CIRCUIT_MODEL_WEIGHTS.
"""

import os
import sys
import threading
from pathlib import Path

import cv2
import numpy as np

MODEL_DIR = Path(
    os.environ.get(
        "CIRCUIT_MODEL_DIR",
        Path(__file__).resolve().parents[3] / "circuitmodel",
    )
)
WEIGHTS = Path(
    os.environ.get("CIRCUIT_MODEL_WEIGHTS", MODEL_DIR / "circuit_detector_v2_best.pt")
)

# Same tuning as circuit_pipeline.py
YOLO_CONF       = 0.25
YOLO_IOU        = 0.45

if str(MODEL_DIR) not in sys.path:
    sys.path.insert(0, str(MODEL_DIR))

_model = None
_model_lock = threading.Lock()


class RecognitionError(Exception):
    pass


def _get_model():
    """Load the YOLO weights once and reuse them across requests."""
    global _model
    with _model_lock:
        if _model is None:
            if not WEIGHTS.exists():
                raise RecognitionError(
                    f"Model weights not found at '{WEIGHTS}'. "
                    "Set CIRCUIT_MODEL_WEIGHTS or CIRCUIT_MODEL_DIR."
                )
            from ultralytics import YOLO
            _model = YOLO(str(WEIGHTS))
        return _model


def decode_image(data: bytes) -> np.ndarray:
    """Decode PNG/JPEG bytes to a BGR image, flattening any alpha onto white
    (canvas exports have a transparent background by default)."""
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RecognitionError("Could not decode the uploaded image.")
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        rgb = img[:, :, :3].astype(np.float32)
        img = (rgb * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
    return img


def detect_boxes(image: np.ndarray) -> list:
    """YOLO component detection only (no wires, no OCR): fast enough to run
    while the user is still drawing."""
    from wire_detector import BoundingBox

    model = _get_model()
    with _model_lock:
        preds = model.predict(source=image, conf=YOLO_CONF, iou=YOLO_IOU, verbose=False)

    names = model.names
    boxes: list[BoundingBox] = []
    for box in preds[0].boxes:
        x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
        boxes.append(BoundingBox(
            x1=x1, y1=y1, x2=x2, y2=y2,
            cls_name=names[int(box.cls.item())],
            conf=float(box.conf.item()),
        ))
    return boxes


def recognize(image: np.ndarray, title: str = "drawn-circuit") -> dict:
    """Run the full pipeline and return the netlist JSON dict."""
    from netlist_generator import NetlistGenerator
    from drawn_topology    import DrawnTopology
    from value_reader      import assign_values, format_spice, run_ocr

    # ── 1. Component detection ──────────────────────────────────
    boxes = detect_boxes(image)

    if not boxes:
        raise RecognitionError(
            "No components were recognised in the drawing. "
            "Try drawing the symbols larger and more clearly."
        )

    # ── 2–4. Terminals + connectivity from the actual wire ink ──
    topology = DrawnTopology(image)
    components, conn_result, dropped = topology.build(boxes)
    if not components:
        raise RecognitionError(
            "Symbols were detected but no wires touch them, so no circuit could "
            "be built. Make sure each wire runs right up to the component ends."
        )

    # ── 5. Netlist (non-interactive: default component values) ──
    netlist = NetlistGenerator(interactive=False).generate(
        components, conn_result, title=title
    )

    # ── 6. Handwritten values (OCR; defaults stay if unreadable/unavailable) ──
    ocr_items = run_ocr(image)
    read = assign_values(components, ocr_items)
    for entry in netlist.entries:
        if entry.ref_des in read:
            value, unit, _ = read[entry.ref_des]
            entry.value = format_spice(value, unit, entry.cls_name)

    h, w = image.shape[:2]
    netlist.image_width = w
    netlist.image_height = h
    netlist.component_details = []
    for comp in components:
        netlist.component_details.append({
            "ref_des": comp.component_id,
            "type": comp.cls_name,
            "bbox": {
                "x1": comp.box.x1, "y1": comp.box.y1,
                "x2": comp.box.x2, "y2": comp.box.y2,
                "cx": (comp.box.x1 + comp.box.x2) // 2,
                "cy": (comp.box.y1 + comp.box.y2) // 2,
            },
            "conf": round(comp.box.conf, 3),
            "value_source": (
                "default" if comp.component_id not in read
                else "ocr_inferred" if read[comp.component_id][2]
                else "ocr"
            ),
            **({"polarity": topology.polarity_method[comp.component_id]}
               if comp.component_id in topology.polarity_method else {}),
            "pins": [
                {
                    "name": pin.name,
                    "x": pin.x,
                    "y": pin.y,
                    "net_id": conn_result.pin_to_net.get(f"{comp.component_id}.{pin.name}", "?"),
                }
                for pin in comp.pins
            ],
        })

    result = netlist.to_json_dict()
    # Detections discarded because no wire touches them (usually handwritten
    # labels the detector mistook for parts) — surfaced for debugging.
    result["dropped_detections"] = [
        {"type": d.cls_name, "conf": round(d.conf, 3),
         "bbox": {"x1": d.x1, "y1": d.y1, "x2": d.x2, "y2": d.y2}}
        for d in dropped
    ]
    return result
