// Live microphone waveform shown in the composer's input slot while recording. A row of thin
// vertical bars driven by the real audio level (AnalyserNode) — muted at rest, brightening toward
// the app's amber "active" accent as it picks up sound (louder = taller). Restrained: solid thin
// bars, no gradient/glow. A small muted caption beneath previews the recognised speech, kept to a
// single line (auto-scrolled to the latest words) so the composer height never jumps.

import { useEffect, useRef, type MutableRefObject } from "react";

const REST: [number, number, number] = [82, 82, 91]; //  #52525b (faint)
const HOT: [number, number, number] = [245, 158, 11]; // #f59e0b (run/active accent)

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function VoiceWaveform({
  analyserRef,
  active,
  transcript,
  height,
}: {
  analyserRef: MutableRefObject<AnalyserNode | null>;
  active: boolean;
  transcript: string;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const capRef = useRef<HTMLDivElement>(null);

  // Keep the caption scrolled to the end so the newest words stay visible.
  useEffect(() => {
    if (capRef.current) capRef.current.scrollLeft = capRef.current.scrollWidth;
  }, [transcript]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;

    const N = 44; // number of bars
    const GAP = 2;
    // Reusable buffer with a concrete ArrayBuffer (fftSize 128 → 64 bins).
    const bins = new Uint8Array(new ArrayBuffer(64));

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const analyser = analyserRef.current;
      const hasData = Boolean(analyser);
      if (analyser) analyser.getByteFrequencyData(bins);

      const barW = Math.max(1.5, (w - GAP * (N - 1)) / N);
      for (let i = 0; i < N; i++) {
        let v = 0;
        if (hasData) {
          // Speech energy sits in the lower ~60% of bins; spread those across the bars.
          const bin = Math.floor((i / N) * bins.length * 0.6);
          v = (bins[bin] ?? 0) / 255;
        }
        const level = Math.min(1, v * 1.35); // gentle boost so normal speech fills the space
        const bh = Math.max(2, level * h * 0.92); // floor so silence reads as a thin flat line
        const x = i * (barW + GAP);
        const y = (h - bh) / 2; // centred vertically
        g.fillStyle = `rgb(${lerp(REST[0], HOT[0], level)},${lerp(REST[1], HOT[1], level)},${lerp(REST[2], HOT[2], level)})`;
        g.fillRect(x, y, barW, bh);
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, analyserRef]);

  return (
    <div className="flex flex-col justify-center" style={{ height }}>
      <canvas ref={canvasRef} className="w-full" style={{ height: Math.max(22, height - 20) }} />
      <div
        ref={capRef}
        className="text-tiny text-muted whitespace-nowrap overflow-hidden mt-1"
        title={transcript}
      >
        {transcript || <span className="text-faint">Listening…</span>}
      </div>
    </div>
  );
}
