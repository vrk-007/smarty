import type { JsonNetlist } from "../utils/loadNetlistJson";

/** Backend route that runs the circuitmodel YOLO pipeline on an image.
 *  Override with VITE_GENERATE_URL in a .env file. */
export const GENERATE_ENDPOINT =
  import.meta.env.VITE_GENERATE_URL ?? "http://localhost:8000/generate-circuit";

/** Send a drawn circuit (PNG data URL) to the model and get back a netlist
 *  in the same format as circuitmodel's netlist.json. */
export async function generateCircuitFromImage(
  imageDataUrl: string,
  title = "drawn-circuit"
): Promise<JsonNetlist> {
  let response: Response;
  try {
    response = await fetch(GENERATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageDataUrl, title }),
    });
  } catch {
    throw new Error(
      `Couldn't reach the backend at ${GENERATE_ENDPOINT}. Is the Python server running?`
    );
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `Backend returned ${response.status}`);
  }

  return (await response.json()) as JsonNetlist;
}

/** Detection-only route used by run-time processing (RTP) while drawing.
 *  Override with VITE_DETECT_URL in a .env file. */
export const DETECT_ENDPOINT =
  import.meta.env.VITE_DETECT_URL ?? GENERATE_ENDPOINT.replace(/generate-circuit$/, "detect-components");

export interface Detection {
  type: string;
  conf: number;
  /** Box in the pixels of the image that was sent. */
  bbox: { x1: number; y1: number; x2: number; y2: number };
}

/** Run component detection only (no wires, no OCR) on a drawing. */
export async function detectComponents(
  imageDataUrl: string,
  signal?: AbortSignal
): Promise<Detection[]> {
  const response = await fetch(DETECT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl }),
    signal,
  });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  const body = (await response.json()) as { detections: Detection[] };
  return body.detections ?? [];
}
