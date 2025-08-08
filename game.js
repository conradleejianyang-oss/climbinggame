// game.js
/* Mountain Climber — Vanilla JS + Canvas
   -----------------------------------------------------------
   Art pipeline
   - The game consumes a 5-row × 24-col sprite sheet.
   - Rows: 0 idle-hang, 1 reach-left, 2 reach-right, 3 slip, 4 fall
   - Animate at 24 fps (24 frames per row/clip).

   Use your own art (RECOMMENDED FOR PRODUCTION):
   1) Place files in your repo (e.g. assets/climber.png and assets/climber.json).
   2) The JSON manifest must map:
      {
        "frameSize": 512,
        "rows": 5,
        "cols": 24,
        "clips": {
          "idle": { "row": 0, "length": 24, "loop": true },
          "reachL": { "row": 1, "length": 24, "loop": false },
          "reachR": { "row": 2, "length": 24, "loop": false },
          "slip": { "row": 3, "length": 24, "loop": false },
          "fall": { "row": 4, "length": 24, "loop": false }
        }
      }
   3) Before loading the game, set:
      window.CLIMBER_SPRITE_URL = 'assets/climber.png';
      window.CLIMBER_MANIFEST_URL = 'assets/climber.json';

   Placeholder:
   - If URLs above are not provided, a flat-vector sheet is generated at load.
   - To keep memory reasonable for mobile, placeholder defaults to 256px frames.
     Change PLACEHOLDER_FRAME to 512 to match production assets if desired.
   -----------------------------------------------------------
*/

(() => {
  'use strict';

  // ----------------------------
  // Config
  // ----------------------------
  const CONFIG = {
    // Canvas virtual reference size; canvas scales to screen density
    viewWidth: 900,
    viewHeight: 1600,

    // Gameplay
    timeDrainSeconds: 3.0,       // full drain duration
    timeOnSuccess: 0.9,          // seconds added per correct move
    timeOnSuccessMax: 3.0,       // cap
    worldScrollBase: 110,        // px/s background scroll
    worldScrollBurst: 220,       // brief burst on successful grab
    worldScrollBurstMs: 140,

    // Holds
    holdSpacing: 140,            // vertical spacing between holds
    holdWidth: 140,
    holdHeight: 20,
    holdInsetX: 180,             // how far from center the hold columns are
    holdColorL: '#7dd3fc',
    holdColorR: '#fb7185',
    holdColorGap: '#475569',     // visual gaps

    // Parallax factors (lower = farther)
    parallax: {
      sky: 0.15,
      peaks: 0.35,
      mid: 0.6,
      near: 0.85
    },

    // Sprite animation
    fps: 24,
    // Placeholder frame size (set to 512 for 1:1 with production art)
    PLACEHOLDER_FRAME: 256,

    // SFX
    sfxEnabled: true,
    sfxGain: 0.08
  };

  // ----------------------------
  // Globals
  // ----------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  const dom = {
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    timer: document.getElementById('timer'),
    left: document.getElementById('btn-left'),
    right: document.getElementById('btn-right'),
    restart: document.getElementById('btn-restart'),
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlay-title'),
    overlayText: document.getElementById('overlay-text'),
    play: document.getElementById('btn-play')
  };

  // DPI scaling
  let dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  // Game state
  const State = { Menu: 0, Playing: 1, GameOver: 2 };
  let gameState = State.Menu;

  let expectedSide = 'L';          // next correct side
  let score = 0;
  let best = Number(localStorage.getItem('mc_best') || '0');

  let timeRemaining = CONFIG.timeDrainSeconds;
  let lastTs = 0;
  let accumulator = 0;

  let scrollY = 0;
  let scrollBurstUntil = 0;

  // Background day-night cycle
  let dayPhase = Math.random() * Math.PI * 2; // radians
  const daySpeed = 0.05; // low frequency

  // Assets
  let spriteSheetImage = null;
  let spriteManifest = null;

  // Animation playback
  const Clips = {
    idle: 'idle',
    reachL: 'reachL',
    reachR: 'reachR',
    slip: 'slip',
    fall: 'fall'
  };

  const climber = {
    x: 0,
    y: 0,
    scale: 0.75,
    action: Clips.idle,
    frame: 0,
    frameTimer: 0,
    playingOneShot: false,
    faceDir: 1, // 1 right, -1 left for slight lean
    setAction(next) {
      if (this.action === next) return;
      this.action = next;
      this.frame = 0;
      this.frameTimer = 0;
      this.playingOneShot = !spriteManifest.clips[next].loop;
    }
  };

  // Holds list (visual only; gameplay uses expectedSide)
  const holds = [];

  // SFX
  let audio = null;

  function initAudio() {
    if (!CONFIG.sfxEnabled || audio) return;
    audio = new (window.AudioContext || window.webkitAudioContext)();
  }

  function playSfx(type = 'grab') {
    if (!CONFIG.sfxEnabled) return;
    if (!audio) initAudio();
    const ctxA = audio;
    const o = ctxA.createOscillator();
    const g = ctxA.createGain();
    const t = ctxA.currentTime;
    let f1 = 220, f2 = 320, dur = 0.08;

    if (type === 'grab') { f1 = 300; f2 = 540; dur = 0.08; }
    if (type === 'slip') { f1 = 200; f2 = 120; dur = 0.2; }
    if (type === 'fall') { f1 = 160; f2 = 80; dur = 0.5; }

    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    o.type = type === 'fall' ? 'sawtooth' : 'triangle';

    g.gain.value = CONFIG.sfxGain;
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);

    o.connect(g).connect(ctxA.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // ----------------------------
  // Loader: external or placeholder
  // ----------------------------
  async function loadClimberAssets() {
    const externalPng = window.CLIMBER_SPRITE_URL;
    const externalJson = window.CLIMBER_MANIFEST_URL;
    if (externalPng && externalJson) {
      const [img, manifest] = await Promise.all([
        loadImage(externalPng),
        fetch(externalJson).then(r => r.json())
      ]);
      return { image: img, manifest };
    }
    // Placeholder generator
    const { image, manifest } = await generatePlaceholderSheet({
      rows: 5,
      cols: 24,
      frame: CONFIG.PLACEHOLDER_FRAME
    });
    return { image, manifest };
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = url;
    });
  }

  // ----------------------------
  // Placeholder sprite generation
  // ----------------------------
  async function generatePlaceholderSheet({ rows, cols, frame }) {
    const w = cols * frame;
    const h = rows * frame;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d');

    // Common palette
    const skin = '#ffd7b3';
    const suit = '#2dd4bf';
    const suitDark = '#14b8a6';
    const harness = '#ef4444';
    const boots = '#475569';
    const outline = '#0f172a';
    const helmet = '#3b82f6';

    // Draw one pose into a cell [row, col]
    function drawPose(row, col, t, action) {
      const fs = frame;
      const ox = col * fs;
      const oy = row * fs;
      g.save();
      g.translate(ox, oy);

      // Clear cell
      g.fillStyle = '#dbeafe';
      g.fillRect(0, 0, fs, fs);

      // Center body anchor
      const bodyX = fs * 0.5;
      const bodyY = fs * 0.66;

      // Lean offset (reach/idle)
      let lean = 0;
      if (action === 'reachL') lean = -Math.sin(t * Math.PI) * 14;
      if (action === 'reachR') lean = Math.sin(t * Math.PI) * 14;
      if (action === 'slip') lean = Math.sin(t * 10) * 10;
      if (action === 'fall') lean = Math.sin(t * 1.2 * Math.PI) * 30;

      // Body scale for pull/extend
      const stretch = (action === 'reachL' || action === 'reachR') ? (0.98 + 0.06 * Math.sin(t * Math.PI)) : 1;

      // Draw simple cliff behind for depth
      g.fillStyle = '#94a3b8';
      g.fillRect(fs * 0.75, 0, fs * 0.25, fs);

      // Skeleton measurements
      const torsoLen = fs * 0.22 * stretch;
      const neckLen = fs * 0.05;
      const headR = fs * 0.07;

      const upperArm = fs * 0.13;
      const foreArm = fs * 0.12;
      const upperLeg = fs * 0.16;
      const lowerLeg = fs * 0.15;

      // Helper
      function roundRect(x, y, w, h, r) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
      }
      function drawLimb(x1, y1, x2, y2, thickness, color) {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.hypot(x2 - x1, y2 - y1);
        g.save();
        g.translate(x1, y1);
        g.rotate(ang);
        g.fillStyle = color;
        roundRect(0, -thickness / 2, len, thickness, thickness / 2);
        g.fill();
        g.restore();
      }
      function solveIK(p1, p3, l1, l2, bend = 1) {
        const dx = p3.x - p1.x, dy = p3.y - p1.y;
        const d = Math.max(1e-5, Math.hypot(dx, dy));
        const a = Math.acos(clamp((l1*l1 + d*d - l2*l2) / (2*l1*d), -1, 1));
        const b = Math.atan2(dy, dx);
        const theta1 = b - bend * a;
        const theta2 = Math.acos(clamp((l1*l1 + l2*l2 - d*d) / (2*l1*l2), -1, 1));
        return { theta1, theta2: bend * (Math.PI - theta2) };
      }
      function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
      function lerp(a, b, t) { return a + (b - a) * t; }
      function easeInOutSine(u) { return 0.5 - 0.5 * Math.cos(Math.PI * u); }
      function easeOutBack(x) {
        const c1 = 1.70158; const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
      }

      // Torso base
      g.save();
      g.translate(bodyX + lean, bodyY);
      // Slip/fall: translate downward and rotate
      if (action === 'fall') {
        g.rotate(lerp(0, (Math.PI/2) * (Math.random() > 0.5 ? 1 : -1), easeInOutSine(t)));
        g.translate(0, t * fs * 0.25);
      } else if (action === 'slip') {
        g.rotate(Math.sin(t * 20) * 0.08);
      } else {
        g.rotate(lerp(0, (action === 'reachL' ? -0.12 : action === 'reachR' ? 0.12 : 0), easeInOutSine(t)));
      }

      // Draw torso
      const torsoTop = { x: 0, y: -torsoLen };
      const torsoBot = { x: 0, y: 0 };
      g.fillStyle = suit;
      g.strokeStyle = outline;
      g.lineWidth = Math.max(2, fs * 0.006);
      roundRect(-fs*0.04, -torsoLen, fs*0.08, torsoLen, fs*0.03);
      g.fill();

      // Harness
      g.fillStyle = harness;
      roundRect(-fs*0.045, -fs*0.03, fs*0.09, fs*0.06, fs*0.02);
      g.fill();

      // Shoulders anchors
      const shL = { x: -fs * 0.06, y: -torsoLen + fs * 0.02 };
      const shR = { x: fs * 0.06, y: -torsoLen + fs * 0.02 };
      // Hips anchors
      const hipL = { x: -fs * 0.05, y: -fs * 0.004 };
      const hipR = { x: fs * 0.05, y: -fs * 0.004 };

      // Arm targets
      const baseReach = fs * 0.28;
      const targetL = { x: -fs * 0.22, y: -torsoLen - baseReach };
      const targetR = { x: fs * 0.22, y: -torsoLen - baseReach * 0.96 };

      let tReach = easeInOutSine(Math.min(1, Math.max(0, t)));
      let lGoal = { ...targetL }, rGoal = { ...targetR };

      if (action === 'idle') {
        const sway = Math.sin(t * Math.PI * 2) * fs * 0.02;
        lGoal.y += sway; rGoal.y -= sway;
      } else if (action === 'reachL') {
        lGoal.x = lerp(shL.x - fs * 0.02, targetL.x, tReach);
        lGoal.y = lerp(shL.y - fs * 0.1, targetL.y, tReach);
        rGoal.y = lerp(targetR.y + fs * 0.08, targetR.y, tReach);
      } else if (action === 'reachR') {
        rGoal.x = lerp(shR.x + fs * 0.02, targetR.x, tReach);
        rGoal.y = lerp(shR.y - fs * 0.1, targetR.y, tReach);
        lGoal.y = lerp(targetL.y + fs * 0.08, targetL.y, tReach);
      } else if (action === 'slip') {
        const jitter = (n) => (Math.sin(t * 50 + n) * fs * 0.05);
        lGoal.x += jitter(0); lGoal.y += jitter(1);
        rGoal.x += jitter(2); rGoal.y += jitter(3);
      } else if (action === 'fall') {
        const fallT = easeOutBack(t);
        lGoal.y += fallT * fs * 0.3;
        rGoal.y += fallT * fs * 0.35;
      }

      // Solve IK arms and draw
      const armThick = fs * 0.035;
      // Left arm
      let ikL = solveIK(shL, lGoal, upperArm, foreArm, 1);
      let elbowL = {
        x: shL.x + Math.cos(ikL.theta1) * upperArm,
        y: shL.y + Math.sin(ikL.theta1) * upperArm
      };
      drawLimb(shL.x, shL.y, elbowL.x, elbowL.y, armThick, suitDark);
      drawLimb(elbowL.x, elbowL.y, lGoal.x, lGoal.y, armThick * 0.94, suit);
      // Hand
      g.fillStyle = skin;
      g.beginPath();
      g.arc(lGoal.x, lGoal.y, fs * 0.018, 0, Math.PI * 2);
      g.fill();

      // Right arm
      let ikR = solveIK(shR, rGoal, upperArm, foreArm, -1);
      let elbowR = {
        x: shR.x + Math.cos(ikR.theta1) * upperArm,
        y: shR.y + Math.sin(ikR.theta1) * upperArm
      };
      drawLimb(shR.x, shR.y, elbowR.x, elbowR.y, armThick, suitDark);
      drawLimb(elbowR.x, elbowR.y, rGoal.x, rGoal.y, armThick * 0.94, suit);
      g.fillStyle = skin;
      g.beginPath();
      g.arc(rGoal.x, rGoal.y, fs * 0.018, 0, Math.PI * 2);
      g.fill();

      // Legs (reach: slight cross / extend)
      const legThick = fs * 0.045;
      const footLen = fs * 0.07;

      function legPose(hip, dir) {
        // dir -1 left, +1 right
        let kneeTarget = {
          x: hip.x + dir * fs * 0.06,
          y: hip.y + fs * 0.18
        };
        let footTarget = {
          x: hip.x + dir * fs * 0.14,
          y: hip.y + fs * 0.28
        };
        if (action === 'reachL' && dir === -1) {
          kneeTarget.x -= fs * 0.04;
          footTarget.x -= fs * 0.06;
        }
        if (action === 'reachR' && dir === +1) {
          kneeTarget.x += fs * 0.04;
          footTarget.x += fs * 0.06;
        }
        if (action === 'slip' || action === 'fall') {
          kneeTarget.x += dir * Math.sin(t * 18) * fs * 0.05;
          footTarget.y += t * fs * 0.2;
        }
        // Two-stage: hip->knee, knee->ankle
        const ikUpper = solveIK(hip, kneeTarget, upperLeg, lowerLeg, dir);
        const knee = {
          x: hip.x + Math.cos(ikUpper.theta1) * upperLeg,
          y: hip.y + Math.sin(ikUpper.theta1) * upperLeg
        };
        const ikLower = solveIK(knee, footTarget, lowerLeg, footLen, dir);
        const ankle = {
          x: knee.x + Math.cos(ikLower.theta1) * lowerLeg,
          y: knee.y + Math.sin(ikLower.theta1) * lowerLeg
        };
        const foot = {
          x: ankle.x + footLen * (dir),
          y: ankle.y + fs * 0.005
        };
        return { knee, ankle, foot };
      }

      const leftLeg = legPose(hipL, -1);
      const rightLeg = legPose(hipR, +1);
      // Draw legs
      drawLimb(hipL.x, hipL.y, leftLeg.knee.x, leftLeg.knee.y, legThick, boots);
      drawLimb(leftLeg.knee.x, leftLeg.knee.y, leftLeg.ankle.x, leftLeg.ankle.y, legThick * 0.92, boots);
      drawLimb(leftLeg.ankle.x, leftLeg.ankle.y, leftLeg.foot.x, leftLeg.foot.y, legThick * 0.6, boots);

      drawLimb(hipR.x, hipR.y, rightLeg.knee.x, rightLeg.knee.y, legThick, boots);
      drawLimb(rightLeg.knee.x, rightLeg.knee.y, rightLeg.ankle.x, rightLeg.ankle.y, legThick * 0.92, boots);
      drawLimb(rightLeg.ankle.x, rightLeg.ankle.y, rightLeg.foot.x, rightLeg.foot.y, legThick * 0.6, boots);

      // Neck and head
      const neckTop = { x: torsoTop.x, y: torsoTop.y - neckLen };
      drawLimb(torsoTop.x, torsoTop.y, neckTop.x, neckTop.y, fs * 0.028, suitDark);
      // Head
      g.fillStyle = skin;
      g.beginPath();
      g.arc(neckTop.x, neckTop.y - headR * 0.4, headR, 0, Math.PI * 2);
      g.fill();
      // Helmet
      g.fillStyle = helmet;
      g.beginPath();
      g.arc(neckTop.x, neckTop.y - headR * 0.4, headR, Math.PI * 0.9, Math.PI * 2.1);
      g.fill();

      g.restore(); // end torso transform

      // Border around cell (optional)
      g.strokeStyle = 'rgba(0,0,0,0.04)';
      g.lineWidth = 1;
      g.strokeRect(0, 0, fs, fs);

      g.restore();
    }

    // Fill rows with 24 frames each
    const actions = ['idle', 'reachL', 'reachR', 'slip', 'fall'];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = c / (cols - 1); // 0..1 across clip
        drawPose(r, c, t, actions[r]);
      }
    }

    const img = await canvasToImage(off);

    const manifest = {
      frameSize: frame,
      rows,
      cols,
      clips: {
        idle: { row: 0, length: 24, loop: true },
        reachL: { row: 1, length: 24, loop: false },
        reachR: { row: 2, length: 24, loop: false },
        slip: { row: 3, length: 24, loop: false },
        fall: { row: 4, length: 24, loop: false }
      }
    };

    return { image: img, manifest };
  }

  function canvasToImage(cnv) {
    return new Promise((resolve) => {
      const url = cnv.toDataURL('image/png');
      const i = new Image();
      i.onload = () => resolve(i);
      i.src = url;
    });
  }

  // ----------------------------
  // Holds management (visual parallax)
  // ----------------------------
  function resetHolds() {
    holds.length = 0;
    const count = Math.ceil(CONFIG.viewHeight / CONFIG.holdSpacing) + 6;
    let side = Math.random() < 0.5 ? 'L' : 'R';
    let startY = -CONFIG.viewHeight * 0.2;
    for (let i = 0; i < count; i++) {
      const y = startY + i * CONFIG.holdSpacing;
      holds.push({ y, side, gap: Math.random() < 0.12 ? true : false });
      side = side === 'L' ? 'R' : 'L';
    }
  }

  function spawnHoldAtTop() {
    const topY = Math.min(...holds.map(h => h.y));
    const prev = holds[0];
    const side = prev ? (prev.side === 'L' ? 'R' : 'L') : (Math.random() < 0.5 ? 'L' : 'R');
    holds.unshift({
      y: topY - CONFIG.holdSpacing,
      side,
      gap: Math.random() < 0.1
    });
  }

  function cullHolds() {
    const maxY = CONFIG.viewHeight + 160;
    while (holds.length && holds[holds.length - 1].y > maxY) {
      holds.pop();
    }
  }

  function updateHolds(dt, scrollSpeed) {
    for (const h of holds) h.y += scrollSpeed * dt;
    // Ensure enough holds above
    while (holds.length < Math.ceil(CONFIG.viewHeight / CONFIG.holdSpacing) + 10) {
      spawnHoldAtTop();
    }
    cullHolds();
  }

  // ----------------------------
  // Canvas and UI
  // ----------------------------
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const targetW = rect.width * dpr;
    const targetH = rect.height * dpr;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = Math.round(targetW);
      canvas.height = Math.round(targetH);
    }
  }

  function fitCanvasToViewport() {
    // Maintain target aspect roughly 9:16 while filling height
    const vw = window.innerWidth;
    const vh = window.innerHeight - document.querySelector('.hud').offsetHeight - document.querySelector('.controls').offsetHeight - 12;
    const idealAspect = CONFIG.viewWidth / CONFIG.viewHeight; // ~0.5625
    let width = vw;
    let height = Math.round(vw / idealAspect);
    if (height > vh) {
      height = vh;
      width = Math.round(vh * idealAspect);
    }
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    resizeCanvas();
  }

  // ----------------------------
  // Input handling
  // ----------------------------
  function handleMove(side) {
    if (gameState !== State.Playing) return;
    const correct = (side === expectedSide);
    if (correct) {
      score += 1;
      dom.score.textContent = String(score);
      // Alternate expected side
      expectedSide = (expectedSide === 'L') ? 'R' : 'L';
      timeRemaining = Math.min(CONFIG.timeOnSuccessMax, timeRemaining + CONFIG.timeOnSuccess);
      dom.timer.style.transform = `scaleX(${timeRemaining / CONFIG.timeDrainSeconds})`;

      // Kick scroll burst and play animation
      scrollBurstUntil = performance.now() + CONFIG.worldScrollBurstMs;
      climber.setAction(side === 'L' ? Clips.reachL : Clips.reachR);
      climber.faceDir = side === 'L' ? -1 : 1;

      playSfx('grab');
      // Visual: push holds so we always see movement
      spawnHoldAtTop();
    } else {
      // Slip then fall
      timeRemaining = 0;
      dom.timer.style.transform = `scaleX(0)`;
      playSfx('slip');
      climber.setAction(Clips.slip);
      // Game over will transition when slip finishes into fall
    }
  }

  function bindInputs() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'ArrowLeft') handleMove('L');
      if (e.key === 'ArrowRight') handleMove('R');
      if (e.key.toLowerCase() === 'r') startGame();
      if (e.key === ' ' && gameState !== State.Playing) startGame();
    });
    dom.left.addEventListener('click', () => handleMove('L'));
    dom.right.addEventListener('click', () => handleMove('R'));
    dom.restart.addEventListener('click', () => startGame());
    dom.play.addEventListener('click', () => startGame());
    canvas.addEventListener('pointerdown', () => initAudio(), { once: true });
  }

  // ----------------------------
  // Game State
  // ----------------------------
  function startGame() {
    score = 0;
    dom.score.textContent = '0';
    timeRemaining = CONFIG.timeDrainSeconds;
    expectedSide = Math.random() < 0.5 ? 'L' : 'R';
    scrollY = 0;
    scrollBurstUntil = 0;
    resetHolds();
    climber.setAction(Clips.idle);
    climber.faceDir = expectedSide === 'L' ? -1 : 1;
    dom.timer.style.transform = 'scaleX(1)';
    hideOverlay();
    gameState = State.Playing;
  }

  function endGame() {
    gameState = State.GameOver;
    best = Math.max(best, score);
    localStorage.setItem('mc_best', String(best));
    dom.best.textContent = `BEST: ${best}`;
    setOverlay('Fell!', `Score: ${score}`);
    showOverlay();
  }

  function setOverlay(title, text) {
    dom.overlayTitle.textContent = title;
    dom.overlayText.textContent = text;
  }
  function showOverlay() { dom.overlay.hidden = false; }
  function hideOverlay() { dom.overlay.hidden = true; }

  // ----------------------------
  // Update & Render
  // ----------------------------
  function update(dt, now) {
    // Background day-night oscillator
    dayPhase += dt * daySpeed;

    if (gameState === State.Playing) {
      timeRemaining -= dt;
      if (timeRemaining <= 0) {
        timeRemaining = 0;
        dom.timer.style.transform = 'scaleX(0)';
        if (climber.action !== Clips.fall) {
          if (climber.action !== Clips.slip) {
            playSfx('slip');
            climber.setAction(Clips.slip);
          }
        }
      } else {
        dom.timer.style.transform = `scaleX(${timeRemaining / CONFIG.timeDrainSeconds})`;
      }
    }

    // Scroll speed with burst after successful moves
    const burstActive = now < scrollBurstUntil;
    const scrollSpeed = (CONFIG.worldScrollBase + (burstActive ? CONFIG.worldScrollBurst : 0));
    updateHolds(dt, scrollSpeed);

    // Animate climber
    const frameDur = 1 / CONFIG.fps;
    climber.frameTimer += dt;
    while (climber.frameTimer >= frameDur) {
      climber.frameTimer -= frameDur;
      climber.frame++;
      const clip = spriteManifest.clips[climber.action];
      if (climber.frame >= clip.length) {
        if (clip.loop) {
          climber.frame = 0;
        } else {
          // One-shot ended
          if (climber.action === Clips.slip) {
            // Transition to fall
            climber.setAction(Clips.fall);
            playSfx('fall');
          } else if (climber.action === Clips.fall) {
            endGame();
          } else {
            climber.setAction(Clips.idle);
          }
        }
      }
    }
  }

  function drawBackground() {
    const w = canvas.width, h = canvas.height;
    const g = ctx;
    const t = performance.now() * 0.001;

    // Day-night color
    const k = (Math.sin(dayPhase) + 1) * 0.5; // 0..1
    const skyTop = lerpColor('#2c3e50', '#87ceeb', k);
    const skyBot = lerpColor('#0b1320', '#bde0fe', k);

    // Sky gradient
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, skyTop);
    grad.addColorStop(1, skyBot);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // Distant peaks (parallax)
    g.save();
    const peaksOffset = (t * 12) % (h * 2);
    g.translate(0, peaksOffset * CONFIG.parallax.peaks);
    drawPeaksLayer(g, w, h);
    g.restore();

    // Mid cliffs
    g.save();
    g.translate(0, (t * 24) % (h * 2) * CONFIG.parallax.mid);
    drawCliffStripes(g, w, h, 0.75);
    g.restore();

    // Near rock face
    g.save();
    g.translate(0, (t * 40) % (h * 2) * CONFIG.parallax.near);
    drawCliffStripes(g, w, h, 0.9);
    g.restore();
  }

  function drawPeaksLayer(g, w, h) {
    g.fillStyle = 'rgba(0,0,0,0.06)';
    const baseY = h * 0.75;
    const count = 6;
    for (let i = 0; i < count; i++) {
      const x = (i / count) * w + (i % 2) * 40;
      const y = baseY + ((i % 2) ? 40 : 0);
      const width = w / 5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + width * 0.5, y - width * 0.6);
      g.lineTo(x + width, y);
      g.closePath();
      g.fill();
    }
  }

  function drawCliffStripes(g, w, h, strength) {
    const col = `rgba(0,0,0,${0.08 * strength})`;
    g.fillStyle = col;
    for (let i = 0; i < 10; i++) {
      const x = w * 0.7 + Math.sin(i * 1.3) * 40;
      const y = (i / 10) * h;
      g.fillRect(x, y, w * 0.35, 18);
    }
  }

  function drawHolds() {
    const g = ctx;
    const w = canvas.width;
    const h = canvas.height;
    const centerX = w / 2;
    const fs = spriteManifest.frameSize;
    const scale = (canvas.height / CONFIG.viewHeight);
    const holdW = CONFIG.holdWidth * scale * dpr;
    const holdH = CONFIG.holdHeight * scale * dpr;
    const inset = CONFIG.holdInsetX * scale * dpr;

    for (const hold of holds) {
      const sx = hold.side === 'L' ? (centerX - inset - holdW) : (centerX + inset);
      const sy = hold.y * scale * dpr;
      const color = hold.gap ? CONFIG.holdColorGap : (hold.side === 'L' ? CONFIG.holdColorL : CONFIG.holdColorR);

      ctx.globalAlpha = 0.95;
      g.fillStyle = color;
      g.strokeStyle = 'rgba(0,0,0,0.15)';
      g.lineWidth = Math.max(2, dpr);
      g.beginPath();
      g.roundRect(sx, sy, holdW, holdH, holdH * 0.35);
      g.fill(); g.stroke();

      // Emphasize the upcoming hold (visual cue)
      if (!hold.gap && hold.side === expectedSide && sy < h * 0.35 && sy > h * 0.1) {
        g.save();
        g.shadowColor = 'rgba(255,255,255,0.4)';
        g.shadowBlur = 14 * dpr;
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.lineWidth = 3 * dpr;
        g.stroke();
        g.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawClimber() {
    const g = ctx;
    const clip = spriteManifest.clips[climber.action];
    const frameSize = spriteManifest.frameSize;
    const col = Math.min(clip.length - 1, Math.max(0, climber.frame));
    const row = clip.row;

    const sx = col * frameSize;
    const sy = row * frameSize;
    const s = getCanvasScale();
    const targetY = canvas.height * 0.58;

    const spriteScale = climber.scale * (canvas.height / CONFIG.viewHeight) * dpr;

    g.save();
    const drawX = canvas.width / 2 - (frameSize * spriteScale) / 2;
    const drawY = targetY - (frameSize * spriteScale) / 2;

    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(
      spriteSheetImage,
      sx, sy, frameSize, frameSize,
      drawX, drawY,
      frameSize * spriteScale,
      frameSize * spriteScale
    );

    g.restore();
  }

  function getCanvasScale() {
    const scaleX = (canvas.width / dpr) / CONFIG.viewWidth;
    const scaleY = (canvas.height / dpr) / CONFIG.viewHeight;
    return Math.min(scaleX, scaleY);
  }

  function render() {
    drawBackground();
    drawHolds();
    drawClimber();

    // HUD cue for expected side
    const g = ctx;
    const w = canvas.width;
    const h = canvas.height;
    g.save();
    const text = expectedSide === 'L' ? 'LEFT' : 'RIGHT';
    g.font = `${Math.round(20 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial`;
    g.textAlign = expectedSide === 'L' ? 'left' : 'right';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillText(text, expectedSide === 'L' ? 12 * dpr : w - 12 * dpr, 12 * dpr);
    g.restore();
  }

  // ----------------------------
  // Main loop
  // ----------------------------
  function frame(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000); // clamp large pauses
    lastTs = ts;

    update(dt, ts);
    render();

    requestAnimationFrame(frame);
  }

  // ----------------------------
  // Util
  // ----------------------------
  function lerpColor(a, b, t) {
    const c1 = hexToRgb(a), c2 = hexToRgb(b);
    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b2 = Math.round(c1.b + (c2.b - c1.b) * t);
    return `rgb(${r},${g},${b2})`;
  }
  function hexToRgb(hex) {
    const s = hex.replace('#', '');
    const n = parseInt(s.length === 3 ? s.split('').map(ch => ch + ch).join('') : s, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // ----------------------------
  // Boot
  // ----------------------------
  async function boot() {
    fitCanvasToViewport();
    window.addEventListener('resize', () => {
      fitCanvasToViewport();
    }, { passive: true });

    // Load or generate assets
    const { image, manifest } = await loadClimberAssets();
    spriteSheetImage = image;
    spriteManifest = manifest;

    // Init UI
    dom.best.textContent = `BEST: ${best}`;
    setOverlay('Mountain Climber', 'Press LEFT or RIGHT to grab the next hold. Match the side, refill the timer, climb forever.');
    showOverlay();

    resetHolds();
    bindInputs();

    requestAnimationFrame(frame);
  }

  boot();
})();
