// script.js
// ASSET NOTE: place all PNGs and manifest.json in the SAME directory as index.html.
// Required files:
// - climber_sprite_sheet.png
// - layer1_sky_day.png / layer1_sky_night.png
// - layer2_mountains_day.png / layer2_mountains_night.png
// - layer3_treeline_day.png / layer3_treeline_night.png
// - layer4_rock_edge.png
// - manifest.json

(() => {
  'use strict';

  // DOM references
  const layerEls = {
    l1: document.getElementById('layer1'),
    l2: document.getElementById('layer2'),
    l3: document.getElementById('layer3'),
    l4: document.getElementById('layer4'),
  };
  const holdsEl = document.getElementById('holds');
  const canvas = document.getElementById('climberCanvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const timebarFillEl = document.getElementById('timebarFill');
  const overlayEl = document.getElementById('overlay');
  const overlayTitleEl = document.getElementById('overlayTitle');
  const finalScoreEl = document.getElementById('finalScore');
  const btnRestart = document.getElementById('btnRestart');
  const btnLeft = document.getElementById('btnLeft');
  const btnRight = document.getElementById('btnRight');

  // Canvas scaling for HiDPI
  const deviceScale = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const cssW = canvas.width;
  const cssH = canvas.height;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = cssW * deviceScale;
  canvas.height = cssH * deviceScale;
  ctx.scale(deviceScale, deviceScale);

  // Constants
  const SPRITE_COLS = 24;
  const SPRITE_ROWS = 5;
  const FPS = 24;
  const FRAME_MS = 1000 / FPS;
  const TIME_PER_MOVE_MS = 3000;
  const NUM_VISIBLE_HOLDS = 12;
  const MAX_SAME_SIDE_RUN = 3;
  const BG_SCROLL_SPEEDS = [0.05, 0.12, 0.25, 0.6]; // l1..l4
  const ASSET_BASES = ['', './', './assets/', './images/', './img/'];

  // Assets
  const images = {};
  let manifestData = null;

  // Game state
  let isNightMode = false;
  let bgOffset = 0;
  let lastTimestamp = 0;
  let running = false;
  let isAnimatingMove = false;
  let isGameOver = false;
  let timeRemainingMs = TIME_PER_MOVE_MS;
  let score = 0;

  // Holds: array where last element is the bottom hold
  /** @type {{ side: 'left'|'right', size: 'small'|'medium'|'large'|'circle', shape: 'rounded'|'pill'|'circle', color: string }[]} */
  let holds = [];

  // Sprite / animation
  const ACTIONS = ['idle-hang', 'reach', 'pull-up', 'slip', 'fall'];
  /** @type {Record<string, {row:number,col:number,order:number}[]>} */
  let actionToFrames = {};
  let frameWidth = 0;
  let frameHeight = 0;

  const climber = {
    facing: 'left', // 'left' | 'right'
    currentAction: 'idle-hang',
    currentFrameIdx: 0,
    frameTimerMs: 0,
    sequenceQueue: [],
    setFacing(side) {
      this.facing = side;
    },
    playSequence(actions, onComplete) {
      this.sequenceQueue = [...actions];
      this._onSequenceComplete = (typeof onComplete === 'function') ? onComplete : null;
      this._advanceAction();
    },
    _advanceAction() {
      if (this.sequenceQueue.length === 0) {
        if (this._onSequenceComplete) this._onSequenceComplete();
        return;
      }
      this.currentAction = this.sequenceQueue.shift();
      this.currentFrameIdx = 0;
      this.frameTimerMs = 0;
    },
    update(dtMs) {
      const frames = actionToFrames[this.currentAction];
      if (!frames || frames.length === 0) return;

      this.frameTimerMs += dtMs;
      while (this.frameTimerMs >= FRAME_MS) {
        this.frameTimerMs -= FRAME_MS;
        this.currentFrameIdx++;
        if (this.currentFrameIdx >= frames.length) {
          // Loop idle, otherwise chain to next action or end
          if (this.currentAction === 'idle-hang') {
            this.currentFrameIdx = 0;
          } else if (this.currentAction === 'slip') {
            if (this.sequenceQueue.length === 0) {
              this.sequenceQueue.push('fall');
            }
            this._advanceAction();
          } else {
            this._advanceAction();
          }
        }
      }
    },
    draw() {
      const w = canvas.width / deviceScale;
      const h = canvas.height / deviceScale;

      // Always clear before transforms
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      // Flip horizontally for right-facing moves
      if (this.facing === 'right') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }

      if (images.sprite && frameWidth > 0 && frameHeight > 0) {
        const frames = actionToFrames[this.currentAction];
        if (frames && frames.length > 0) {
          const f = frames[Math.min(this.currentFrameIdx, frames.length - 1)];
          const sx = f.col * frameWidth;
          const sy = f.row * frameHeight;
          const dw = 70; // render size within 80x200 canvas
          const dh = 160;
          const dx = (w - dw) / 2;
          const dy = (h - dh) / 2;

          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(images.sprite, sx, sy, frameWidth, frameHeight, dx, dy, dw, dh);
        }
      } else {
        // Fallback placeholder climber (if sprite not loaded)
        const baseX = w / 2;
        const baseY = h - 20;

        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.fillStyle = 'rgba(120,210,190,0.9)';
        ctx.lineWidth = 3;

        // Body
        ctx.beginPath();
        ctx.arc(baseX, baseY - 55, 10, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(baseX, baseY - 45);
        ctx.lineTo(baseX, baseY - 10);
        ctx.stroke();

        // Arms alternate based on action/frame to hint motion
        const t = (this.currentFrameIdx % 12) / 12;
        const armLift = (this.currentAction === 'reach' || this.currentAction === 'pull-up') ? 16 : 4;
        ctx.beginPath();
        ctx.moveTo(baseX, baseY - 40);
        ctx.lineTo(baseX - 16, baseY - 30 - armLift * (1 - t));
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(baseX, baseY - 40);
        ctx.lineTo(baseX + 16, baseY - 30 - armLift * t);
        ctx.stroke();

        // Legs
        ctx.beginPath();
        ctx.moveTo(baseX, baseY - 10);
        ctx.lineTo(baseX - 12, baseY);
        ctx.moveTo(baseX, baseY - 10);
        ctx.lineTo(baseX + 12, baseY);
        ctx.stroke();
      }

      ctx.restore();
    }
  };

  // Utilities
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Image failed: ${src}`));
      img.src = src;
    });
  }

  async function loadImageSmart(name) {
    for (const base of ASSET_BASES) {
      try {
        const img = await loadImage(base + name);
        return img;
      } catch (_) {
        // continue
      }
    }
    return null;
  }

  async function loadManifestSmart() {
    for (const base of ASSET_BASES) {
      try {
        const res = await fetch(base + 'manifest.json', { cache: 'no-store' });
        if (res.ok) {
          return await res.json();
        }
      } catch (_) {
        // Likely file:// CORS or missing file; try next base
      }
    }
    return null;
  }

  async function loadAssets() {
    const results = await Promise.allSettled([
      loadImageSmart('climber_sprite_sheet.png'),
      loadImageSmart('layer1_sky_day.png'),
      loadImageSmart('layer1_sky_night.png'),
      loadImageSmart('layer2_mountains_day.png'),
      loadImageSmart('layer2_mountains_night.png'),
      loadImageSmart('layer3_treeline_day.png'),
      loadImageSmart('layer3_treeline_night.png'),
      loadImageSmart('layer4_rock_edge.png'),
      loadManifestSmart()
    ]);

    const [
      rSprite,
      rL1Day, rL1Night,
      rL2Day, rL2Night,
      rL3Day, rL3Night,
      rL4,
      rManifest
    ] = results;

    images.sprite = rSprite.status === 'fulfilled' ? rSprite.value : null;
    images.l1day = rL1Day.status === 'fulfilled' ? rL1Day.value : null;
    images.l1night = rL1Night.status === 'fulfilled' ? rL1Night.value : null;
    images.l2day = rL2Day.status === 'fulfilled' ? rL2Day.value : null;
    images.l2night = rL2Night.status === 'fulfilled' ? rL2Night.value : null;
    images.l3day = rL3Day.status === 'fulfilled' ? rL3Day.value : null;
    images.l3night = rL3Night.status === 'fulfilled' ? rL3Night.value : null;
    images.l4 = rL4.status === 'fulfilled' ? rL4.value : null;
    manifestData = rManifest.status === 'fulfilled' ? rManifest.value : null;
  }

  function buildActionFramesFromManifest() {
    actionToFrames = {};
    if (!manifestData) {
      // Fallback: assume row order maps to actions and col order is frame order
      for (let r = 0; r < SPRITE_ROWS; r++) {
        const action = ACTIONS[r] || `row-${r}`;
        actionToFrames[action] = [];
        for (let c = 0; c < SPRITE_COLS; c++) {
          actionToFrames[action].push({ row: r, col: c, order: c });
        }
      }
      return;
    }

    // manifest: "row-col": { action, frame_index }
    const buckets = {};
    for (const key in manifestData) {
      const entry = manifestData[key];
      const [rowStr, colStr] = key.split('-');
      const row = parseInt(rowStr, 10);
      const col = parseInt(colStr, 10);
      const action = entry.action;
      const order = typeof entry.frame_index === 'number' ? entry.frame_index : col;

      if (!buckets[action]) buckets[action] = [];
      buckets[action].push({ row, col, order });
    }

    // Sort by order
    for (const action in buckets) {
      actionToFrames[action] = buckets[action].sort((a, b) => a.order - b.order);
    }

    // Ensure all expected actions exist, fill missing with fallback if needed
    ACTIONS.forEach((action, rIdx) => {
      if (!actionToFrames[action] || actionToFrames[action].length === 0) {
        actionToFrames[action] = [];
        for (let c = 0; c < SPRITE_COLS; c++) {
          actionToFrames[action].push({ row: rIdx, col: c, order: c });
        }
      }
    });
  }

  // Backgrounds
  function applyParallaxBackgrounds() {
    const pick = (dayImg, nightImg) => (isNightMode ? nightImg : dayImg);

    // Sky
    const sky = pick(images.l1day, images.l1night);
    layerEls.l1.style.backgroundImage = sky ? `url(${sky.src})` :
      (isNightMode
        ? 'linear-gradient(#0b1730, #071225)'
        : 'linear-gradient(#a0d6ff, #d9f0fb)');

    // Mountains
    const mtn = pick(images.l2day, images.l2night);
    layerEls.l2.style.backgroundImage = mtn ? `url(${mtn.src})` :
      (isNightMode
        ? 'linear-gradient(rgba(40,50,80,0.7), rgba(25,30,50,0.7))'
        : 'linear-gradient(rgba(70,90,120,0.6), rgba(50,70,100,0.6))');

    // Treeline
    const tree = pick(images.l3day, images.l3night);
    layerEls.l3.style.backgroundImage = tree ? `url(${tree.src})` :
      (isNightMode
        ? 'linear-gradient(rgba(20,50,50,0.6), rgba(10,30,30,0.6))'
        : 'linear-gradient(rgba(30,70,70,0.5), rgba(20,50,50,0.5))');

    // Rock edge
    layerEls.l4.style.backgroundImage = images.l4
      ? `url(${images.l4.src})`
      : 'linear-gradient(to right, transparent 0%, transparent 70%, rgba(0,0,0,0.55) 85%, rgba(0,0,0,0.85) 100%)';
  }

  function updateParallax(dtMs) {
    bgOffset += dtMs * 0.06; // base speed
    const offsets = BG_SCROLL_SPEEDS.map(s => -((bgOffset * s) % 4096));
    layerEls.l1.style.backgroundPosition = `${offsets[0]}px 0`;
    layerEls.l2.style.backgroundPosition = `${offsets[1]}px 0`;
    layerEls.l3.style.backgroundPosition = `${offsets[2]}px 0`;
    layerEls.l4.style.backgroundPosition = `${offsets[3]}px 0`;
  }

  // Holds
  function randomMutedColor() {
    const hues = [160, 180, 200, 220, 260, 300];
    const h = hues[Math.floor(Math.random() * hues.length)];
    const s = 28 + Math.floor(Math.random() * 12); // 28%-40%
    const l = 58 + Math.floor(Math.random() * 10); // 58%-68%
    return `hsl(${h} ${s}% ${l}%)`;
  }

  function randomHoldShape() {
    const sizes = ['small', 'medium', 'large', 'circle'];
    const shapes = ['rounded', 'pill', 'circle'];
    const size = sizes[Math.floor(Math.random() * sizes.length)];
    const shape = (size === 'circle') ? 'circle' : shapes[Math.floor(Math.random() * shapes.length)];
    return { size, shape };
  }

  function generateSide(prevSideRunCount, lastSide) {
    const pickSide = () => (Math.random() < 0.5 ? 'left' : 'right');
    let side = pickSide();
    if (prevSideRunCount >= MAX_SAME_SIDE_RUN - 1 && lastSide) {
      side = lastSide === 'left' ? 'right' : 'left';
    }
    return side;
  }

  function generateHold(prevSideRunCount, lastSide) {
    const { size, shape } = randomHoldShape();
    return {
      side: generateSide(prevSideRunCount, lastSide),
      size,
      shape,
      color: randomMutedColor()
    };
  }

  function initHolds() {
    holds = [];
    let runCount = 0;
    let lastSide = null;
    for (let i = 0; i < NUM_VISIBLE_HOLDS; i++) {
      const h = generateHold(runCount, lastSide);
      if (h.side === lastSide) {
        runCount++;
      } else {
        runCount = 1;
        lastSide = h.side;
      }
      holds.unshift(h);
    }
    renderHolds();
  }

  function renderHolds() {
    holdsEl.innerHTML = '';
    for (let i = 0; i < holds.length; i++) {
      const h = holds[i];
      const el = document.createElement('div');
      el.className = `hold size-${h.size} shape-${h.shape}`;
      el.style.backgroundColor = h.color;
      el.style.gridColumn = h.side === 'left' ? '1' : '2';
      if (i === holds.length - 1) {
        el.classList.add('active');
      }
      holdsEl.appendChild(el);
    }
  }

  function bottomHoldSide() {
    if (holds.length === 0) return null;
    return holds[holds.length - 1].side;
  }

  function advanceHolds() {
    holds.pop();
    const last1 = holds[holds.length - 1]?.side || null;
    const last2 = holds[holds.length - 2]?.side || null;
    const last3 = holds[holds.length - 3]?.side || null;
    const runCount =
      last1 && last2 && last3 && last1 === last2 && last2 === last3 ? 3 :
      last1 && last2 && last1 === last2 ? 2 :
      last1 ? 1 : 0;
    const lastSide = last1 || null;
    const newHold = generateHold(runCount, lastSide);
    holds.unshift(newHold);
    renderHolds();
  }

  // Timer
  function refillTimerFull() {
    timeRemainingMs = TIME_PER_MOVE_MS;
    updateTimebar();
  }
  function updateTimebar() {
    const pct = Math.max(0, Math.min(1, timeRemainingMs / TIME_PER_MOVE_MS));
    timebarFillEl.style.width = `${pct * 100}%`;
    if (pct < 0.2) {
      timebarFillEl.style.background = `linear-gradient(90deg, #f5a36c, #e05a5a)`;
    } else {
      timebarFillEl.style.background = `linear-gradient(90deg, #88e0c8, #5bc4a8)`;
    }
  }

  // Scoring
  function setScore(value) {
    score = value;
    scoreEl.textContent = String(score);
  }
  function addScore(delta) {
    setScore(score + delta);
  }

  // Input
  function handleChoice(side) {
    if (isGameOver || !running || isAnimatingMove) return;

    const required = bottomHoldSide();
    if (!required) return;

    if (side === required) {
      isAnimatingMove = true;
      climber.setFacing(side);
      climber.playSequence(['reach', 'pull-up', 'idle-hang'], () => {
        isAnimatingMove = false;
      });
      advanceHolds();
      addScore(1);
      refillTimerFull();
    } else {
      isAnimatingMove = true;
      climber.setFacing(side);
      climber.playSequence(['slip', 'fall'], () => {
        isAnimatingMove = false;
        triggerGameOver('Wrong side!');
      });
    }
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === 'arrowleft' || key === 'a' || key === 'h') {
      handleChoice('left');
    } else if (key === 'arrowright' || key === 'd' || key === 'l') {
      handleChoice('right');
    } else if (key === 't') {
      toggleNightMode();
    } else if (key === 'r') {
      if (isGameOver) restartGame();
    }
  }

  // Mode
  function autoSetDayNight() {
    const hour = new Date().getHours();
    isNightMode = (hour < 7 || hour >= 18);
  }
  function toggleNightMode() {
    isNightMode = !isNightMode;
    applyParallaxBackgrounds();
  }

  // Game lifecycle
  function startLoop() {
    running = true;
    isGameOver = false;
    lastTimestamp = performance.now();
    requestAnimationFrame(loop);
  }

  function loop(ts) {
    if (!running) return;
    const dt = Math.min(48, ts - lastTimestamp);
    lastTimestamp = ts;

    updateParallax(dt);

    if (!isGameOver) {
      timeRemainingMs -= dt;
      if (timeRemainingMs <= 0) {
        timeRemainingMs = 0;
        updateTimebar();
        isAnimatingMove = true;
        climber.playSequence(['fall'], () => {
          isAnimatingMove = false;
          triggerGameOver('Out of time!');
        });
      } else {
        updateTimebar();
      }
    }

    climber.update(dt);
    climber.draw();

    requestAnimationFrame(loop);
  }

  function triggerGameOver(reasonText) {
    isGameOver = true;
    running = false;
    overlayTitleEl.textContent = 'Game Over';
    finalScoreEl.textContent = String(score);
    overlayEl.hidden = false;
  }

  function resetState() {
    // Build frames
    if (images.sprite) {
      frameWidth = images.sprite.width / SPRITE_COLS;
      frameHeight = images.sprite.height / SPRITE_ROWS;
    } else {
      frameWidth = 1; // non-zero for frame stepping
      frameHeight = 1;
    }

    buildActionFramesFromManifest();
    autoSetDayNight();
    applyParallaxBackgrounds();

    setScore(0);
    refillTimerFull();
    initHolds();

    climber.currentAction = 'idle-hang';
    climber.currentFrameIdx = 0;
    climber.frameTimerMs = 0;
    climber.sequenceQueue = [];
    climber.facing = 'left';

    isGameOver = false;
    isAnimatingMove = false;
    bgOffset = 0;

    overlayEl.hidden = true;
  }

  function restartGame() {
    resetState();
    startLoop();
  }

  // Wire events
  btnLeft.addEventListener('click', () => handleChoice('left'));
  btnRight.addEventListener('click', () => handleChoice('right'));
  btnRestart.addEventListener('click', restartGame);
  window.addEventListener('keydown', onKeyDown);

  // Init
  (async function init() {
    await loadAssets();
    resetState();
    startLoop();
  })();

})();
