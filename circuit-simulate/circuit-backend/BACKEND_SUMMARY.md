# Circuit Backend — Summary

FastAPI service behind the **NETSCOPE** schematic frontend (`circuit-sim`). It does two jobs:

1. **Simulate** a schematic by converting it to a SPICE deck and running **ngspice**.
2. **Generate** a schematic from a hand-drawn circuit image using a **YOLOv12n** detector plus an ink-based connectivity engine.

```
circuit-backend/
├── main.py             FastAPI app + all routes
├── recognizer.py       Image → netlist pipeline (loads the YOLO model)
├── drawn_topology.py   Pins + nets from the wire ink (replaces circuitmodel stages 2–4) + source polarity
├── value_reader.py     OCR of handwritten values ("4V", "0.7mH") → component values
├── requirements.txt
├── README.md           Setup / quick start
└── BACKEND_SUMMARY.md  This file
```

---

## 1. Running

```powershell
cd circuit-backend
pip install -r requirements.txt      # fastapi, uvicorn, ultralytics, opencv-python, numpy, scikit-image
pip install --no-deps easyocr        # optional: reads handwritten values (see §5)
uvicorn main:app --port 8000
```

> **Install easyocr with `--no-deps`.** A plain `pip install easyocr` pulls `opencv-python-headless` 5.x, which overwrites the `cv2` that ultralytics uses. Its other dependencies (torch, torchvision, scipy, scikit-image, shapely, pyclipper, python-bidi, PyYAML) are already present with ultralytics/scikit-image. The first OCR call downloads easyocr's detection and recognition models (≈100 MB). Without easyocr the route still works and every part keeps its default value.

- Server: `http://localhost:8000`, interactive API docs at `http://localhost:8000/docs`.
- **Avoid `--reload` on Windows** while using `/generate-circuit`: once the YOLO model is loaded, the reloader has been seen to hang on restart. Restart manually instead.
- `/simulate` needs **ngspice** on `PATH` (or `NGSPICE_PATH`). `/generate-circuit` needs the sibling `circuitmodel` repo.

### Environment variables

| Variable | Default | Used by |
|---|---|---|
| `NGSPICE_PATH` | `ngspice` | `/simulate` |
| `CIRCUIT_MODEL_DIR` | `<FYPPP>/circuitmodel` (resolved relative to this folder) | `/generate-circuit` |
| `CIRCUIT_MODEL_WEIGHTS` | `$CIRCUIT_MODEL_DIR/circuit_detector_v2_best.pt` | `/generate-circuit` |

Frontend side (`circuit-sim/.env`): `VITE_SIMULATE_URL`, `VITE_GENERATE_URL`.

CORS is open (`allow_origins=["*"]`), which is fine for local development but should be tightened for deployment.

---

## 2. Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/simulate` | Schematic netlist → ngspice → node voltages / branch currents |
| `POST` | `/generate-circuit` | Circuit image → detected components + nets (netlist JSON) |

### 2.1 `GET /health`

```json
{ "status": "ok" }
```

### 2.2 `POST /simulate`

Called by the **Simulate** button. Body mirrors `circuit-sim/src/api/simulate.ts`.

**Request**

```json
{
  "netlist": {
    "version": 1,
    "components": [
      { "id": "…", "ref": "R1", "type": "resistor",   "nodes": ["1", "0"], "params": { "resistance": 1000 } },
      { "id": "…", "ref": "V1", "type": "vsource_dc", "nodes": ["1", "0"], "params": { "voltage": 5 } }
    ],
    "nets": ["0", "1"]
  },
  "analysis": {
    "mode": "dc",
    "tran": { "stepSeconds": 1e-6, "stopSeconds": 1e-3 },
    "ac":   { "startHz": 1, "stopHz": 1e6, "pointsPerDecade": 20 }
  }
}
```

**Response**

```json
{ "ok": true, "traces": { "I(V1)": [-0.005], "V(1)": [5.0] } }
```

On a run that produced no parseable values: `{ "ok": false, "message": "…raw ngspice output…" }`.

**How it works**

1. `_build_spice_deck()` maps each component type to a SPICE line:

   | `type` | SPICE | Param (default) |
   |---|---|---|
   | `resistor` | `R… n1 n2 R` | `resistance` (1000) |
   | `capacitor` | `C… n1 n2 C` | `capacitance` (1e-6) |
   | `inductor` | `L… n1 n2 L` | `inductance` (1e-3) |
   | `vsource_dc` | `V… n1 n2 DC V` | `voltage` (5) |
   | `vsource_ac` | `V… n1 n2 AC V SIN(0 V f)` | `voltage` (1), `frequency` (50) |
   | `ground` | — (node marker only) | — |

2. Appends `.op` / `.end`, writes a temp `.cir`, runs `ngspice -b` (30 s timeout).
3. Regex-parses `i(vX) = …` and `v(node) = …` from stdout into single-element traces.

**Errors:** `500` if ngspice is missing or times out.

**Limitations to know**

- Always runs a **DC operating point** (`.op`). `analysis.mode`, `tran` and `ac` are accepted but **not used yet**.
- Only voltage-source currents (`I(Vx)`) and node voltages are returned, not per-resistor currents.
- Diodes / dependent sources are not mapped to SPICE here.

### 2.3 `POST /generate-circuit`

Called by the **⚡ Generate Circuit** button of the drawing modal (`DrawCircuitModal.tsx`). The frontend always exports the drawing as **black ink on white**, whatever the on-screen theme, because that's what the model was trained on.

**Request**

```json
{ "image": "data:image/png;base64,iVBORw0…", "title": "drawn-circuit" }
```

`image` may be a `data:` URL or bare base64 (PNG or JPEG; transparency is flattened onto white).

**Response** — the same schema as `circuitmodel`'s `netlist.json`, which `loadNetlistJson()` on the frontend consumes directly:

```json
{
  "title": "drawn-circuit",
  "timestamp": "2026-09-29 20:23:41",
  "image": { "width": 1600, "height": 1000 },
  "grid":  { "circuitjs_grid": 16, "scale_x": 0.01, "scale_y": 0.016 },
  "nets": [
    { "id": "VCC",  "pins": ["L1.A", "V1.+"] },
    { "id": "N001", "pins": ["C1.B", "V1.-"] }
  ],
  "components": [
    { "ref_des": "R1", "type": "Resistor", "value": "1k",
      "net_pos": "N002", "net_neg": "N003", "spice_line": "R1 N002 N003 1k" }
  ],
  "component_details": [
    { "ref_des": "R1", "type": "Resistor", "conf": 0.816, "value_source": "ocr",
      "bbox": { "x1": 485, "y1": 80, "x2": 616, "y2": 137, "cx": 550, "cy": 108 },
      "pins": [ { "name": "A", "x": 485, "y": 109, "net_id": "N002" },
                { "name": "B", "x": 616, "y": 123, "net_id": "N003" } ] }
  ],
  "dropped_detections": [
    { "type": "Capacitor", "conf": 0.813, "bbox": { "x1": 563, "y1": 234, "x2": 609, "y2": 303 } }
  ]
}
```

- `component_details` is what gives the frontend each part's position and orientation.
- `value_source`: `"ocr"` (read from the drawing), `"ocr_inferred"` (read, but a trailing digit was reinterpreted as a prefix, e.g. "43" → 4k, so it is a guess) or `"default"`.
- `polarity` (sources only) says how `+` was decided: `"marks"` (drawn +/− signs), `"plates"` (battery long/short plate) or `"default"` (assumed top/right).
- `dropped_detections` lists detections discarded because no wire touches them (usually handwritten labels). It's for debugging and the frontend ignores it.
- Pin names: `A`/`B` (R, L, C), `+`/`-` (sources), `anode`/`cathode` (diode), `GND` (ground).
- Net names: `GND` if a ground symbol is on it, `VCC` for the source `+` net, otherwise `N001`, `N002`, … Multiple ground symbols merge into one `GND` net.

**Errors**

| Code | When |
|---|---|
| `400` | `image` is not valid base64 |
| `422` | Image can't be decoded · no components detected · symbols found but no wire touches any of them · weights file missing |

---

## 3. The model

### 3.1 What it is

| | |
|---|---|
| Architecture | **YOLOv12n** (nano), Ultralytics `8.4.x`, starting from COCO-pretrained `yolo12n.pt` |
| Task | Object detection: bounding box + class per circuit symbol |
| Weights used | `circuitmodel/circuit_detector_v2_best.pt` (hand-drawn fine-tune) |
| Older weights | `circuitmodel/circuit_detector_best.pt` (v1, 8 classes; not used by the backend) |
| Inference settings | `conf = 0.25`, `iou = 0.45` (`recognizer.py`) |
| Loading | Loaded once on the first request, then reused; a lock serialises predictions |

### 3.2 Classes (v2)

| ID | Class | Frontend support |
|---|---|---|
| 0 | AC Source | ✅ `vsource_ac` |
| 1 | Battery | ✅ as `vsource_dc` |
| 2 | Capacitor | ✅ |
| 3 | Diode | ⚠️ detected, not drawable yet (nets bridged across it) |
| 4 | Ground | ✅ |
| 5 | Inductor | ✅ |
| 6 | Resistor | ✅ |
| 7 | Voltage | ✅ `vsource_dc` |
| 8 | Dep. Voltage | ⚠️ detected, not drawable yet (nets bridged across it) |

### 3.3 How it was trained (from `circuitmodel/`)

**v1 — `yolocircuit.py`**
- Data: two Roboflow datasets merged and remapped to shared class IDs: *Hand Drawn Circuits v3* and *Electronic Circuit v8* → `merged_dataset` (633 train / 38 val / 22 test).
- `epochs 100`, `imgsz 640`, `batch 8`, `lr0 0.01`, `warmup 5`, `patience 30`.
- Augmentation: mosaic 1.0, mixup 0.1, rotation ±15°, horizontal flip 0.5, **no vertical flip** (circuits have orientation).

**v2 — `finetune_prep.py` + `kaggle_finetune.py`** (the weights in use)
- Adds *SolvaDataset_200_v3* (hand-drawn symbols) → `merged_dataset_v2`, and adds the 9th class, **Dep. Voltage**. Ammeter, voltmeter and current sources were skipped.
- SolvaDataset is a *classification* set (one symbol per image). Its YOLO labels were **auto-generated as a centred box**, not hand-drawn.
- Fine-tuned from v1 on Kaggle GPU: `epochs 60`, `imgsz 640`, `batch 16`, `lr0 0.001` (10× lower), `freeze 10` backbone layers, `patience 15`.

### 3.4 Known model issues

Measured on `target/diagram.jpg` (a canvas drawing) and the sample photos in `circuitmodel/`.

1. **Handwritten text is detected as components**, sometimes with high confidence:
   - "0.6µF" → Capacitor **81%**; "4V" → Ground 63%; "7kΩ" / "0.7mH" → Ground 29–34%.
   - "8V" → Inductor **79%** in `n1.jpeg`.

   Real parts scored 77–82%, so no confidence threshold separates them. The likely cause is that labels were never annotated as negatives. The engine drops detections that no wire touches (§4), but a label drawn touching a wire can still get through.
2. **Values are not read by the model.** A separate OCR step now reads them (§5), with limited accuracy on handwriting.
3. **Polarity is not detected by the model.** The engine now works it out from the source's own ink (§4, stage 7b). Diode direction is still assumed (anode left/top).
6. **Battery vs capacitor.** A synthetic battery symbol (long + short plate) was detected as a *Capacitor*. So the battery plate heuristic only helps when the model actually outputs `Battery`. This was only tested on a synthetic drawing, so real battery drawings may do better; unconfirmed.
4. **Loose boxes.** Boxes often extend past the symbol. This is plausibly caused by the auto-generated centred labels in the v2 data. The engine tolerates it by finding pins from wire contacts, not from box shape.
5. **Busy or lined-paper photos** give many low-confidence or duplicate detections (e.g. `mycircuit2.jpg`). Ruled notebook lines also read as wires.

**Suggested retraining:** annotate value text as a negative / `text` class; add canvas-style drawings (clean strokes on a plain background); replace the auto-centred SolvaDataset boxes with tight ones; optionally annotate `+` markers.

---

## 4. `/generate-circuit` pipeline in detail

```
image ─► decode_image ─► YOLO detect ─► DrawnTopology ─► NetlistGenerator ─► JSON
          (recognizer)    (model)        (drawn_topology)  (circuitmodel)
```

| Stage | Where | What it does |
|---|---|---|
| 1. Decode | `recognizer.decode_image` | base64 → BGR image; alpha flattened onto white |
| 2. Detect | `recognizer.recognize` | YOLOv12n → boxes with class + confidence |
| 3. Dedupe | `drawn_topology.dedupe_boxes` | Class-agnostic: if two boxes overlap > 70 % of the smaller, keep the more confident |
| 4. Ink mask | `drawn_topology.binarize` | Otsu threshold for clean canvas images; Otsu ∧ adaptive for photos |
| 5. Wire blobs | `DrawnTopology._wire_labels` | Erase all component boxes → remaining ink is wire; small morphological close; connected-component labelling (**one blob = one net**) |
| 6. Gap bridging | `DrawnTopology._bridge_gaps` | Skeletonise; for each free stroke end *not next to a component*, join it to any other blob within ~3 % of the image diagonal (hand-drawn corners rarely meet exactly) |
| 7. Terminals | `DrawnTopology._contacts` / `_make_pins` | In a thin ring just outside each box, every cluster of wire ink is a terminal. The two farthest-apart contacts are the pins, snapped to the box edge. This gives the true orientation (e.g. a wide capacitor with top/bottom leads) |
| 7b. Source polarity | `DrawnTopology._orient_source` | AC Source / Battery / Voltage only. ① **marks**: small blobs inside the box not touching its edge; squarish + sparse = `+`, flat bar = `−`; the `+` end is the one nearer the `+` mark (or farther from the `−`). Contradictory marks → undecided. ② **plates**: ink width across the lead axis at each step; two separate peaks = plates, the end with the ≥1.3× longer plate is `+` (a circle gives one peak → undecided). ③ **default**: `+` top / right. Pins are renamed only; positions and nets don't change |
| 8. Filter | `DrawnTopology.build` | Ink touching only one box is a stub (usually text), not a wire. Boxes left with no wired contact are dropped and stages 5–7 re-run without them (up to 3 passes) |
| 9. Nets | `DrawnTopology._nets` | Pins grouped by blob → `GND` / `VCC` / `N00x` |
| 10. Netlist | `circuitmodel/netlist_generator.py` | `NetlistGenerator(interactive=False)` fills default values and builds SPICE lines; `recognizer` adds `component_details` and `dropped_detections` |
| 11. Values | `value_reader` | OCR (§5) → each label assigned to the nearest part whose class it fits (each label used once) → overrides the default |

**Why not the original `circuit_pipeline.py` stages?** They were tuned for ~4000 px phone photos. The fixed 150 px pin-snap distance merged every pin of a canvas drawing into one net, and pins were guessed from the box's aspect ratio (left/right unless tall). The ink-based engine has no absolute pixel thresholds; distances scale with the image. `circuitmodel` itself is unchanged and still used for YOLO, the data types and `NetlistGenerator`.

**Verified results**

| Input | Result |
|---|---|
| `target/diagram.jpg` (canvas drawing, 4V · 0.7 mH · 7 kΩ · 0.6 µF loop) | ✅ Correct: `V1+ → L1 → R1 → C1 → V1−`, 4 text false-positives dropped; same result at 822 px and 1600 px |
| `mycircuit1.jpeg` (photo) | ✅ Clean 4-net loop (old pipeline: 8 nets) |
| `n2.jpeg` (photo) | ✅ Clean 3-net loop |
| `n1.jpeg` (lined paper) | ❌ Ruled lines read as wires, plus "8V" detected as an inductor |

**Frontend side** (`circuit-sim/src/utils/loadNetlistJson.ts`): when every part has `component_details`, parts are placed where they were drawn and rotated to match their detected pins. Wires are routed along each pin's outward direction (`geometry.orthogonalPath`). Before generating, the canvas is fully cleared.

---

## 5. Value OCR (`value_reader.py`)

| Step | Detail |
|---|---|
| Engine | **easyocr** (English, CPU), loaded once. Optional; if it isn't installed, the step returns nothing |
| Preprocess | Resample to 1650 px long side (`OCR_LONG_SIDE`, chosen empirically), erode to thicken strokes, allowlist `0-9 . k K m M u U n N p P v V f F h H` |
| Merge | Words on one line with a gap ≤ one text-height are joined ("0.7" + "mH") |
| Second reading | Each label easyocr found is also read by **TrOCR** (`microsoft/trocr-small-handwritten`, a handwriting model): crop with 0.3× text-height vertical padding, resized to 64 px high. easyocr is trained on print and turns unit letters into digits ("9V" → "93", "2mH" → "2n31", "7kΩ" → "1kn"); TrOCR reads most of those right but has its own misses. `parse_item` scores each reading for the part's class: +2 names the right unit, −1 the prefix slot holds a letter that is neither prefix nor unit ("0.7th"), +1 no trailing-digit guess, +2 both engines agree; ties go to TrOCR. The trailing-digit rule is not applied to TrOCR readings. Optional (`transformers` + `sentencepiece`); `VALUE_OCR_TROCR=0` turns it off. Adds ≈0.3 s per label on CPU |
| Parse | `parse_value(text, class)`: number + prefix + optional unit. OCR fixes in the number (O→0, l/I→1, `,`→`.`). Prefixes are read according to the part's class (see below). An explicit unit that contradicts the class is rejected ("0.7mH" is never a resistor). Values outside a plausible range are rejected (R 0.1 Ω–1 GΩ, C 1 pF–0.1 F, L 1 nH–10 H, V 1 mV–10 kV) |
| Prefix-as-digit rule | The prefix letter is often read as a digit glued onto the number ("4k" → "43"/"46", "47k" → "476", "0.6µF" → "0.64F", "47u" → "470"). `_TRAILING_DIGIT_PREFIX`: resistor **3, 6 → k**; capacitor **4, 6, 0 → µ**; inductor **4 → µ**. Only when no prefix letter was read. For C/L also requires that the unit letter was written or the raw value is out of range. Results are flagged `ocr_inferred`. **Cost:** genuine resistor values 13, 16, 33, 36, 43 and 56 Ω are also rewritten (to 1k, 1k, 3k, 3k, 4k, 5k). `m` has no rule: it was read correctly in every test, so there was no confusion to fix |
| Assign | `assign_values`: closest (label, part) pairs first; each label and part used once; the label must be within ~1.2× the symbol size |
| Output | `format_spice`: `7k`, `600n`, `700u`, `2Meg` (not `M`, which SPICE reads as milli), `DC 4`, `AC 1` |

Prefixes by class: on a capacitor, u/U/M mean µ (mega-farads don't exist); on an inductor, m/M mean milli; on a resistor, m/M mean mega.

**Measured accuracy** (values found / values written on the drawing):

| Input | Written | Read | Result |
|---|---|---|---|
| Canvas drawing (`diagram.jpg` exported black-on-white, 822 px and 1600 px) | 4V · 0.7mH · 7kΩ · 0.6µF | `DC 4` · `700u` · `7k` · `600n` | **4 / 4** with TrOCR (easyocr alone: 3 / 4, "7k" read as "1k") |
| Synthetic script-font drawings, 1600 px (9V · 2mH · 4.7k / 12V · 5mH · 220 / 3V · 10mH · 10k) | 9 values | all 9 | **9 / 9** with TrOCR (easyocr alone: 7 / 9, "9V" → 93 V, "2mH" → 2 nH) |
| `n1.jpeg` (lined-paper photo) | 8V · 12Ω · 45µF | **`DC 2`** · **`4`** · default | **0 / 3**: two wrong values assigned, one rejected by the range check |
| `n2.jpeg`, `mycircuit1.jpeg` | none | none | ✅ No false values (junk like "mF" rejected) |

Takeaway: OCR helps on clean canvas drawings but **is not reliable on handwriting**. It can assign a wrong value with no warning, so values should always be checked in the properties panel. `value_source` shows which values came from OCR. It adds ≈5 s per request on CPU (the first request also loads the models).

**Polarity, measured:**

| Input | `+` actually at | Method | Result |
|---|---|---|---|
| Canvas drawing | top | marks | ✅ |
| Canvas drawing, source flipped (822 px & 1600 px) | **bottom** | marks | ✅ `+` moved to bottom, `VCC` net followed |
| `mycircuit1.jpeg` / `n2.jpeg` | top | marks | ✅ (checked by eye) |
| `mycircuit1.jpeg`, source flipped | **bottom** | marks | ✅ |
| `n1.jpeg` | top | default | ✅ by fallback. Marks weren't found (lined paper + loose box) |
| Synthetic battery, long plate left / right (class forced to `Battery`) | left / right | plates | ✅ both. **But the model itself labels this symbol Capacitor**, so this path isn't reached end-to-end |
| Circle source with plates check forced | – | plates abstains | ✅ correctly undecided |

The flipped tests were made by mirroring the source's own box region in existing images, not by redrawing. They show the heuristic reads the marks, but they aren't independent drawings.
