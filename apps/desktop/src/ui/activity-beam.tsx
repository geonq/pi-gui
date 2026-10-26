import { useEffect, useRef, useState, type ReactNode } from "react";
import { useActiveTheme } from "./active-theme";
import { subscribeMotion } from "./motion-clock";

/** Matches the beam's fade-out, so the canvas unmounts only once it is invisible. */
const FADE_OUT_MS = 500;
const LAP_SECONDS = 3.2;

type Preset = "composer" | "pill";
type Variant = "dark" | "light";
type Stop = readonly [offset: number, alpha: number];
/** A radial "spot": radii and centre (fractions of the box) and its grey level and alpha. */
type Spot = readonly [rx: number, ry: number, x: number, y: number, grey: number, alpha: number];

interface Look {
  readonly radius: number;
  readonly strokeOpacity: number;
  readonly glowOpacity: number;
  readonly bloomOpacity: number;
  readonly glowShadow: { readonly blur: number; readonly alpha: number };
  readonly bloomBlur: number;
  readonly bloomBrightness: number;
  readonly glowEdges: boolean;
  readonly glowWindow: readonly Stop[];
  readonly strokeSpots: readonly Spot[];
  readonly glowSpots: readonly Spot[];
}

// The values border-beam 1.4 generates for the app's two beams (mono, static colours); the composer
// carries the app's stroke/glow/bloom boosts (2.4, 1.6, 2) and the pill its strength of 0.5.
const WINDOW: readonly Stop[] = [
  [0, 0],
  [0.3, 0],
  [0.36, 0.1],
  [0.44, 0.35],
  [0.52, 1],
  [0.8, 1],
  [0.86, 0.35],
  [0.92, 0.1],
  [0.95, 0],
  [1, 0],
];
const ARC: Record<Variant, readonly Stop[]> = {
  dark: [
    [0, 0],
    [0.54, 0],
    [0.57, 0.1],
    [0.6, 0.3],
    [0.63, 0.6],
    [0.66, 0.75],
    [0.69, 0.6],
    [0.72, 0.3],
    [0.75, 0.1],
    [0.78, 0],
    [1, 0],
  ],
  light: [
    [0, 0],
    [0.54, 0],
    [0.57, 0.08],
    [0.6, 0.2],
    [0.63, 0.4],
    [0.66, 0.55],
    [0.69, 0.4],
    [0.72, 0.2],
    [0.75, 0.08],
    [0.78, 0],
    [1, 0],
  ],
};
const BLOOM_ARC: Record<Variant, readonly Stop[]> = {
  dark: [
    [0, 0],
    [0.58, 0],
    [0.62, 0.03],
    [0.65, 0.08],
    [0.67, 0.2],
    [0.69, 0.45],
    [0.7, 0.85],
    [0.705, 0.85],
    [0.715, 0.45],
    [0.73, 0.2],
    [0.75, 0.08],
    [0.78, 0.03],
    [0.82, 0],
  ],
  light: [
    [0, 0],
    [0.58, 0],
    [0.62, 0.02],
    [0.65, 0.08],
    [0.67, 0.2],
    [0.69, 0.4],
    [0.7, 0.6],
    [0.705, 0.6],
    [0.715, 0.4],
    [0.73, 0.2],
    [0.75, 0.08],
    [0.78, 0.02],
    [0.82, 0],
  ],
};
const COMPOSER_SPOTS: readonly Spot[] = [
  [70, 40, 0.33, -0.074, 180, 1],
  [60, 35, 0.12, -0.05, 140, 1],
  [40, 70, 0.021, 0.683, 160, 1],
  [20, 35, 0.021, 0.683, 130, 1],
  [180, 32, 0.744, 1, 170, 1],
  [85, 26, 0.55, 1, 150, 1],
  [74, 32, 0.939, 0, 190, 1],
  [26, 42, 1, 0.271, 145, 1],
  [52, 48, 1, 0.271, 165, 1],
];
const PILL_SPOTS: readonly Spot[] = [
  [9, 18, 0.02, 0.68, 160, 1],
  [4, 8, 0.02, 0.68, 140, 1],
  [59, 9, 0.72, -0.03, 180, 1],
  [42, 7, 0.74, 1, 150, 1],
  [10, 17, 1, 0.27, 170, 1],
  [10, 18, 1, 0.27, 155, 1],
  [5, 10, 1, 0.27, 145, 1],
  [11, 12, 1, 0.27, 165, 1],
];
const PILL_GLOW_ALPHA = [0.25, 0.22, 0.17, 0.17, 0.15, 0.2, 0.15, 0.15];

const LOOKS: Record<Preset, Record<Variant, Look>> = {
  composer: {
    dark: {
      radius: 18,
      strokeOpacity: 0.312,
      glowOpacity: 0.336,
      bloomOpacity: 0.24,
      glowShadow: { blur: 9, alpha: 0.27 },
      bloomBlur: 8,
      bloomBrightness: 1.3,
      glowEdges: true,
      glowWindow: WINDOW,
      strokeSpots: COMPOSER_SPOTS,
      glowSpots: COMPOSER_SPOTS.map(
        ([rx, ry, x, y, grey]) => [rx * 0.9, ry * 0.9, x, y, grey, 0.225] as const,
      ),
    },
    light: {
      radius: 18,
      strokeOpacity: 0.144,
      glowOpacity: 0.208,
      bloomOpacity: 0.34,
      glowShadow: { blur: 9, alpha: 0.14 },
      bloomBlur: 8,
      bloomBrightness: 1.3,
      glowEdges: true,
      glowWindow: WINDOW,
      strokeSpots: COMPOSER_SPOTS,
      glowSpots: COMPOSER_SPOTS.map(
        ([rx, ry, x, y, grey]) => [rx * 0.9, ry * 0.9, x, y, grey, 0.225] as const,
      ),
    },
  },
  pill: {
    dark: {
      radius: 999,
      strokeOpacity: 0.115,
      glowOpacity: 0.06,
      bloomOpacity: 0.095,
      glowShadow: { blur: 5, alpha: 0.3 },
      bloomBlur: 4.4,
      bloomBrightness: 0.8,
      glowEdges: false,
      glowWindow: [
        [0, 0],
        [0.22, 0],
        [0.28, 0.12],
        [0.36, 0.4],
        [0.46, 1],
        [0.82, 1],
        [0.88, 0.4],
        [0.94, 0.12],
        [0.97, 0],
        [1, 0],
      ],
      strokeSpots: PILL_SPOTS,
      glowSpots: PILL_SPOTS.map(
        ([rx, ry, x, y, grey], i) => [rx, ry, x, y, grey, PILL_GLOW_ALPHA[i] ?? 0.15] as const,
      ),
    },
    light: {
      radius: 999,
      strokeOpacity: 0.03,
      glowOpacity: 0.075,
      bloomOpacity: 0.04,
      glowShadow: { blur: 5, alpha: 0.14 },
      bloomBlur: 4.4,
      bloomBrightness: 0.8,
      glowEdges: false,
      glowWindow: [
        [0, 0],
        [0.22, 0],
        [0.28, 0.12],
        [0.36, 0.4],
        [0.46, 1],
        [0.82, 1],
        [0.88, 0.4],
        [0.94, 0.12],
        [0.97, 0],
        [1, 0],
      ],
      strokeSpots: PILL_SPOTS,
      glowSpots: PILL_SPOTS.map(
        ([rx, ry, x, y, grey], i) => [rx, ry, x, y, grey, PILL_GLOW_ALPHA[i] ?? 0.15] as const,
      ),
    },
  },
};

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function roundRect(ctx: Context2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** A conic gradient as CSS draws `conic-gradient(from <turn>…)`: 0 is up, turning clockwise. */
function conic(
  ctx: Context2D,
  turn: number,
  cx: number,
  cy: number,
  stops: readonly Stop[],
  rgb: string,
) {
  const gradient = ctx.createConicGradient(turn * Math.PI * 2 - Math.PI / 2, cx, cy);
  for (const [offset, alpha] of stops) gradient.addColorStop(offset, `rgba(${rgb}, ${alpha})`);
  return gradient;
}

function paintSpots(ctx: Context2D, spots: readonly Spot[], w: number, h: number): void {
  // CSS paints the first background on top, so the list is drawn from its end.
  for (const [rx, ry, x, y, grey, alpha] of [...spots].reverse()) {
    ctx.save();
    ctx.translate(x * w, y * h);
    ctx.scale(rx, ry);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, `rgba(${grey}, ${grey}, ${grey}, ${alpha})`);
    gradient.addColorStop(1, `rgba(${grey}, ${grey}, ${grey}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
}

/**
 * Draws the beam once per motion tick on one canvas. Everything that does not turn (the grey spots,
 * the inset glow, the edge fade, the 1px ring) is drawn once per size or theme; a frame only turns
 * three conic gradients and stacks three layers.
 */
class BeamPainter {
  private readonly ctx: CanvasRenderingContext2D;
  private layer = new OffscreenCanvas(1, 1);
  private strokePaint = new OffscreenCanvas(1, 1);
  private glowPaint = new OffscreenCanvas(1, 1);
  private width = 0;
  private height = 0;
  private scale = 1;

  private look: Look;
  private variant: Variant = "dark";
  private rgb = "255, 255, 255";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    look: Look,
    variant: Variant,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.look = look;
    this.setLook(look, variant);
  }

  setLook(look: Look, variant: Variant): void {
    this.look = look;
    this.variant = variant;
    this.rgb = variant === "dark" ? "255, 255, 255" : "0, 0, 0";
    this.prepare();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.scale = Math.min(2, window.devicePixelRatio || 1);
    for (const target of [this.canvas, this.layer, this.strokePaint, this.glowPaint]) {
      target.width = Math.max(1, Math.round(width * this.scale));
      target.height = Math.max(1, Math.round(height * this.scale));
    }
    this.prepare();
  }

  private prepare(): void {
    const { width: w, height: h, look } = this;
    if (!w || !h) return;
    const stroke = this.strokePaint.getContext("2d")!;
    stroke.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    stroke.clearRect(0, 0, w, h);
    paintSpots(stroke, look.strokeSpots, w, h);

    const glow = this.glowPaint.getContext("2d")!;
    glow.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    glow.clearRect(0, 0, w, h);
    glow.save();
    roundRect(glow, 0, 0, w, h, look.radius);
    glow.clip();
    paintSpots(glow, look.glowSpots, w, h);
    // box-shadow: inset 0 0 <blur> 1px — only the shadow of a shape drawn far off the canvas lands.
    const far = 100_000;
    glow.shadowColor = `rgba(${this.rgb}, ${look.glowShadow.alpha})`;
    glow.shadowBlur = look.glowShadow.blur * this.scale;
    glow.shadowOffsetX = far * this.scale;
    glow.beginPath();
    glow.rect(-far - 50, -50, w + 100, h + 100);
    glow.roundRect(
      -far + 1,
      1,
      w - 2,
      h - 2,
      Math.max(0, Math.min(look.radius - 1, (w - 2) / 2, (h - 2) / 2)),
    );
    glow.fillStyle = "#000";
    glow.fill("evenodd");
    glow.restore();
    if (look.glowEdges) {
      const edges = new OffscreenCanvas(this.glowPaint.width, this.glowPaint.height);
      const e = edges.getContext("2d")!;
      e.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const fade = 28;
      const vertical = e.createLinearGradient(0, 0, 0, h);
      vertical.addColorStop(0, "#fff");
      vertical.addColorStop(Math.min(0.5, fade / h), "rgba(255,255,255,0)");
      vertical.addColorStop(Math.max(0.5, 1 - fade / h), "rgba(255,255,255,0)");
      vertical.addColorStop(1, "#fff");
      e.fillStyle = vertical;
      e.fillRect(0, 0, w, h);
      const horizontal = e.createLinearGradient(0, 0, w, 0);
      horizontal.addColorStop(0, "#fff");
      horizontal.addColorStop(Math.min(0.5, fade / w), "rgba(255,255,255,0)");
      horizontal.addColorStop(Math.max(0.5, 1 - fade / w), "rgba(255,255,255,0)");
      horizontal.addColorStop(1, "#fff");
      e.fillStyle = horizontal;
      e.fillRect(0, 0, w, h);
      glow.setTransform(1, 0, 0, 1, 0, 0);
      glow.globalCompositeOperation = "destination-in";
      glow.drawImage(edges, 0, 0);
      glow.globalCompositeOperation = "source-over";
    }
  }

  /** The 1px frame (padding box minus content box) inside the beam's rounded corners. */
  private clipRing(ctx: Context2D): void {
    const { width: w, height: h, look } = this;
    roundRect(ctx, 0, 0, w, h, look.radius - 1);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(1, 1, w - 2, h - 2);
    ctx.clip("evenodd");
  }

  paint(seconds: number): void {
    const { width: w, height: h, look, rgb, ctx } = this;
    if (!w || !h) return;
    const turn = (seconds / LAP_SECONDS) % 1;
    const cx = w / 2;
    const cy = h / 2;
    const layer = this.layer.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Glow: the inset glow seen through its window.
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, this.layer.width, this.layer.height);
    layer.drawImage(this.glowPaint, 0, 0);
    layer.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    layer.globalCompositeOperation = "destination-in";
    layer.fillStyle = conic(layer, turn, cx, cy, look.glowWindow, "255, 255, 255");
    layer.fillRect(0, 0, w, h);
    ctx.globalAlpha = look.glowOpacity;
    ctx.drawImage(this.layer, 0, 0);

    // Stroke: the arc over the grey spots, seen through the window, on the 1px ring.
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, this.layer.width, this.layer.height);
    layer.save();
    layer.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.clipRing(layer);
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.drawImage(this.strokePaint, 0, 0);
    layer.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    layer.fillStyle = conic(layer, turn, cx, cy, ARC[this.variant], rgb);
    layer.fillRect(0, 0, w, h);
    layer.globalCompositeOperation = "destination-in";
    layer.fillStyle = conic(layer, turn, cx, cy, WINDOW, "255, 255, 255");
    layer.fillRect(0, 0, w, h);
    layer.restore();
    ctx.globalAlpha = look.strokeOpacity;
    ctx.drawImage(this.layer, 0, 0);

    // Bloom: the blurred arc, kept to the ring.
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, this.layer.width, this.layer.height);
    layer.save();
    layer.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.clipRing(layer);
    layer.filter = `blur(${look.bloomBlur * this.scale}px) brightness(${look.bloomBrightness})`;
    roundRect(layer, 0, 0, w, h, look.radius - 1);
    layer.fillStyle = conic(layer, turn, cx, cy, BLOOM_ARC[this.variant], rgb);
    layer.fill();
    layer.filter = "none";
    layer.restore();
    ctx.globalAlpha = look.bloomOpacity;
    ctx.drawImage(this.layer, 0, 0);
    ctx.globalAlpha = 1;
  }
}

interface ActivityBeamProps {
  readonly active: boolean;
  /** "composer" is the card-sized beam around the input; "pill" is the small one on the working badge. */
  readonly preset: Preset;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * The libraries.dev border beam (mono, static colours) drawn on one canvas from the shared motion
 * clock. The package spins a registered `--beam-angle` through conic gradients, masks, clip paths
 * and a blur, which restyles and repaints on the main thread at the display rate; this draws the same
 * gradients at the motion clock's 60+ fps with one texture update per frame.
 */
export function ActivityBeam({ active, preset, className, children }: ActivityBeamProps) {
  const { variant } = useActiveTheme();
  const [fading, setFading] = useState(false);
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    setFading(!active);
  }
  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => setFading(false), FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [fading]);

  const shown = active || fading;
  return (
    <div className={`activity-beam${className ? ` ${className}` : ""}`}>
      {children}
      {shown ? <BeamCanvas fading={fading} preset={preset} variant={variant} /> : null}
    </div>
  );
}

function BeamCanvas({
  preset,
  variant,
  fading,
}: {
  readonly preset: Preset;
  readonly variant: Variant;
  readonly fading: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const painter = useRef<BeamPainter | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const beam = new BeamPainter(canvas, LOOKS[preset][variant], variant);
    painter.current = beam;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      beam.resize(entry.contentRect.width, entry.contentRect.height);
      beam.paint(performance.now() / 1000);
    });
    observer.observe(canvas);
    const unsubscribe = subscribeMotion((seconds) => beam.paint(seconds));
    return () => {
      unsubscribe();
      observer.disconnect();
      painter.current = null;
    };
  }, [preset]);

  useEffect(() => {
    painter.current?.setLook(LOOKS[preset][variant], variant);
  }, [preset, variant]);

  return (
    <canvas
      aria-hidden="true"
      className={`activity-beam__canvas${fading ? " activity-beam__canvas--fading" : ""}`}
      ref={ref}
    />
  );
}
