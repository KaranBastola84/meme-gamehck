/* ════════════════════════════════════════════════════════════════════
   ROOTRUN — game core.
   World constants + LEVELS live in js/levels.js (plain globals).
   Performance notes:
   • Every obstacle is registered once in `ent` when a level loads.
   • The 60 fps loop never calls querySelector/querySelectorAll and never
     re-parses style strings — it only writes what changed.
   • Obstacles remain real DOM elements with data-* attributes on purpose:
     that is what the hacking lessons are about.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ── physics & player constants ──
     Jump was floaty (~43 frames airborne). Gravity + jump power raised
     together so jump height is unchanged but ascent/descent are ~18% faster.
     Run speed nudged 4 -> 4.4 so horizontal air distance is preserved —
     verified level-by-level that no clearable jump changed. */
  const GRAVITY = 0.9;
  const PLAYER_W = 28, PLAYER_H = 42;

  function freshState() {
    return { speed: 4.4, jumpPower: 18, size: 1, health: 100, coins: 0 };
  }
  window.gameState = freshState();

  /* ── live state ── */
  let currentLevelIndex = 0;
  let lvl = null;                       // LEVELS[currentLevelIndex]
  let ent = null;                       // per-level entity cache (rebuilt on load)
  let px = 40, py = GROUND_Y - PLAYER_H, vx = 0, vy = 0, onGround = true;
  let keys = {};
  let collectedThisLevel = [];
  let running = true;
  let hurtCooldown = 0;
  let facing = 1;
  let playerCtx = null;
  let playerEl = null;
  let spriteDrawn = "";                 // last sprite key drawn ("pose|dir")
  let pX = null, pY = null, pS = null;  // last-written player style values
  const fallingTimers = new Map();      // entity -> timeout id

  /* ── static UI refs (resolved once) ── */
  const stage = document.getElementById("stage");
  const stageFrame = document.getElementById("stage-frame");
  const hintbar = document.getElementById("hintbar");
  const hintText = document.getElementById("hintText");
  const hintCost = document.getElementById("hintCost");
  const hintBtn = document.getElementById("hintBtn");
  const levelStrip = document.getElementById("levelStrip");
  const loseOverlay = document.getElementById("loseOverlay");
  const loseReason = document.getElementById("loseReason");
  const winOverlay = document.getElementById("winOverlay");
  const hud = {
    speed: document.getElementById("rSpeed"),
    jump: document.getElementById("rJump"),
    size: document.getElementById("rSize"),
    coins: document.getElementById("rCoins"),
    health: document.getElementById("rHealth"),
    bar: document.getElementById("healthBar"),
  };
  let lastHud = { speed: "", jump: "", size: "", coins: "", health: "" };

  /* ═══════════ hint purchase system (unchanged behaviour) ═══════════ */
  hintBtn.addEventListener("click", function () {
    if (hintRevealed) return;
    const l = LEVELS[currentLevelIndex];
    const cost = l.hintCost || 20;
    const gs = window.gameState;
    if (gs.coins < cost) return;
    gs.coins -= cost;
    hintRevealed = true;
    hintsUnlocked[currentLevelIndex] = true;
    hintText.textContent = l.hint;
    hintCost.textContent = "";
    hintBtn.disabled = true;
    hintBtn.textContent = "Hint Unlocked!";
    showToast("💡 Hint unlocked! (-" + cost + " coins)");
  });

  function showToast(msg) {
    const t = document.createElement("div");
    t.className = "hint-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  let hintsUnlocked = {};
  let hintRevealed = false;

  function updateHintBar() {
    const l = LEVELS[currentLevelIndex];
    if (hintsUnlocked[currentLevelIndex]) {
      hintRevealed = true;
      hintText.textContent = l.hint;
      hintCost.textContent = "";
      hintBtn.disabled = true;
      hintBtn.textContent = "Unlocked ✓";
    } else {
      hintRevealed = false;
      const cost = l.hintCost || 20;
      const gs = window.gameState;
      hintText.textContent = "🔒 Hint locked — spend " + cost + " coins to reveal";
      hintCost.textContent = "Need: " + cost + " | Have: " + gs.coins;
      hintBtn.disabled = gs.coins < cost;
      hintBtn.textContent = "Buy Hint (" + cost + ")";
    }
  }

  function buildLevelStrip() {
    levelStrip.innerHTML = "";
    LEVELS.forEach((l, i) => {
      const d = document.createElement("div");
      d.className = "level-dot";
      if (i === currentLevelIndex) d.classList.add("active");
      else if (i < currentLevelIndex) d.classList.add("done");
      else if (i > currentLevelIndex) d.classList.add("locked");

      const parts = l.name.split(" // ");
      const worldNum = parts[0].split("-")[0];
      const lvlNum = parts[0].split("-")[1];

      const worldSpan = document.createElement("span");
      worldSpan.className = "world-label";
      worldSpan.textContent = worldNum;

      const numSpan = document.createElement("span");
      numSpan.className = "level-num";
      numSpan.textContent = lvlNum;

      d.appendChild(worldSpan);
      d.appendChild(numSpan);
      levelStrip.appendChild(d);

      if (i === currentLevelIndex) {
        setTimeout(() => {
          d.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }, 50);
      }
    });
  }

  function el(cls, styleObj) {
    const d = document.createElement("div");
    d.className = cls;
    if (styleObj) Object.assign(d.style, styleObj);
    return d;
  }

  /* ═══════════ pixel-art hero sprite ═══════════ */
  const SPRITE_W = 14, SPRITE_H = 21;
  const SPRITE_PAL = {
    H: "#e52521", S: "#fcbcb0", K: "#16161a", B: "#049cd8",
    Y: "#ffcf3f", C: "#e52521", F: "#8a5320", f: "#5c360f",
  };
  const SPRITE_BODY = [
    "................",
    "...HHHHHHHH...",
    "...HHHHHHHH...",
    "...HHHHHHHH...",
    "..HHHHHHHHHH..",
    "...SSSSSSSS...",
    "...SKKSSKKS...",
    "...SSSSSSSS...",
    "...CCCCCCCC...",
    ".CCCCCCCCCCCC.",
    ".SCCCCCCCCCCS.",
    ".CCCCCCCCCCCC.",
    "..CBBBBBBBBC..",
    "..CBBYBBBYBC..",
    "..CBBBBBBBBC..",
    "..BBBBBBBBBB..",
  ];
  const SPRITES = {
    idle: SPRITE_BODY.concat([
      "...BBBBBBBB...",
      "...BBBBBBBB...",
      "...BBBBBBBB...",
      "..FFFF..FFFF..",
      "..ffff..ffff..",
    ]),
    walkA: SPRITE_BODY.concat([
      "...BBBBBBBB...",
      "....FFFFBBB...",
      "....ffffBBB...",
      "........FFFF..",
      "........ffff..",
    ]),
    walkB: SPRITE_BODY.concat([
      "...BBBBBBBB...",
      "...BBBFFFF...",
      "...BBBffff...",
      "....FFFF......",
      "....ffff......",
    ]),
    jump: SPRITE_BODY.concat([
      "...BBBBBBBB...",
      "..FFFF..FFFF..",
      "..ffff..ffff..",
      "................",
      "................",
    ]),
  };

  function drawPlayerSprite(ctx, rows, flip) {
    if (!ctx) return;
    ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
    ctx.save();
    if (flip) { ctx.translate(SPRITE_W, 0); ctx.scale(-1, 1); }
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const color = SPRITE_PAL[row[x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();
  }

  /* ═══════════ small FX ═══════════ */
  function spawnPuff(x, y, n, kind) {
    const colors =
      kind === "coin" ? ["#fff6c8", "#ffd23e", "#ff9d1f", "#ffffff"] :
      kind === "jump" ? ["#f2e3cb", "#d9bc93", "#b68c5c"] :
                         ["#efe4cf", "#cfc0a4", "#a89a80"];
    const reach = kind === "coin" ? 30 : kind === "dust" ? 16 : 22;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.className = "fxp";
      const ang = Math.random() * Math.PI * 2;
      const dist = reach * (0.45 + Math.random() * 0.9);
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist * 0.6 - (kind === "dust" ? 2 : 8);
      const size = kind === "coin" ? 2 + Math.random() * 3 : 2 + Math.random() * 2;
      p.style.setProperty("--dx", dx.toFixed(1) + "px");
      p.style.setProperty("--dy", dy.toFixed(1) + "px");
      p.style.width = p.style.height = size.toFixed(1) + "px";
      p.style.left = (x - size / 2) + "px";
      p.style.top = (y - size / 2) + "px";
      p.style.background = colors[(Math.random() * colors.length) | 0];
      p.style.animationDuration = (320 + Math.random() * 380).toFixed(0) + "ms";
      stage.appendChild(p);
      setTimeout(() => p.remove(), 1300);
    }
  }

  function damageFx() {
    if (playerEl) {
      playerEl.classList.add("hurt");
      setTimeout(() => playerEl.classList.remove("hurt"), 160);
    }
    stageFrame.classList.remove("shake");
    void stageFrame.offsetWidth;
    stageFrame.classList.add("shake");
    setTimeout(() => stageFrame.classList.remove("shake"), 330);
  }

  /* ═══════════ background decor ═══════════ */
  function addDecorations(dark) {
    if (dark) {
      const moon = document.createElement("div");
      moon.className = "deco-moon";
      stage.appendChild(moon);
    }
    const hills = [
      { left: 50, w: 160, h: 70, color: dark ? "#1a3a1a" : "#3a8c3a" },
      { left: 300, w: 120, h: 50, color: dark ? "#153015" : "#2d7a2d" },
      { left: 600, w: 180, h: 80, color: dark ? "#1a3a1a" : "#3a8c3a" },
      { left: 800, w: 100, h: 45, color: dark ? "#153015" : "#2d7a2d" },
    ];
    hills.forEach(h => {
      const d = el("deco-hill", {
        left: h.left + "px", width: h.w + "px",
        height: h.h + "px", background: h.color,
      });
      stage.appendChild(d);
    });
    const bushes = [
      { left: 160, w: 70, h: 25 },
      { left: 440, w: 90, h: 30 },
      { left: 720, w: 60, h: 22 },
    ];
    bushes.forEach(b => {
      const d = el("deco-bush", { left: b.left + "px" });
      const inner = document.createElement("div");
      inner.style.width = b.w + "px";
      inner.style.height = b.h + "px";
      d.appendChild(inner);
      stage.appendChild(d);
    });
  }

  /* ═══════════ level loading — builds DOM once and caches entities ═══════════ */
  function loadLevel(i) {
    currentLevelIndex = i;
    lvl = LEVELS[i];
    stage.innerHTML = "";
    collectedThisLevel = [];
    for (const t of fallingTimers.values()) clearTimeout(t);
    fallingTimers.clear();

    window.gameState = freshState();
    if (lvl.speedLock) window.gameState.speed = lvl.speedLock;
    if (lvl.healthLock) window.gameState.health = lvl.healthLock;

    px = 40;
    py = GROUND_Y - PLAYER_H;
    vx = 0; vy = 0;
    onGround = true;
    loseOverlay.classList.remove("show");
    stageFrame.classList.toggle("dark", !!lvl.dark);

    addDecorations(!!lvl.dark);

    ent = {
      platforms: lvl.platforms,
      spikes: lvl.spikes || [],
      conveyors: lvl.conveyors || [],
      tunnels: [lvl.tunnel, lvl.tunnel2].filter(Boolean),
      movingPlatforms: [],
      fallingBlocks: [],
      invisibles: [],
      movingSpikes: [],
      spikeBalls: [],
      fireBars: [],
      gates: [],
      coins: [],
      goal: lvl.goal,
    };

    // platforms (static — data only)
    lvl.platforms.forEach(p => {
      stage.appendChild(el("platform", {
        left: p.x + "px", top: p.y + "px",
        width: p.w + "px", height: p.h + "px",
      }));
    });

    // moving platforms
    (lvl.movingPlatforms || []).forEach((mp, idx) => {
      const d = el("moving-platform", {
        left: mp.x + "px", top: mp.y + "px",
        width: mp.w + "px", height: mp.h + "px",
      });
      d.dataset.idx = idx;
      d.dataset.baseX = mp.x;
      d.dataset.moveX = mp.moveX;
      d.dataset.speed = mp.speed;
      stage.appendChild(d);
      ent.movingPlatforms.push({
        el: d, baseX: mp.x, moveX: mp.moveX, speed: mp.speed,
        y: mp.y, w: mp.w, h: mp.h,
      });
    });

    // falling blocks (crumble platforms)
    (lvl.fallingBlocks || []).forEach((fb, idx) => {
      const d = el("falling-block", {
        left: fb.x + "px", top: fb.y + "px",
        width: fb.w + "px", height: fb.h + "px",
      });
      d.dataset.idx = idx;
      d.dataset.delay = fb.delay;
      d.dataset.fallen = "false";
      stage.appendChild(d);
      ent.fallingBlocks.push({
        el: d, x: fb.x, y: fb.y, w: fb.w, h: fb.h, delay: fb.delay,
        fallen: false,
      });
    });

    // conveyors
    (lvl.conveyors || []).forEach((c, idx) => {
      const d = el("conveyor" + (c.dir === "left" ? " left" : ""), {
        left: c.x + "px", top: c.y + "px",
        width: c.w + "px", height: c.h + "px",
      });
      d.dataset.idx = idx;
      stage.appendChild(d);
    });

    // invisible platforms
    (lvl.invisiblePlatforms || []).forEach((ip, idx) => {
      const d = el("invisible-platform", {
        left: ip.x + "px", top: ip.y + "px",
        width: ip.w + "px", height: ip.h + "px",
      });
      d.dataset.idx = idx;
      d.dataset.revealed = "false";
      stage.appendChild(d);
      ent.invisibles.push({ el: d, x: ip.x, y: ip.y, w: ip.w, h: ip.h, revealed: false });
    });

    // static spikes
    (lvl.spikes || []).forEach(s => {
      stage.appendChild(el("spike", {
        left: s.x + "px", top: s.y + "px",
        width: s.w + "px", height: s.h + "px",
      }));
    });

    // moving spikes
    (lvl.movingSpikes || []).forEach((s, idx) => {
      const d = el("spike", {
        left: s.baseX + "px", top: s.y + "px",
        width: s.w + "px", height: s.h + "px",
      });
      d.dataset.idx = idx;
      stage.appendChild(d);
      ent.movingSpikes.push({
        el: d, baseX: s.baseX, range: s.range, speedMul: s.speedMul,
        y: s.y, w: s.w, h: s.h,
      });
    });

    // spike balls
    (lvl.spikeBalls || []).forEach((sb, idx) => {
      const d = el("spike-ball", { left: sb.baseX + "px", top: sb.y + "px" });
      d.dataset.idx = idx;
      stage.appendChild(d);
      ent.spikeBalls.push({
        el: d, baseX: sb.baseX, range: sb.range, speed: sb.speed,
        phase: sb.phase || 0, y: sb.y, w: sb.w, h: sb.h,
      });
    });

    // fire bars
    (lvl.fireBars || []).forEach((fb, idx) => {
      const container = el("fire-bar", {
        left: fb.x + "px", top: fb.y + "px",
        position: "absolute", width: "0", height: "0",
      });
      container.dataset.idx = idx;
      container.dataset.armLen = fb.armLen;
      container.dataset.speed = fb.speed;

      const pivot = el("fire-bar-pivot", {});
      container.appendChild(pivot);

      const arm = el("fire-bar-arm", { width: fb.armLen + "px" });
      container.appendChild(arm);
      stage.appendChild(container);

      ent.fireBars.push({
        container: container, arm: arm, x: fb.x, y: fb.y,
        armLen: fb.armLen, speed: fb.speed,
      });
    });

    // coins
    (lvl.coins || []).forEach((c, idx) => {
      const d = el("coin", { left: c.x + "px", top: c.y + "px" });
      d.dataset.idx = idx;
      stage.appendChild(d);
      ent.coins.push({ el: d, x: c.x, y: c.y, collected: false });
    });

    // tunnel(s)
    [lvl.tunnel, lvl.tunnel2].forEach(t => {
      if (!t) return;
      stage.appendChild(el("tunnel-block", {
        left: t.x + "px", width: t.w + "px", height: t.openingTop + "px",
      }));
    });

    // gates
    function addGate(g) {
      if (!g) return;
      const gateEl = el("gate", {
        left: g.x + "px", top: "0px",
        width: g.w + "px", height: GROUND_Y + "px",
      });
      gateEl.dataset.required = g.required;
      const label = el("gate-label", {});
      label.textContent = "requires " + g.required;
      gateEl.appendChild(label);
      stage.appendChild(gateEl);
      ent.gates.push({ el: gateEl, x: g.x, w: g.w, required: g.required });
    }
    addGate(lvl.gate);
    addGate(lvl.gate2);
    addGate(lvl.gate3);

    // goal
    stage.appendChild(el("goal", {
      left: lvl.goal.x + "px", top: "0px", height: GROUND_Y + "px",
    }));

    // player — crisp low-res canvas sprite
    playerEl = el("", { left: px + "px", top: py + "px" });
    playerEl.id = "player";
    const cv = document.createElement("canvas");
    cv.width = SPRITE_W;
    cv.height = SPRITE_H;
    cv.className = "pix";
    playerEl.appendChild(cv);
    playerCtx = cv.getContext("2d");
    playerCtx.imageSmoothingEnabled = false;
    facing = 1;
    spriteDrawn = "";
    drawPlayerSprite(playerCtx, SPRITES.idle, false);
    stage.appendChild(playerEl);

    buildLevelStrip();
    updateHintBar();
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /* ═══════════ overlays ═══════════ */
  function loseLevel(reason) {
    loseReason.textContent = reason;
    loseOverlay.classList.add("show");
    running = false;
  }

  function winGame() {
    winOverlay.classList.add("show");
    running = false;
  }

  /* ═══════════ input ═══════════ */
  document.addEventListener("keydown", e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === " ") e.preventDefault();
    if (e.key.toLowerCase() === "r") {
      loadLevel(currentLevelIndex);
      running = true;
    }
  });
  document.addEventListener("keyup", e => { keys[e.key.toLowerCase()] = false; });

  document.getElementById("retryBtn").addEventListener("click", () => {
    loadLevel(currentLevelIndex); running = true;
  });
  document.getElementById("playAgainBtn").addEventListener("click", () => {
    winOverlay.classList.remove("show"); loadLevel(0); running = true;
  });
  document.getElementById("openManual").addEventListener("click", () =>
    document.getElementById("manualBackdrop").classList.add("show"));
  document.getElementById("closeManual").addEventListener("click", () =>
    document.getElementById("manualBackdrop").classList.remove("show"));
  document.getElementById("manualBackdrop").addEventListener("click", e => {
    if (e.target.id === "manualBackdrop") e.currentTarget.classList.remove("show");
  });

  /* ═══════════ main loop ═══════════ */
  let t = 0;
  function tick() {
    requestAnimationFrame(tick);
    if (!running) return;
    t += 1;
    const gs = window.gameState;
    const wasGrounded = onGround;

    const w = PLAYER_W * gs.size;
    const h = PLAYER_H * gs.size;

    // ── horizontal movement ──
    vx = 0;
    if (keys["arrowleft"] || keys["a"]) vx = -gs.speed;
    if (keys["arrowright"] || keys["d"]) vx = gs.speed;

    for (let ci = 0; ci < ent.conveyors.length; ci++) {
      const c = ent.conveyors[ci];
      if (px + w > c.x && px < c.x + c.w && py + h > c.y && py < c.y + c.h + 20) {
        vx += c.dir === "right" ? c.force : -c.force;
      }
    }

    // tunnels
    let blockedByTunnel = false;
    for (let ti = 0; ti < ent.tunnels.length; ti++) {
      const tb = ent.tunnels[ti];
      const nextX = px + vx;
      if (nextX + w > tb.x && nextX < tb.x + tb.w && py < tb.openingTop - 2) {
        blockedByTunnel = true;
        break;
      }
    }
    if (!blockedByTunnel) px += vx;
    px = Math.max(0, Math.min(STAGE_W - w, px));

    // ── jump ──
    if ((keys[" "] || keys["arrowup"] || keys["w"]) && onGround) {
      vy = -gs.jumpPower;
      onGround = false;
      spawnPuff(px + w / 2, py + h, 5, "jump");
    }

    vy += GRAVITY;
    py += vy;

    // ── platform collisions ──
    onGround = false;
    let onAnyPlatform = false;

    for (let pi = 0; pi < ent.platforms.length; pi++) {
      const p = ent.platforms[pi];
      if (px + w > p.x && px < p.x + p.w &&
          py + h >= p.y && py + h <= p.y + 24 && vy >= 0) {
        py = p.y - h; vy = 0; onGround = true; onAnyPlatform = true;
      }
    }

    for (let mi = 0; mi < ent.movingPlatforms.length; mi++) {
      const mp = ent.movingPlatforms[mi];
      const newX = mp.baseX + Math.sin(t * 0.03 * mp.speed) * (mp.moveX / 2);
      mp.el.style.left = newX + "px";
      if (px + w > newX && px < newX + mp.w &&
          py + h >= mp.y && py + h <= mp.y + mp.h + 12 && vy >= 0) {
        py = mp.y - h; vy = 0; onGround = true; onAnyPlatform = true;
        px += Math.cos(t * 0.03 * mp.speed) * mp.speed * 0.3;
      }
    }

    for (let fi = 0; fi < ent.fallingBlocks.length; fi++) {
      const fb = ent.fallingBlocks[fi];
      if (fb.fallen) continue;
      if (px + w > fb.x && px < fb.x + fb.w &&
          py + h >= fb.y && py + h <= fb.y + fb.h + 12 && vy >= 0) {
        py = fb.y - h; vy = 0; onGround = true; onAnyPlatform = true;
        if (!fallingTimers.has(fb)) {
          fallingTimers.set(fb, setTimeout(() => {
            fb.el.classList.add("crumbled");
            fb.el.dataset.fallen = "true";
            fb.fallen = true;
            fallingTimers.delete(fb);
          }, fb.delay));
        }
      }
    }

    for (let ii = 0; ii < ent.invisibles.length; ii++) {
      const ip = ent.invisibles[ii];
      const dist = Math.abs(px + w / 2 - (ip.x + ip.w / 2)) +
                   Math.abs(py + h / 2 - (ip.y + ip.h / 2));
      if (dist < 80 && !ip.revealed) {
        ip.el.classList.add("revealed");
        ip.el.dataset.revealed = "true";
        ip.revealed = true;
      }
      if (ip.revealed &&
          px + w > ip.x && px < ip.x + ip.w &&
          py + h >= ip.y && py + h <= ip.y + ip.h + 12 && vy >= 0) {
        py = ip.y - h; vy = 0; onGround = true; onAnyPlatform = true;
      }
    }

    // landing dust
    if (!wasGrounded && onGround) {
      spawnPuff(px + w / 2, py + h, 6, "dust");
    }

    if (!onAnyPlatform && py > STAGE_H + 60) {
      loseLevel("You fell into the gap. That distance was not meant to be crossed at default settings.");
      return;
    }

    // ── hazards ──
    for (let si = 0; si < ent.spikes.length; si++) {
      const s = ent.spikes[si];
      if (px + w > s.x && px < s.x + s.w &&
          py + h > s.y && py < s.y + s.h) {
        gs.health -= 100;
        damageFx();
      }
    }

    for (let mi = 0; mi < ent.movingSpikes.length; mi++) {
      const s = ent.movingSpikes[mi];
      const cx = s.baseX + (s.range / 2) * Math.sin(t * 0.02 * s.speedMul);
      s.el.style.left = cx + "px";
      if (px + w > cx && px < cx + s.w &&
          py + h > s.y && py < s.y + s.h) {
        if (hurtCooldown <= 0) {
          gs.health -= 34; hurtCooldown = 40;
          damageFx();
        }
      }
    }

    for (let bi = 0; bi < ent.spikeBalls.length; bi++) {
      const sb = ent.spikeBalls[bi];
      const cx = sb.baseX + (sb.range / 2) * Math.sin(t * 0.025 * sb.speed + sb.phase);
      sb.el.style.left = cx + "px";
      if (px + w > cx && px < cx + sb.w &&
          py + h > sb.y && py < sb.y + sb.h) {
        if (hurtCooldown <= 0) {
          gs.health -= 50; hurtCooldown = 50;
          damageFx();
        }
      }
    }

    for (let fi = 0; fi < ent.fireBars.length; fi++) {
      const fb = ent.fireBars[fi];
      const angle = t * 0.03 * fb.speed;
      fb.arm.style.transform = "rotate(" + (angle * (180 / Math.PI)) + "deg)";
      const steps = 5;
      for (let s2 = 1; s2 <= steps; s2++) {
        const frac = s2 / steps;
        const hitX = fb.x + Math.cos(angle) * fb.armLen * frac;
        const hitY = fb.y + Math.sin(angle) * fb.armLen * frac;
        if (px + w > hitX - 6 && px < hitX + 6 &&
            py + h > hitY - 6 && py < hitY + 6) {
          if (hurtCooldown <= 0) {
            gs.health -= 40; hurtCooldown = 45;
            damageFx();
          }
          break;
        }
      }
    }

    if (hurtCooldown > 0) hurtCooldown--;

    if (gs.health <= 0) {
      loseLevel("Health hit zero.");
      return;
    }

    // ── coins ──
    for (let ci = 0; ci < ent.coins.length; ci++) {
      const c = ent.coins[ci];
      if (c.collected) continue;
      if (px + w > c.x && px < c.x + 16 &&
          py + h > c.y && py < c.y + 16) {
        c.collected = true;
        gs.coins += 10;
        c.el.style.display = "none";
        spawnPuff(c.x + 10, c.y + 12, 10, "coin");
        updateHintBar();
      }
    }

    // ── gates (data-required stays live & editable — read each frame) ──
    let blockedByGate = false;
    let firstLocked = null;
    for (let gi = 0; gi < ent.gates.length; gi++) {
      const g = ent.gates[gi];
      const required = parseInt(g.el.dataset.required, 10) || 0;
      const unlocked = gs.coins >= required;
      g.el.classList.toggle("unlocked", unlocked);
      if (!unlocked) {
        if (firstLocked === null) firstLocked = g;
        if (px + w > g.x && px < g.x + g.w && vx > 0) blockedByGate = true;
      }
    }
    if (blockedByGate && firstLocked) px = firstLocked.x - w;

    // ── goal ──
    if (px >= ent.goal.x - 10) {
      if (currentLevelIndex + 1 < LEVELS.length) {
        loadLevel(currentLevelIndex + 1);
      } else {
        winGame();
      }
      return;
    }

    // ── render player (write only when values change) ──
    if (px !== pX) { pX = px; playerEl.style.left = px + "px"; }
    if (py !== pY) { pY = py; playerEl.style.top = py + "px"; }
    if (gs.size !== pS) {
      pS = gs.size;
      playerEl.style.transform = "scale(" + gs.size + ")";
      playerEl.style.transformOrigin = "bottom center";
    }

    if (vx < 0) facing = -1; else if (vx > 0) facing = 1;
    let spriteName;
    if (!onGround) spriteName = "jump";
    else if (Math.abs(vx) > 0.05) {
      spriteName = (Math.floor(t / 5) % 2 === 0) ? "walkA" : "walkB";
    } else spriteName = "idle";
    const key = spriteName + (facing < 0 ? "L" : "R");
    if (key !== spriteDrawn) {
      spriteDrawn = key;
      drawPlayerSprite(playerCtx, SPRITES[spriteName], facing < 0);
    }

    // ── HUD (write only on change) ──
    const speedTxt = gs.speed.toFixed(1);
    const jumpTxt = gs.jumpPower.toFixed(1);
    const sizeTxt = gs.size.toFixed(2);
    const coinsTxt = String(gs.coins);
    const hp = Math.max(0, gs.health);
    const hpTxt = String(hp);

    if (speedTxt !== lastHud.speed) { lastHud.speed = speedTxt; hud.speed.textContent = speedTxt; }
    if (jumpTxt !== lastHud.jump) { lastHud.jump = jumpTxt; hud.jump.textContent = jumpTxt; }
    if (sizeTxt !== lastHud.size) { lastHud.size = sizeTxt; hud.size.textContent = sizeTxt; }
    if (coinsTxt !== lastHud.coins) { lastHud.coins = coinsTxt; hud.coins.textContent = coinsTxt; }
    if (hpTxt !== lastHud.health) {
      lastHud.health = hpTxt;
      hud.health.textContent = hpTxt;
      hud.bar.style.width = Math.min(100, hp) + "%";
      hud.bar.style.background =
        hp > 55 ? "linear-gradient(180deg,#7cff8a,#1fc93b)" :
        hp > 25 ? "linear-gradient(180deg,#ffe95c,#e9a400)" :
                  "linear-gradient(180deg,#ff9d7a,#e0241d)";
      hud.bar.classList.toggle("low", hp <= 25);
    }

    if (coinsTxt !== lastHud.coinsCheck) {
      lastHud.coinsCheck = coinsTxt;
      if (!hintRevealed) updateHintBar();
    }
  }

  loadLevel(0);
  requestAnimationFrame(tick);
})();
