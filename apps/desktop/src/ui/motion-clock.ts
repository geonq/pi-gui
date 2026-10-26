// One display-synced clock for every activity animation (orbs, beams, spinners, shimmers).
//
// Each animation that advances on its own makes the browser produce a frame at the display rate
// (144 per second on a 144 Hz screen), and loops out of step with each other add frames between.
// Everything here advances on the same tick instead: on every whole number of display frames that
// keeps motion at 60 fps or more (each frame at 60 Hz, every second one at 120 or 144 Hz), evenly
// paced. Infinite CSS animations (spinners, shimmers, pulses) are held on this tick as well, so they
// stay smooth without asking for frames of their own.

const MIN_FPS = 60;

type Painter = (seconds: number) => void;

const painters = new Set<Painter>();
let request = 0;
let lastFrame = 0;
let frameMs = 1000 / MIN_FPS;
let tick = 0;

function cssLoops(): CSSAnimation[] {
  return document
    .getAnimations()
    .filter(
      (animation): animation is CSSAnimation =>
        animation instanceof CSSAnimation && animation.effect?.getTiming().iterations === Infinity,
    );
}

function frame(now: number): void {
  const delta = now - lastFrame;
  lastFrame = now;
  // A smoothed display frame time; gaps from a hidden or busy window are ignored.
  if (delta > 3 && delta < 50) frameMs += (delta - frameMs) * 0.1;
  const every = Math.max(1, Math.floor(1000 / MIN_FPS / frameMs));
  const loops = cssLoops();
  if (++tick % every === 0) {
    const seconds = now / 1000;
    for (const paint of painters) paint(seconds);
    for (const loop of loops) {
      if (loop.playState !== "paused") loop.pause();
      loop.currentTime = now;
    }
  }
  request = painters.size > 0 || loops.length > 0 ? window.requestAnimationFrame(frame) : 0;
}

function ensureRunning(): void {
  if (!request) request = window.requestAnimationFrame(frame);
}

/** Calls `paint` with the clock time in seconds on every motion tick until unsubscribed. */
export function subscribeMotion(paint: Painter): () => void {
  painters.add(paint);
  ensureRunning();
  return () => {
    painters.delete(paint);
  };
}

// A spinner or shimmer that starts later wakes the clock; the clock sleeps again once none is left.
if (typeof document !== "undefined") {
  document.addEventListener("animationstart", ensureRunning, true);
}
