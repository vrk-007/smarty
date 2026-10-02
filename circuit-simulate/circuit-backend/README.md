# circuit-backend

Python/FastAPI backend for the circuit simulator. Accepts JSON netlists from the frontend, builds SPICE decks, runs them via **ngspice**, and returns DC operating-point results (branch currents, node voltages).

> Full reference for every route, the YOLO model and the drawing-recognition pipeline: **[BACKEND_SUMMARY.md](BACKEND_SUMMARY.md)**.

## Prerequisites

| Dependency | Install |
|---|---|
| Python ≥ 3.11 | https://python.org |
| ngspice | `winget install ngspice` **or** https://ngspice.sourceforge.io |
| pip packages | `pip install -r requirements.txt` |

> **Windows ngspice tip**: If `ngspice` is not on PATH after installation, set the env var:
> ```
> $env:NGSPICE_PATH = "C:\Program Files\Spice64\bin\ngspice.exe"
> ```

## Running

```powershell
cd circuit-backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The server starts at **http://localhost:8000**.

## API

### `POST /simulate`

**Request body** (mirrors what the frontend already sends):

```json
{
  "netlist": {
    "version": 1,
    "components": [
      { "id": "...", "ref": "R1", "type": "resistor",   "nodes": ["1","0"], "params": {"resistance": 1000} },
      { "id": "...", "ref": "V1", "type": "vsource_dc", "nodes": ["1","0"], "params": {"voltage": 5} }
    ],
    "nets": ["0","1"]
  },
  "analysis": { "mode": "dc", "tran": { "stepSeconds": 1e-6, "stopSeconds": 1e-3 }, "ac": { "startHz": 1, "stopHz": 1e6, "pointsPerDecade": 20 } }
}
```

**Response**:

```json
{
  "ok": true,
  "traces": {
    "I(V1)": [-0.005],
    "V(1)":  [5.0]
  }
}
```

Current values are also **console-logged in Amperes** by the server.

### `GET /health`

Returns `{ "status": "ok" }`.

### `POST /generate-circuit`

Turns an image of a hand-drawn circuit (the frontend's **✎ Draw Circuit** canvas) into a netlist using the YOLO pipeline in the sibling `circuitmodel` repo.

**Request**: `{ "image": "data:image/png;base64,...", "title": "drawn-circuit" }`

**Response**: the same JSON as `circuitmodel`'s `netlist.json` (`components`, `nets`, `component_details`, `wires`, ...). Returns `422` with a `detail` message if nothing is recognised.

| Env var | Default |
|---|---|
| `CIRCUIT_MODEL_DIR` | `<FYPPP>/circuitmodel` |
| `CIRCUIT_MODEL_WEIGHTS` | `$CIRCUIT_MODEL_DIR/circuit_detector_v2_best.pt` |

Component values are filled in with defaults (1k, 10u, DC 5, ...). You can edit them afterwards in the properties panel.
