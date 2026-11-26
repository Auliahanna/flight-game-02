// Skylark Run — an original tiny flight game.
// Take off from a grass strip, thread a course of sky rings over patchwork
// farmland, then bring the little Skylark home and land it gently.
// Plain canvas 2D, no libraries, no network. Deterministic under ?shot=.

const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
const W = 1280, H = 800;

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');           // start | play | land | end (screenshot poses)
const SEED = Number(params.get('seed') || 7);

// Small seeded RNG so courses and scenery are stable between runs.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rand = rng(SEED * 7919 + 13);

// ---- Course definition -------------------------------------------------
// Each ring sits at a distance along the track (metres), a lateral offset
// (metres, - = left) and an altitude (feet). The runway waits past the last.
function buildCourse(level) {
  const r = rng(SEED * 31 + level * 101);
  const rings = [];
  const count = 6 + level * 2;
  let dist = 1400;
  for (let i = 0; i < count; i++) {
    rings.push({
      dist,
      lat: Math.round((r() * 2 - 1) * (90 + level * 30)),
      alt: Math.round(500 + r() * (700 + level * 250)),
      radius: 95 - level * 8,
      done: false, hit: false,
    });
    dist += 750 + Math.round(r() * 350);
  }
  return { rings, runwayDist: dist + 1600, wind: level * 2.2 };
}

// ---- Game state --------------------------------------------------------
const S = {
  mode: 'title',        // title | roll | fly | crashed | landed | paused
  level: 1,
  course: null,
  // flight model
  speed: 0,             // knots
  throttle: 0,          // 0..1
  pitch: 0,             // degrees, + nose up
  bank: 0,              // degrees, + right bank
  heading: 90,          // degrees
  alt: 0,               // feet
  vspeed: 0,            // feet per minute
  dist: 0,              // metres along track
  lat: 0,               // metres lateral
  onGround: true,
  stall: false,
  score: 0, ringsHit: 0, time: 0,
  message: '', msgTimer: 0,
  grade: '',
  particles: [],
  clouds: [],
  gust: 0,
};

function reset(level) {
  S.level = level;
  S.course = buildCourse(level);
  S.mode = 'roll';
  S.speed = 0; S.throttle = 0; S.pitch = 0; S.bank = 0;
  S.heading = 90; S.alt = 0; S.vspeed = 0;
  S.dist = 0; S.lat = 0; S.onGround = true; S.stall = false;
  S.score = 0; S.ringsHit = 0; S.time = 0; S.grade = '';
  S.message = 'Throttle up (Shift), then pull up at 55 kt';
  S.msgTimer = 6;
  S.particles = [];
  const r = rng(SEED * 17 + level);
  S.clouds = Array.from({ length: 26 }, () => ({
    d: r() * 9000, lat: (r() * 2 - 1) * 900, alt: 900 + r() * 1600, s: 60 + r() * 130,
  }));
}

// ---- Input -------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyP' && (S.mode === 'fly' || S.mode === 'roll')) S.mode = 'paused';
  else if (e.code === 'KeyP' && S.mode === 'paused') S.mode = S.onGround ? 'roll' : 'fly';
  if (e.code === 'KeyR') reset(S.level);
  if (e.code === 'Enter' || e.code === 'Space') {
    if (S.mode === 'title') reset(1);
    else if (S.mode === 'landed') reset(Math.min(3, S.level + 1));
    else if (S.mode === 'crashed') reset(S.level);
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));

let mouseSteer = null;
cv.addEventListener('pointerdown', (e) => { mouseSteer = { x: e.offsetX, y: e.offsetY }; });
cv.addEventListener('pointermove', (e) => { if (mouseSteer) mouseSteer = { x: e.offsetX, y: e.offsetY }; });
addEventListener('pointerup', () => { mouseSteer = null; });

function readControls(dt) {
  const up = keys.has('KeyW') || keys.has('ArrowUp');
  const down = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) S.throttle = Math.min(1, S.throttle + dt * 0.7);
  if (keys.has('ControlLeft') || keys.has('ControlRight')) S.throttle = Math.max(0, S.throttle - dt * 0.7);
  if (keys.has('Space')) S.throttle = Math.max(0, S.throttle - dt * 1.6);
  if (up) S.pitch = Math.min(20, S.pitch + dt * 26);
  if (down) S.pitch = Math.max(-20, S.pitch - dt * 26);
  if (!up && !down) S.pitch += (0 - S.pitch) * dt * 0.8;
  if (left) S.bank = Math.max(-48, S.bank - dt * 90);
  if (right) S.bank = Math.min(48, S.bank + dt * 90);
  if (!left && !right) S.bank += (0 - S.bank) * dt * 1.6;
  if (mouseSteer) {
    const r = cv.getBoundingClientRect();
    const nx = (mouseSteer.x / r.width - 0.5) * 2;
    const ny = (mouseSteer.y / r.height - 0.5) * 2;
    S.bank += (nx * 42 - S.bank) * dt * 4;
    S.pitch += (-ny * 16 - S.pitch) * dt * 4;
  }
}

// ---- Sound (synthesised, starts on first key press) ---------------------
let audioCtx = null;
function beep(freq, dur, type = 'sine', gain = 0.08) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* sound is optional */ }
}
addEventListener('keydown', () => { if (!SHOT) beep(0, 0.01, 'sine', 0.0001); }, { once: true });

// ---- Flight model ------------------------------------------------------
function step(dt) {
  if (S.mode !== 'roll' && S.mode !== 'fly') return;
  readControls(dt);
  S.time += dt;
  if (S.msgTimer > 0) S.msgTimer -= dt;

  // Engine and drag: thrust chases a throttle-set speed, pitch trades speed.
  const target = S.throttle * 128;
  S.speed += (target - S.speed) * dt * 0.55;
  S.speed -= S.pitch * dt * 1.15;
  S.speed = Math.max(0, Math.min(165, S.speed));

  const ms = S.speed * 0.514; // knots -> m/s
  S.dist += ms * dt;

  if (S.onGround) {
    S.alt = 0; S.vspeed = 0;
    S.lat += Math.sin(S.bank * Math.PI / 180) * ms * dt * 0.25;
    if (S.speed >= 55 && S.pitch > 4) {
      S.onGround = false; S.mode = 'fly';
      S.message = 'Airborne! Thread the rings.'; S.msgTimer = 4;
    }
    if (S.dist > 900 && S.onGround) return crash('Ran out of strip');
    return;
  }

  // Airborne: bank turns the nose, pitch climbs or sinks, slow flight stalls.
  S.heading = (S.heading + S.bank * dt * 0.85 + 360) % 360;
  S.lat += Math.sin(S.bank * Math.PI / 180) * ms * dt * 1.15;
  S.gust = Math.sin(S.time * 0.7 + S.dist * 0.002) * S.course.wind;
  S.lat += S.gust * dt * 2.2;

  S.stall = S.speed < 48;
  const climb = Math.sin(S.pitch * Math.PI / 180) * ms * 3.28; // ft/s
  S.vspeed = (climb - (S.stall ? 14 : 0)) * 60;
  S.alt += (climb - (S.stall ? 14 : 0)) * dt;
  if (S.stall) S.pitch = Math.max(-14, S.pitch - dt * 22);

  // Ring gates.
  for (const ring of S.course.rings) {
    if (ring.done) continue;
    if (S.dist >= ring.dist) {
      ring.done = true;
      const dLat = Math.abs(S.lat - ring.lat);
      const dAlt = Math.abs(S.alt - ring.alt);
      if (dLat < ring.radius && dAlt < ring.radius * 1.6) {
        ring.hit = true; S.ringsHit++;
        S.score += 250;
        S.message = `Ring ${S.ringsHit} threaded! +250`; S.msgTimer = 3;
        burst(); beep(880, 0.18); beep(1320, 0.22, 'sine', 0.05);
      } else {
        S.message = 'Ring missed'; S.msgTimer = 2.5;
      }
    }
    break;
  }

  // Touchdown judgement near the home runway.
  if (S.alt <= 0) {
    const past = S.dist - S.course.runwayDist;
    const onStrip = past > -150 && past < 700 && Math.abs(S.lat) < 60;
    if (onStrip && S.vspeed > -650 && S.speed < 95) {
      S.alt = 0; S.onGround = true; S.mode = 'landed';
      const gentle = S.vspeed > -260 && S.speed < 78;
      S.grade = gentle && S.ringsHit === S.course.rings.length ? 'S' : gentle ? 'A' : 'B';
      S.score += gentle ? 500 : 250;
      S.message = 'Touchdown!';
    } else if (onStrip) {
      return crash('Hard landing');
    } else {
      return crash('Crashed into the fields');
    }
  }
}

function crash(why) {
  S.mode = 'crashed';
  S.message = why;
  beep(110, 0.5, 'sawtooth', 0.12);
}

function burst() {
  for (let i = 0; i < 26; i++) {
    S.particles.push({
      x: W / 2 + (rand() - 0.5) * 160, y: H / 2 - 40 + (rand() - 0.5) * 120,
      vx: (rand() - 0.5) * 260, vy: (rand() - 0.5) * 260,
      life: 0.9, hue: 40 + rand() * 30,
    });
  }
}

// ---- Rendering ---------------------------------------------------------
function project(dAhead, latOff, altFt) {
  // Simple chase-camera projection: returns screen x/y and scale.
  const horizonY = H * 0.46 + S.pitch * 4.2;
  const z = Math.max(12, dAhead);
  const scale = 900 / z;
  const x = W / 2 + (latOff - S.lat) * scale * 2.6;
  const y = horizonY + (S.alt - altFt) * scale * 0.55 + z * 0.012;
  return { x, y, scale };
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.6);
  g.addColorStop(0, '#3f7fc4'); g.addColorStop(0.7, '#79b5e0'); g.addColorStop(1, '#cfe8f7');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // sun
  ctx.fillStyle = '#fff3b0';
  ctx.beginPath(); ctx.arc(W * 0.8, 90, 34, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,243,176,0.35)';
  ctx.beginPath(); ctx.arc(W * 0.8, 90, 58, 0, Math.PI * 2); ctx.fill();
}

function drawTerrain() {
  const horizonY = H * 0.46 + S.pitch * 4.2;
  ctx.save();
  ctx.translate(W / 2, horizonY);
  ctx.rotate(-S.bank * Math.PI / 360);
  ctx.translate(-W / 2, -horizonY);
  // ground base
  ctx.fillStyle = '#6aa84f';
  ctx.fillRect(-200, horizonY, W + 400, H - horizonY + 200);
  // patchwork fields scrolling toward the viewer
  const r = rng(SEED * 3);
  const fields = [];
  for (let i = 0; i < 60; i++) fields.push({ d: i * 170 + r() * 60, lat: (r() * 2 - 1) * 1400, w: 240 + r() * 380, c: ['#7cb85c', '#5d9c46', '#a9c46b', '#c9b458', '#8fae4e'][i % 5] });
  for (const f of fields) {
    const ahead = f.d - (S.dist % 10200);
    if (ahead < -200 || ahead > 4200) continue;
    const p = project(ahead + 500, f.lat, 0);
    const wdt = f.w * p.scale * 2.2, hgt = 90 * p.scale * 2.2;
    ctx.fillStyle = f.c;
    ctx.beginPath();
    ctx.moveTo(p.x - wdt / 2, p.y); ctx.lineTo(p.x + wdt / 2, p.y);
    ctx.lineTo(p.x + wdt * 0.8, p.y + hgt); ctx.lineTo(p.x - wdt * 0.8, p.y + hgt);
    ctx.closePath(); ctx.fill();
  }
  // river ribbon
  ctx.strokeStyle = '#4d90c2'; ctx.lineWidth = 10; ctx.beginPath();
  for (let d = 300; d < 4000; d += 160) {
    const p = project(d, Math.sin((d + S.dist) * 0.0016) * 420 - 260, 0);
    if (d === 300) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  // distant hills
  ctx.fillStyle = '#5b7d68';
  ctx.beginPath(); ctx.moveTo(-100, horizonY);
  for (let x = -100; x <= W + 100; x += 90) ctx.lineTo(x, horizonY - 26 - Math.abs(Math.sin(x * 0.011 + 2)) * 54);
  ctx.lineTo(W + 100, horizonY); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawRunway(dist, label) {
  const ahead = dist - S.dist;
  if (ahead < -800 || ahead > 5200) return;
  const near = project(ahead, 0, 0), far = project(ahead + 700, 0, 0);
  const nw = 46 * near.scale * 2.4, fw = 46 * far.scale * 2.4;
  ctx.fillStyle = '#4a4f55';
  ctx.beginPath();
  ctx.moveTo(near.x - nw, near.y); ctx.lineTo(near.x + nw, near.y);
  ctx.lineTo(far.x + fw, far.y); ctx.lineTo(far.x - fw, far.y);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#f5f5f5'; ctx.lineWidth = Math.max(1, near.scale * 2);
  ctx.beginPath(); ctx.moveTo(near.x, near.y); ctx.lineTo(far.x, far.y); ctx.stroke();
  // threshold stripes at the near end
  ctx.fillStyle = '#f5f5f5';
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    ctx.fillRect(near.x + i * nw * 0.36 - nw * 0.07, near.y - Math.max(2, near.scale * 5), nw * 0.14, Math.max(2, near.scale * 5));
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.max(11, near.scale * 26)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(label, far.x, far.y - 8);
}

function drawRings() {
  if (!S.course) return;
  for (const ring of S.course.rings) {
    if (ring.done) continue;
    const ahead = ring.dist - S.dist;
    if (ahead < 0 || ahead > 4200) continue;
    const p = project(ahead, ring.lat, ring.alt);
    const rad = ring.radius * p.scale * 1.02;
    const isNext = S.course.rings.find((x) => !x.done) === ring;
    ctx.strokeStyle = isNext ? '#ffb703' : 'rgba(255,183,3,0.55)';
    ctx.lineWidth = Math.max(2, rad * 0.14);
    ctx.beginPath(); ctx.ellipse(p.x, p.y, rad, rad * 0.82, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(1, rad * 0.05);
    ctx.beginPath(); ctx.ellipse(p.x, p.y, rad * 0.86, rad * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
    if (isNext) {
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(ahead)} m`, p.x, p.y - rad - 8);
    }
  }
}

function drawClouds() {
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  for (const c of S.clouds) {
    const ahead = ((c.d - S.dist) % 9000 + 9000) % 9000;
    if (ahead > 4200) continue;
    const p = project(ahead + 200, c.lat, c.alt);
    const s = c.s * p.scale * 2.4;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, s, s * 0.34, 0, 0, Math.PI * 2);
    ctx.ellipse(p.x - s * 0.5, p.y + s * 0.08, s * 0.6, s * 0.26, 0, 0, Math.PI * 2);
    ctx.ellipse(p.x + s * 0.5, p.y + s * 0.08, s * 0.62, s * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPlane(t) {
  const cx = W / 2, cy = H * 0.66;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(S.bank * Math.PI / 180);
  // contrails
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(-150, 6); ctx.quadraticCurveTo(-190, 60, -215, 130); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(150, 6); ctx.quadraticCurveTo(190, 60, 215, 130); ctx.stroke();
  // wings
  ctx.fillStyle = '#d64541';
  ctx.beginPath();
  ctx.moveTo(-190, 4); ctx.lineTo(-40, -8); ctx.lineTo(40, -8); ctx.lineTo(190, 4);
  ctx.lineTo(168, 20); ctx.lineTo(-168, 20); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f4f1de';
  ctx.fillRect(-190, 4, 26, 12); ctx.fillRect(164, 4, 26, 12);
  // tail
  ctx.fillStyle = '#d64541';
  ctx.beginPath(); ctx.moveTo(-58, 34); ctx.lineTo(58, 34); ctx.lineTo(40, 46); ctx.lineTo(-40, 46); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -2); ctx.lineTo(14, 36); ctx.lineTo(-14, 36); ctx.closePath(); ctx.fill();
  // fuselage + canopy
  ctx.fillStyle = '#f4f1de';
  ctx.beginPath(); ctx.ellipse(0, 8, 26, 44, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a6f97';
  ctx.beginPath(); ctx.ellipse(0, -8, 15, 22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.ellipse(-5, -14, 5, 9, -0.4, 0, Math.PI * 2); ctx.fill();
  // propeller blur
  ctx.fillStyle = 'rgba(40,40,40,0.35)';
  ctx.beginPath(); ctx.ellipse(0, -38, 46, 7, Math.sin(t * 40) * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function panel(x, y, w, h, title) {
  ctx.fillStyle = 'rgba(10,22,34,0.82)';
  ctx.strokeStyle = '#ffb703'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffd166'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(title, x + w / 2, y + 15);
}

function drawHUD() {
  // guide arrow toward the next ring when it is off-centre
  if (S.course && S.mode === 'fly') {
    const next = S.course.rings.find((x) => !x.done);
    if (next) {
      const p = project(next.dist - S.dist, next.lat, next.alt);
      const dx = p.x - W / 2, dy = p.y - H * 0.5;
      if (Math.abs(dx) > 120 || Math.abs(dy) > 110) {
        const ang = Math.atan2(dy, dx);
        const ax = W / 2 + Math.cos(ang) * 120, ay = H * 0.5 + Math.sin(ang) * 96;
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang);
        ctx.fillStyle = '#ffb703';
        ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -9); ctx.lineTo(-10, 9); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
  }
  // compass strip
  ctx.fillStyle = 'rgba(10,22,34,0.75)'; ctx.fillRect(W / 2 - 210, 10, 420, 34);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
  for (let d = -60; d <= 60; d += 15) {
    const hdg = ((Math.round(S.heading) + d) % 360 + 360) % 360;
    const label = hdg === 0 ? 'N' : hdg === 90 ? 'E' : hdg === 180 ? 'S' : hdg === 270 ? 'W' : String(hdg);
    ctx.fillText(label, W / 2 + d * 3.2, 32);
  }
  ctx.fillStyle = '#ffb703';
  ctx.beginPath(); ctx.moveTo(W / 2 - 6, 46); ctx.lineTo(W / 2 + 6, 46); ctx.lineTo(W / 2, 56); ctx.closePath(); ctx.fill();

  panel(16, 120, 108, 210, 'SPEED KT');
  ctx.fillStyle = '#7bf1a8'; ctx.font = 'bold 34px monospace';
  ctx.fillText(String(Math.round(S.speed)), 70, 180);
  ctx.fillStyle = S.stall ? '#ff5964' : '#264653';
  ctx.beginPath(); ctx.roundRect(30, 196, 80, 26, 5); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 13px sans-serif';
  ctx.fillText(S.stall ? 'STALL' : 'STALL', 70, 214);
  ctx.fillStyle = '#ffd166'; ctx.font = '12px sans-serif';
  ctx.fillText(`THR ${Math.round(S.throttle * 100)}%`, 70, 248);
  ctx.fillStyle = '#264653'; ctx.fillRect(30, 258, 80, 10);
  ctx.fillStyle = '#ffb703'; ctx.fillRect(30, 258, 80 * S.throttle, 10);
  ctx.fillStyle = '#ffffff'; ctx.font = '12px sans-serif';
  ctx.fillText(`HDG ${String(Math.round(S.heading)).padStart(3, '0')}°`, 70, 296);

  panel(W - 124, 120, 108, 210, 'ALT FT');
  ctx.fillStyle = '#7bf1a8'; ctx.font = 'bold 30px monospace';
  ctx.fillText(String(Math.max(0, Math.round(S.alt))), W - 70, 180);
  ctx.fillStyle = '#ffffff'; ctx.font = '12px sans-serif';
  ctx.fillText('V/S FPM', W - 70, 214);
  ctx.fillStyle = S.vspeed < -600 ? '#ff5964' : '#7bf1a8'; ctx.font = 'bold 19px monospace';
  ctx.fillText(String(Math.round(S.vspeed)), W - 70, 240);
  ctx.fillStyle = '#ffd166'; ctx.font = '12px sans-serif';
  ctx.fillText(`RINGS ${S.ringsHit}/${S.course ? S.course.rings.length : 0}`, W - 70, 272);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`SCORE ${S.score}`, W - 70, 296);

  // artificial horizon
  const hx = W / 2, hy = H - 62;
  ctx.save();
  ctx.beginPath(); ctx.arc(hx, hy, 42, 0, Math.PI * 2); ctx.clip();
  ctx.translate(hx, hy); ctx.rotate(-S.bank * Math.PI / 180); ctx.translate(0, S.pitch * 1.6);
  ctx.fillStyle = '#3f7fc4'; ctx.fillRect(-60, -70, 120, 70);
  ctx.fillStyle = '#8a6d3b'; ctx.fillRect(-60, 0, 120, 70);
  ctx.restore();
  ctx.strokeStyle = '#ffb703'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(hx, hy, 42, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(hx - 22, hy); ctx.lineTo(hx - 6, hy); ctx.moveTo(hx + 6, hy); ctx.lineTo(hx + 22, hy); ctx.stroke();

  if (S.msgTimer > 0 && S.message) {
    ctx.fillStyle = 'rgba(10,22,34,0.78)';
    ctx.beginPath(); ctx.roundRect(W / 2 - 260, 64, 520, 36, 8); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 17px sans-serif';
    ctx.fillText(S.message, W / 2, 88);
  }
}

function overlay(title, lines) {
  ctx.fillStyle = 'rgba(8,18,30,0.72)'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffd166'; ctx.font = 'bold 54px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, H * 0.34);
  ctx.fillStyle = '#ffffff'; ctx.font = '19px sans-serif';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, H * 0.34 + 44 + i * 28));
}

function drawParticles(dt) {
  for (const p of S.particles) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
    ctx.fillStyle = `hsla(${p.hue}, 95%, 60%, ${Math.max(0, p.life)})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  }
  S.particles = S.particles.filter((p) => p.life > 0);
}

function render(t, dt) {
  drawSky();
  drawTerrain();
  if (S.course) {
    drawRunway(S.course.runwayDist, 'HOME');
    drawRunway(-300, 'START');
  }
  drawRings();
  drawClouds();
  if (S.mode !== 'crashed') drawPlane(t);
  drawParticles(dt);
  drawHUD();
  if (S.mode === 'title') {
    overlay('SKYLARK RUN', [
      'Take off, thread every sky ring, then land gently at HOME.',
      'W/S pitch · A/D bank · Shift/Ctrl throttle · Space brake',
      'Watch your speed: below 48 kt the Skylark stalls.',
      '',
      'Press Enter to fly',
    ]);
  } else if (S.mode === 'crashed') {
    overlay('CRASHED', [S.message, `Rings ${S.ringsHit} · Score ${S.score}`, '', 'Press Enter to try again']);
  } else if (S.mode === 'landed') {
    overlay(`LANDED — GRADE ${S.grade}`, [
      `Rings ${S.ringsHit}/${S.course.rings.length} · Score ${S.score} · Time ${S.time.toFixed(1)}s`,
      S.level < 3 ? 'Press Enter for the next course' : 'You cleared every course. Press Enter to fly again',
    ]);
  } else if (S.mode === 'paused') {
    overlay('PAUSED', ['Press P to resume']);
  }
}

// ---- Screenshot poses (deterministic, unedited renders of real states) --
function poseShot() {
  reset(1);
  if (SHOT === 'start') {
    S.mode = 'roll'; S.speed = 42; S.throttle = 0.85; S.pitch = 3; S.dist = 260;
    S.message = 'Throttle up (Shift), then pull up at 55 kt'; S.msgTimer = 9;
  } else if (SHOT === 'play') {
    S.mode = 'fly'; S.onGround = false;
    const ring = S.course.rings[1];
    S.dist = ring.dist - 620; S.lat = ring.lat - 40; S.alt = ring.alt + 30;
    S.speed = 96; S.throttle = 0.72; S.pitch = 4; S.bank = 12; S.heading = 96;
    S.vspeed = 320; S.ringsHit = 1; S.score = 250; S.course.rings[0].done = true; S.course.rings[0].hit = true;
    S.message = 'Ring 1 threaded! +250'; S.msgTimer = 9;
  } else if (SHOT === 'land') {
    S.mode = 'fly'; S.onGround = false;
    S.course.rings.forEach((r) => { r.done = true; r.hit = true; });
    S.ringsHit = S.course.rings.length; S.score = 1750;
    S.dist = S.course.runwayDist - 780; S.lat = 18; S.alt = 240;
    S.speed = 68; S.throttle = 0.3; S.pitch = -4; S.bank = -5; S.heading = 88; S.vspeed = -310;
    S.message = 'Final approach — keep her gentle'; S.msgTimer = 9;
  } else if (SHOT === 'end') {
    S.mode = 'landed'; S.onGround = true; S.grade = 'S'; S.score = 2250;
    S.ringsHit = S.course.rings.length; S.time = 96.4;
    S.dist = S.course.runwayDist + 320; S.speed = 12; S.throttle = 0.05;
  }
}

// ---- Main loop ---------------------------------------------------------
if (SHOT) poseShot(); else reset(1), S.mode = 'title';

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!SHOT) step(dt);
  render(now / 1000, SHOT ? 0 : dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
