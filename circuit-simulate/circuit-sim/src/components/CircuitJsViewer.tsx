/**
 * CircuitJsViewer.tsx
 *
 * Embeds the Falstad CircuitJS simulator in an iframe, fed by the current
 * loaded netlist.  The circuit text is generated client-side from the raw
 * JsonNetlist and URL-encoded into the Falstad embed URL.
 */

import { useMemo } from "react";
import { buildFalstadUrl, buildCircuitText } from "../utils/buildCircuitJs";
import type { JsonNetlist } from "../utils/loadNetlistJson";

interface Props {
  netlistJson: JsonNetlist | null;
}

export function CircuitJsViewer({ netlistJson }: Props) {
  const url = useMemo(() => {
    if (!netlistJson) return null;
    return buildFalstadUrl(netlistJson);
  }, [netlistJson]);

  const circuitText = useMemo(() => {
    if (!netlistJson) return null;
    return buildCircuitText(netlistJson);
  }, [netlistJson]);

  // ── No netlist loaded ────────────────────────────────────────────────────
  if (!netlistJson || !url) {
    return (
      <div className="cjs-placeholder">
        <div className="cjs-placeholder-inner">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden>
            <circle cx="28" cy="28" r="27" stroke="var(--border)" strokeWidth="1.5" />
            <path d="M18 28h6M32 28h6M24 22l4 6-4 6" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="cjs-placeholder-title">No netlist loaded</p>
          <p className="cjs-placeholder-hint">Load a <code>netlist.json</code> file using the toolbar, then switch to CircuitJS view to see the interactive schematic.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="cjs-viewer">
      {/* Info bar ─────────────────────────────────────────────────────── */}
      <div className="cjs-infobar">
        <span className="cjs-infobar-label">
          CircuitJS · <span className="cjs-infobar-name">{netlistJson.title ?? "circuit"}</span>
        </span>
        <div className="cjs-infobar-actions">
          <button
            className="btn btn-xs"
            title="Copy CircuitJS text to clipboard"
            onClick={() => navigator.clipboard.writeText(circuitText ?? "")}
          >
            Copy text
          </button>
          <a
            className="btn btn-xs"
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open in Falstad full page"
          >
            Open full
          </a>
        </div>
      </div>

      {/* Iframe ─────────────────────────────────────────────────────────── */}
      <iframe
        key={url}                          // re-mount on URL change
        src={url}
        title="CircuitJS schematic"
        className="cjs-iframe"
        allow="fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </div>
  );
}
