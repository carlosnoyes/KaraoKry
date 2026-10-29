// A 1.5-second canvas confetti burst over the whole screen. Never blocks taps.

const DURATION_MS = 1500;
const COLOR_TOKENS = ['--pink', '--cyan', '--violet', '--amber'];

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function confetti() {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const styles = getComputedStyle(document.documentElement);
  const colors = COLOR_TOKENS.map((token) => styles.getPropertyValue(token).trim() || '#ffffff');
  const count = reducedMotion() ? 30 : 120;
  const pieces = Array.from({ length: count }, () => ({
    x: width / 2 + (Math.random() - 0.5) * width * 0.3,
    y: height * 0.45,
    vx: (Math.random() - 0.5) * 900,
    vy: -400 - Math.random() * 700,
    size: 6 + Math.random() * 6,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 12,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  let last = start;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const elapsed = now - start;
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = elapsed > DURATION_MS - 400 ? Math.max(0, (DURATION_MS - elapsed) / 400) : 1;
    for (const p of pieces) {
      p.vy += 1400 * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (elapsed < DURATION_MS) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}
