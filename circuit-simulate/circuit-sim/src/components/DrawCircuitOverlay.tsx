import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { detectComponents, generateCircuitFromImage, type Detection } from "../api/generateCircuit";
import type { JsonNetlist } from "../utils/loadNetlistJson";

/** Long side (px) of the image sent to the model. The drawing fills the
 *  schematic area on screen and is rescaled to this size on export, so the
 *  model sees the same resolution it did with the old fixed 1600×1000 pad. */
const EXPORT_LONG_SIDE = 1600;

type Tool = "pen" | "eraser";

interface Stroke {
  tool: Tool;
  /** Line width in export pixels, so the model sees the same thickness
   *  whatever the size of the screen. */
  width: number;
  /** Points in CSS pixels relative to the drawing surface. */
  points: { x: number; y: number }[];
}

interface DrawCircuitOverlayProps {
  onClose: () => void;
  /** Open the image file picker as soon as the overlay mounts. */
  pickImageOnOpen?: boolean;
}

/** Read an image file and re-encode it with its long side capped at
 *  EXPORT_LONG_SIDE, flattened onto white (transparent PNGs, huge photos). */
function loadImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, EXPORT_LONG_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const out = document.createElement("canvas");
      out.width = Math.round(img.naturalWidth * k);
      out.height = Math.round(img.naturalHeight * k);
      const ctx = out.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(img, 0, 0, out.width, out.height);
      URL.revokeObjectURL(url);
      resolve(out.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file couldn't be opened as an image."));
    };
    img.src = url;
  });
}

/** Pause (ms) after the last stroke before run-time processing kicks in. */
const RTP_DELAY = 450;

/** Freehand drawing layer laid over the schematic canvas area. */
export function DrawCircuitOverlay({ onClose, pickImageOnOpen }: DrawCircuitOverlayProps) {
  const loadNetlist = useCircuitStore((s) => s.loadNetlist);
  const clearAll = useCircuitStore((s) => s.clearAll);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<Stroke | null>(null);
  const sizeRef = useRef({ w: 1, h: 1 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [penWidth, setPenWidth] = useState(5);
  const [strokeCount, setStrokeCount] = useState(0);
  const [status, setStatus] = useState<"idle" | "generating">("idle");
  const [error, setError] = useState<string | null>(null);
  /** An uploaded circuit image; when set it is sent instead of the drawing. */
  const [image, setImage] = useState<string | null>(null);

  // ── Run-time processing (RTP): detect parts while drawing ──
  const [rtp, setRtp] = useState(false);
  /** Bumped on every change to the ink, so stale RTP results are ignored. */
  const [drawVersion, setDrawVersion] = useState(0);
  const [detections, setDetections] = useState<{ items: Detection[]; scale: number } | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** Full circuit recognised in the background for the current drawing. */
  const prefetchRef = useRef<{ version: number; result: Promise<JsonNetlist> } | null>(null);
  const prefetchBusyRef = useRef(false);

  useEffect(() => {
    if (!rtp || image || strokesRef.current.length === 0) {
      setDetections(null);
      setDetecting(false);
      return;
    }
    const version = drawVersion;
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      const k = exportScale();
      const png = exportForModel();
      setDetecting(true);
      // Recognise the whole circuit in the background too, so placing it
      // afterwards is instant.
      // Only one at a time: OCR is slow and the server would queue them up.
      if (!prefetchBusyRef.current) {
        prefetchBusyRef.current = true;
        const result = generateCircuitFromImage(png);
        result.catch(() => {}).finally(() => (prefetchBusyRef.current = false));
        prefetchRef.current = { version, result };
      }
      try {
        const items = await detectComponents(png, abort.signal);
        if (!abort.signal.aborted) setDetections({ items, scale: k });
      } catch {
        /* aborted by newer ink, or backend unreachable: keep last boxes */
      } finally {
        if (!abort.signal.aborted) setDetecting(false);
      }
    }, RTP_DELAY);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtp, drawVersion, image]);

  useEffect(() => {
    if (pickImageOnOpen) fileInputRef.current?.click();
  }, [pickImageOnOpen]);

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setImage(await loadImageFile(file));
      strokesRef.current = [];
      setStrokeCount(0);
      setError(null);
      redraw();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Export px per CSS px for the current surface size. */
  const exportScale = () => EXPORT_LONG_SIDE / Math.max(sizeRef.current.w, sizeRef.current.h);

  // Match the canvas backing store to the surface size (and pixel ratio).
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !canvas) return;
    const resize = () => {
      const w = Math.max(1, surface.clientWidth);
      const h = Math.max(1, surface.clientHeight);
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w, h };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(surface);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Paint strokes onto a transparent layer. The eraser cuts ink away
   *  (destination-out) rather than painting a background colour over it,
   *  so the same strokes render on the dark screen and the white export.
   *  `scale` maps CSS px to the target; `widthScale` maps export-px widths. */
  function paintStrokes(ctx: CanvasRenderingContext2D, ink: string, scale: number, widthScale: number) {
    const all = activeRef.current
      ? [...strokesRef.current, activeRef.current]
      : strokesRef.current;
    for (const s of all) {
      if (s.points.length === 0) continue;
      const lw = s.width * widthScale;
      ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.beginPath();
        ctx.arc(p.x * scale, p.y * scale, lw / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * scale, s.points[0].y * scale);
      for (const p of s.points.slice(1)) ctx.lineTo(p.x * scale, p.y * scale);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function redraw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Dark grid background comes from CSS; the canvas only holds the ink.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // On-screen ink only; the export for the model is always black on white.
    const ink = "#4da3ff";
    const dpr = canvas.width / sizeRef.current.w;
    paintStrokes(ctx, ink, dpr, dpr / exportScale());
  }

  /** The model was trained on ink-on-paper photos, so export the drawing
   *  as black strokes on white regardless of the on-screen theme. */
  function exportForModel(): string {
    const k = exportScale();
    const w = Math.round(sizeRef.current.w * k);
    const h = Math.round(sizeRef.current.h * k);

    const layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    paintStrokes(layer.getContext("2d")!, "#111111", k, 1);

    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(layer, 0, 0);
    return out.toDataURL("image/png");
  }

  function toSurfacePoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (status === "generating" || image || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activeRef.current = {
      tool,
      width: tool === "eraser" ? penWidth * 6 : penWidth,
      points: [toSurfacePoint(e)],
    };
    redraw();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!activeRef.current) return;
    activeRef.current.points.push(toSurfacePoint(e));
    redraw();
  }

  function handlePointerUp() {
    if (!activeRef.current) return;
    strokesRef.current.push(activeRef.current);
    activeRef.current = null;
    setStrokeCount(strokesRef.current.length);
    setDrawVersion((v) => v + 1);
    redraw();
  }

  function undo() {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    setDrawVersion((v) => v + 1);
    redraw();
  }

  function clear() {
    setImage(null);
    strokesRef.current = [];
    setStrokeCount(0);
    setDrawVersion((v) => v + 1);
    setError(null);
    redraw();
  }

  async function handleGenerate() {
    setStatus("generating");
    setError(null);
    try {
      const pre = prefetchRef.current;
      const netlist =
        rtp && !image && pre && pre.version === drawVersion
          ? await pre.result
          : await generateCircuitFromImage(image ?? exportForModel());
      if (!netlist.components?.length) {
        throw new Error(
          "The model found symbols but couldn't connect them into a circuit. " +
            "Make sure every wire touches the component ends."
        );
      }
      // Wipe the previous schematic completely before placing the new one.
      clearAll();
      const skipped = loadNetlist(netlist);
      if (skipped.length > 0) {
        alert(
          `Circuit generated.\n\nThese detected parts aren't drawable on the canvas yet and were skipped:\n  ${skipped.join(", ")}`
        );
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }

  const busy = status === "generating";
  const hasInput = strokeCount > 0 || image !== null;

  return (
    <div className="draw-overlay" ref={surfaceRef}>
      {image && <img className="draw-image" src={image} alt="Uploaded circuit" />}
      <canvas
        ref={canvasRef}
        className={`draw-canvas${tool === "eraser" ? " erasing" : ""}${image ? " has-image" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className="draw-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleImageChange}
        />
        <button
          className="btn btn-xs"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          title="Use a photo or scan of a circuit instead of drawing one"
        >
          Load Image
        </button>

        <div className="view-toggle" role="group" aria-label="Drawing tool">
          <button
            className={`view-toggle-btn${tool === "pen" ? " active" : ""}`}
            disabled={image !== null}
            onClick={() => setTool("pen")}
          >
            Pen
          </button>
          <button
            className={`view-toggle-btn${tool === "eraser" ? " active" : ""}`}
            disabled={image !== null}
            onClick={() => setTool("eraser")}
          >
            Eraser
          </button>
        </div>

        <label className="draw-width">
          <span className="field-label">Width</span>
          <input
            type="range"
            min={2}
            max={12}
            value={penWidth}
            onChange={(e) => setPenWidth(Number(e.target.value))}
          />
        </label>

        <button
          className={`btn btn-xs rtp-toggle${rtp ? " on" : ""}`}
          onClick={() => setRtp((v) => !v)}
          disabled={busy || image !== null}
          aria-pressed={rtp}
          title="Run-time processing: detect components as soon as they are drawn"
        >
          RTP {rtp ? "On" : "Off"}
        </button>
        {rtp && <span className="hint-text rtp-status">{detecting ? "Detecting…" : detections ? `${detections.items.length} found` : "Draw to detect"}</span>}

        <button className="btn btn-xs" onClick={undo} disabled={busy || strokeCount === 0}>
          Undo
        </button>
        <button className="btn btn-xs btn-danger" onClick={clear} disabled={busy || !hasInput}>
          Clear
        </button>

        <button
          className="btn-primary draw-generate"
          onClick={handleGenerate}
          disabled={busy || !hasInput}
          title="Clears the current schematic and replaces it with the recognised circuit"
        >
          {busy ? (rtp ? "Placing…" : "Generating…") : rtp ? "Place Circuit" : "Generate Circuit"}
        </button>
        <button className="btn btn-xs" onClick={onClose} disabled={busy} title="Exit drawing (Esc)">
          Cancel
        </button>
      </div>

      {rtp && detections && (
        <div className="draw-detections" aria-live="polite">
          {detections.items.map((d, i) => (
            <div
              key={i}
              className="draw-detection"
              style={{
                left: d.bbox.x1 / detections.scale,
                top: d.bbox.y1 / detections.scale,
                width: (d.bbox.x2 - d.bbox.x1) / detections.scale,
                height: (d.bbox.y2 - d.bbox.y1) / detections.scale,
              }}
            >
              <span className="draw-detection-label">
                {d.type} {Math.round(d.conf * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {!hasInput && !busy && (
        <div className="draw-hint hint-text">
          Sketch resistors, capacitors, inductors, sources and ground, join them with wires,
          or load an image of a circuit, then press Generate.
        </div>
      )}

      {error && <div className="draw-error result-box result-error">{error}</div>}

      {busy && (
        <div className="draw-busy">
          <span>Recognising circuit…</span>
        </div>
      )}
    </div>
  );
}
