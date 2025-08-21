// main.js – Core game logic for AI world generator v6+ with enriched quests and dialogues

// Import generated data. These JSON files are created by the generation pipeline
// Each import uses the "assert" syntax to ensure the file is parsed as JSON.
// Data placeholders. These will be populated at runtime by loadGameData().
let worldSpec = {};
let dialoguesData = { dialogues: [] };
let abilitiesData = { abilities: [] };
let statusData = { status_effects: [] };
let inventoryData = { items: [] };
let eventsData = { events: [] };
let questsData = { quests: [] };

/**
 * Load all JSON game data from the data directory via fetch. This avoids
 * relying on experimental JSON module imports which may not be supported
 * in all browsers. Returns a promise that resolves when all data is loaded.
 */
async function loadGameData() {
  const files = {
    worldSpec: 'world_spec.json',
    dialoguesData: 'dialogue.json',
    abilitiesData: 'abilities.json',
    statusData: 'status_effects.json',
    inventoryData: 'inventory.json',
    eventsData: 'events.json',
    questsData: 'quests.json'
  };
  const base = './data/';
  // Load each file via fetch and assign to respective variable
  await Promise.all(Object.entries(files).map(async ([key, file]) => {
    try {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`Failed to fetch ${file}`);
      const json = await res.json();
      // Assign to module-scoped variable
      switch (key) {
        case 'worldSpec': worldSpec = json; break;
        case 'dialoguesData': dialoguesData = json; break;
        case 'abilitiesData': abilitiesData = json; break;
        case 'statusData': statusData = json; break;
        case 'inventoryData': inventoryData = json; break;
        case 'eventsData': eventsData = json; break;
        case 'questsData': questsData = json; break;
      }
    } catch (err) {
      console.error('Error loading', file, err);
    }
  }));

  // Ensure that every dialogue node has a speaker. Some models omit the
  // `speaker` field on player lines, which breaks code that expects a
  // string. To preserve the previous behaviour where every node had a
  // speaker, assign "player" if missing. This also keeps the earlier
  // logic of distinguishing player vs NPC dialogue intact.
  function ensureDialoguesHaveSpeaker() {
    if (!dialoguesData || !Array.isArray(dialoguesData.dialogues)) return;
    dialoguesData.dialogues.forEach(dlg => {
      if (dlg && Array.isArray(dlg.nodes)) {
        dlg.nodes.forEach(node => {
          if (!node.speaker) {
            node.speaker = 'player';
          }
        });
      }
    });
  }
  ensureDialoguesHaveSpeaker();
}

// Global game state. Nearly all mutable state lives in this object so it can be
// easily saved/restored and inspected. Many fields are initialised in initGame().
const G = {
  // Canvas and drawing context
  canvas: null,
  ctx: null,
  DPR: 1,
  screen: { w: 0, h: 0, safeBottom: 0 },
  // Player state
  player: {
    x: 0,
    y: 0,
    baseSpeed: 120,
    speed: 120,
    vx: 0,
    vy: 0,
    hp: 100,
    maxHp: 100,
    gold: 50,
    level: 1,
    exp: 0,
    skills: { charisma: 0.5, strength: 0.5, agility: 0.5 },
    equipped: { weapon: null, armour: null },
    inventory: [],
    abilities: [],
    abilityCooldown: {},
  },
  // World data
  zones: [],
  npcs: [],
  objects: [], // spawnable quest items (collectible on map)
  statusEffects: [], // active status effects on player
  messages: [], // transient UI messages
  questsState: [],
  // UI state
  openOverlay: null, // 'quests', 'inventory', 'status', 'shop'
  talk: null, // current talk state { npcId, dialogueIndex, currentNode }
  // Buttons definitions for overlay and bottom bar
  buttons: [],
  uiZones: { overlay: [], talk: [] },

  // Buildings and interiors
  buildings: [],
  interiors: [],
  obstacles: [],
  inInterior: false,
  currentInterior: null,
  // Track previous player position when entering a building to restore on exit
  previousPosition: { x: 0, y: 0 },
};

/**
 * Initialise the game by setting up canvas, loading data, constructing
 * world and player state and hooking input and resize listeners.
 */
function initGame() {
  // Set up canvas and context
  G.canvas = document.getElementById('game');
  G.ctx = G.canvas.getContext('2d');
  // Determine device pixel ratio for crisp scaling on high DPI displays
  G.DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  // Resize canvas to full window
  resizeCanvas();
  // Hook global event listeners
  window.addEventListener('resize', resizeCanvas, { passive: true });
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });
  G.canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  // Initialise world zones and NPCs
  initZones();
  initNPCs();
  // Initialise quests state and assign quest steps to NPCs
  initQuestsState();
  // Initialise player abilities (assign first few abilities to keys)
  initPlayerAbilities();
  // Initialise inventory with any starting items
  G.player.inventory = [];
  // Spawn items for any quests already in progress (none at start)
  // Start the main loop
  let last = performance.now();
  function loop(ts) {
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

/** Resize the canvas to match the window size and recompute UI layout. */
function resizeCanvas() {
  G.screen.w = window.innerWidth;
  G.screen.h = window.innerHeight;
  G.canvas.width = (G.screen.w * G.DPR) | 0;
  G.canvas.height = (G.screen.h * G.DPR) | 0;
  G.ctx.setTransform(G.DPR, 0, 0, G.DPR, 0, 0);
  // Compute safe bottom area for bottom buttons (two rows of 64px + padding)
  const rowH = 64;
  const pad = 10;
  const rows = 2;
  G.screen.safeBottom = rows * rowH + (rows + 1) * pad;
  // Recompute UI buttons on resize
  defineButtons();
}

/** Initialise world zones from loaded worldSpec. Zones are drawn as tinted
 * vertical slices to give a sense of place. */
function initZones() {
  G.zones = worldSpec.zones || [];
  // Compute each zone's x position and width based on number of zones
  const count = G.zones.length;
  const w = G.screen.w;
  G.zones.forEach((z, i) => {
    z.x = (w / count) * i;
    z.width = w / count;
  });
}

/** Initialise NPCs by mapping dialogues to NPC objects and assigning them
 * random skills and wandering behaviour inside their home zone. */
function initNPCs() {
  G.npcs = [];
  const dialogues = dialoguesData.dialogues || [];
  const zoneCount = G.zones.length || 1;
  dialogues.forEach((dlg, idx) => {
    // Determine NPC id: use first non-player speaker or fallback to NPC_<index>
    let npcId = `npc_${idx + 1}`;
    if (dlg.nodes && dlg.nodes.length > 0) {
      const speaker = dlg.nodes[0].speaker || '';
      if (speaker.toLowerCase() !== 'player') {
        npcId = speaker;
      }
    }
    // Assign NPC to a zone cyclically
    const zoneIndex = idx % zoneCount;
    const zone = G.zones[zoneIndex];
    // Random position within zone
    const x = zone.x + zone.width * 0.5;
    const y = G.screen.h * 0.4 + Math.random() * G.screen.h * 0.1;
    // Assign a random skill and difficulty for skill checks
    const skills = ['charisma', 'strength', 'agility'];
    const skill = skills[Math.floor(Math.random() * skills.length)];
    const difficulty = 0.4 + Math.random() * 0.4; // 0.4–0.8
    G.npcs.push({
      id: npcId,
      dialogueIndex: idx,
      x,
      y,
      zoneIndex,
      color: `hsl(${(idx * 60) % 360},60%,55%)`,
      skill,
      difficulty,
      dx: 0,
      dy: 0,
    });
  });

  // After creating NPCs, initialise buildings and obstacles for exploration
  initBuildings();
  initObstacles();
}

/** Initialise quests state by creating an array of quests with progress
 * tracking and assigning each step to an NPC. */
function initQuestsState() {
  G.questsState = [];
  const quests = questsData.quests || [];
  const npcCount = G.npcs.length;
  quests.forEach((q, qIndex) => {
    const qs = {
      id: q.id,
      title: q.title,
      is_main: q.is_main,
      steps: q.steps,
      status: 'not-started',
      currentStep: 0,
      // stepAssignments: array mapping step index -> npcId
      stepAssignments: [],
    };
    q.steps.forEach((step, i) => {
      const npc = G.npcs[(qIndex + i) % npcCount];
      qs.stepAssignments.push(npc.id);
    });
    G.questsState.push(qs);
  });
}

/** Initialise player abilities by assigning the first few abilities from
 * abilitiesData to the player's hotkeys (keys 1–5). */
function initPlayerAbilities() {
  G.player.abilities = [];
  G.player.abilityCooldown = {};
  const list = abilitiesData.abilities || [];
  const slots = Math.min(5, list.length);
  for (let i = 0; i < slots; i++) {
    const ab = list[i];
    G.player.abilities.push(ab);
    G.player.abilityCooldown[ab.id] = 0;
  }
}

/**
 * Initialise buildings for each NPC and corresponding interiors. Each NPC gets a
 * small house in their home zone with a door. Interiors are simple rooms
 * containing the NPC and an exit door. Buildings encourage exploration and
 * provide a space to talk to NPCs privately.
 */
function initBuildings() {
  G.buildings = [];
  G.interiors = [];
  const usedPositions = {};
  G.npcs.forEach((npc, idx) => {
    const zone = G.zones[npc.zoneIndex];
    if (!zone) return;
    // Determine building size relative to zone
    const bw = Math.max(80, zone.width * 0.25);
    const bh = Math.max(80, G.screen.h * 0.15);
    // Place building at random horizontal offset in zone without overlap
    let bx;
    const attempts = 10;
    for (let a = 0; a < attempts; a++) {
      const candidateX = zone.x + 30 + Math.random() * (zone.width - bw - 60);
      const key = `${npc.zoneIndex}-${Math.floor(candidateX / 50)}`;
      if (!usedPositions[key]) {
        bx = candidateX;
        usedPositions[key] = true;
        break;
      }
    }
    if (bx === undefined) {
      bx = zone.x + (zone.width - bw) / 2;
    }
    // Vertical position: random within upper part of zone
    const by = 120 + Math.random() * (G.screen.h - G.screen.safeBottom - bh - 180);
    const doorX = bx + bw / 2;
    const doorY = by + bh;
    G.buildings.push({
      id: `building_${idx}`,
      npcId: npc.id,
      zoneIndex: npc.zoneIndex,
      x: bx,
      y: by,
      width: bw,
      height: bh,
      doorX,
      doorY,
    });
    // Create interior room for this building
    const intW = Math.min(G.screen.w - 100, 600);
    const intH = Math.min(G.screen.h - G.screen.safeBottom - 100, 400);
    // Interior coordinates are relative to the center of the screen; we'll translate when drawing
    const interior = {
      id: `interior_${idx}`,
      npcId: npc.id,
      width: intW,
      height: intH,
      // Relative positions: door at bottom center, spawn slightly above bottom, occupant near top
      doorX: 0,
      doorY: intH / 2 - 20,
      spawnX: 0,
      spawnY: intH / 2 - 60,
      npc: {
        id: npc.id,
        dialogueIndex: npc.dialogueIndex,
        x: 0,
        y: -intH * 0.25,
        color: npc.color,
        skill: npc.skill,
        difficulty: npc.difficulty,
        dx: 0,
        dy: 0,
      },
    };
    G.interiors.push(interior);
  });
}

/**
 * Initialise a handful of random obstacles in each zone. Obstacles are
 * rectangular areas the player cannot pass through. They break up open
 * space and encourage exploration.
 */
function initObstacles() {
  G.obstacles = [];
  const obstacleCountPerZone = 3;
  G.zones.forEach((zone, zi) => {
    for (let i = 0; i < obstacleCountPerZone; i++) {
      const w = 40 + Math.random() * 80;
      const h = 40 + Math.random() * 80;
      const ox = zone.x + 30 + Math.random() * (zone.width - w - 60);
      const oy = 140 + Math.random() * (G.screen.h - G.screen.safeBottom - h - 200);
      G.obstacles.push({ zoneIndex: zi, x: ox, y: oy, width: w, height: h });
    }
  });
}

/** Draw all buildings as rectangles with a visible door. */
function drawBuildings(ctx) {
  G.buildings.forEach(b => {
    ctx.fillStyle = '#242539';
    ctx.fillRect(b.x, b.y, b.width, b.height);
    // Door as a small rectangle on bottom edge
    const dw = b.width * 0.2;
    const dh = 10;
    const dx = b.doorX - dw / 2;
    const dy = b.doorY - dh;
    ctx.fillStyle = '#6b6f80';
    ctx.fillRect(dx, dy, dw, dh);
  });
}

/** Draw all obstacles as dark rectangles. */
function drawObstacles(ctx) {
  ctx.fillStyle = '#1a1a24';
  G.obstacles.forEach(o => {
    ctx.fillRect(o.x, o.y, o.width, o.height);
  });
}

/** Draw the interior view if the player is inside a building. */
function drawInterior(ctx) {
  const interior = G.currentInterior;
  if (!interior) return;
  const intX = (G.screen.w - interior.width) / 2;
  const intY = (G.screen.h - G.screen.safeBottom - interior.height) / 2;
  // Room background
  ctx.fillStyle = '#151724';
  ctx.fillRect(intX, intY, interior.width, interior.height);
  // Walls (simple border)
  ctx.strokeStyle = '#2a2f45';
  ctx.lineWidth = 4;
  ctx.strokeRect(intX, intY, interior.width, interior.height);
  // Door
  const doorW = interior.width * 0.2;
  const doorH = 10;
  const doorX = intX + interior.width / 2 - doorW / 2;
  const doorY = intY + interior.height - doorH;
  ctx.fillStyle = '#6b6f80';
  ctx.fillRect(doorX, doorY, doorW, doorH);
  // NPC inside
  const npc = interior.npc;
  const npcScreenX = intX + interior.width / 2 + npc.x;
  const npcScreenY = intY + interior.height / 2 + npc.y;
  ctx.fillStyle = npc.color;
  ctx.beginPath();
  ctx.arc(npcScreenX, npcScreenY, 14, 0, Math.PI * 2);
  ctx.fill();
  // Draw zone name as interior title
  ctx.fillStyle = '#e6e6ea';
  ctx.font = '18px system-ui';
  const name = getNPCName(npc.id);
  ctx.fillText(name + "'s Home", intX + 16, intY + 24);
}

/**
 * Enter a building: store current position and teleport player into the
 * interior spawn point. Set flags to render interior.
 */
function enterBuilding(building) {
  // Save player position
  G.previousPosition.x = G.player.x;
  G.previousPosition.y = G.player.y;
  // Find corresponding interior
  const interior = G.interiors.find(int => int.npcId === building.npcId);
  if (!interior) return;
  G.currentInterior = interior;
  G.inInterior = true;
  // Teleport player to interior spawn (relative to screen centre)
  const intX = (G.screen.w - interior.width) / 2;
  const intY = (G.screen.h - G.screen.safeBottom - interior.height) / 2;
  G.player.x = intX + interior.width / 2 + interior.spawnX;
  G.player.y = intY + interior.height / 2 + interior.spawnY;
}

/** Exit the current interior and return to the world at previous position. */
function exitBuilding() {
  if (!G.inInterior) return;
  G.inInterior = false;
  G.currentInterior = null;
  // Restore player position
  G.player.x = G.previousPosition.x;
  G.player.y = G.previousPosition.y;
}

/** Update function called each frame. Handles movement, NPC wandering,
 * messages, cooldowns and quest item pickup. */
function update(dt) {
  // Move player according to velocity
  const p = G.player;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  // Update depending on whether player is inside an interior
  if (G.inInterior) {
    updateInterior(dt);
  } else {
    updateWorld(dt);
  }
  // Update transient messages timers
  G.messages = G.messages.filter(m => {
    m.time -= dt;
    return m.time > 0;
  });
  // Update ability cooldowns
  for (const id in G.player.abilityCooldown) {
    G.player.abilityCooldown[id] = Math.max(0, G.player.abilityCooldown[id] - dt);
  }
  // Apply status effects: adjust player speed
  let speedMult = 1;
  for (const eff of G.statusEffects) {
    if (eff.type === 'speed') speedMult += eff.value;
  }
  p.speed = p.baseSpeed * speedMult;
}

/**
 * Update logic when the player is in the world (not inside an interior). Handles
 * clamping to world boundaries, NPC wandering, collisions with obstacles and
 * buildings, and quest item pickups.
 */
function updateWorld(dt) {
  const p = G.player;
  // Clamp player within world bounds
  p.x = Math.max(16, Math.min(G.screen.w - 16, p.x));
  p.y = Math.max(80, Math.min(G.screen.h - G.screen.safeBottom - 16, p.y));
  // Update NPC wandering
  G.npcs.forEach(npc => {
    if (Math.random() < 0.01) {
      const angle = Math.random() * Math.PI * 2;
      npc.dx = Math.cos(angle) * 40;
      npc.dy = Math.sin(angle) * 40;
    }
    npc.x += npc.dx * dt;
    npc.y += npc.dy * dt;
    // Keep inside its zone horizontally and vertical bounds
    const z = G.zones[npc.zoneIndex];
    if (npc.x < z.x + 20) { npc.x = z.x + 20; npc.dx = Math.abs(npc.dx); }
    if (npc.x > z.x + z.width - 20) { npc.x = z.x + z.width - 20; npc.dx = -Math.abs(npc.dx); }
    if (npc.y < 80) { npc.y = 80; npc.dy = Math.abs(npc.dy); }
    if (npc.y > G.screen.h - G.screen.safeBottom - 20) { npc.y = G.screen.h - G.screen.safeBottom - 20; npc.dy = -Math.abs(npc.dy); }
  });
  // Collision with obstacles: push player out
  G.obstacles.forEach(o => {
    if (G.player.x + 16 > o.x && G.player.x - 16 < o.x + o.width &&
        G.player.y + 16 > o.y && G.player.y - 16 < o.y + o.height) {
      // Determine smallest penetration axis
      const dxLeft = (o.x - (p.x + 16));
      const dxRight = ((o.x + o.width) - (p.x - 16));
      const dyTop = (o.y - (p.y + 16));
      const dyBottom = ((o.y + o.height) - (p.y - 16));
      // Choose the minimal absolute displacement
      const absX = Math.min(Math.abs(dxLeft), Math.abs(dxRight));
      const absY = Math.min(Math.abs(dyTop), Math.abs(dyBottom));
      if (absX < absY) {
        // Move horizontally
        if (Math.abs(dxLeft) < Math.abs(dxRight)) p.x = o.x - 16;
        else p.x = o.x + o.width + 16;
      } else {
        // Move vertically
        if (Math.abs(dyTop) < Math.abs(dyBottom)) p.y = o.y - 16;
        else p.y = o.y + o.height + 16;
      }
    }
  });
  // Collision with buildings (block except at door)
  G.buildings.forEach(b => {
    // Check if within building rectangle
    if (p.x + 16 > b.x && p.x - 16 < b.x + b.width &&
        p.y + 16 > b.y && p.y - 16 < b.y + b.height) {
      // Door region along bottom centre
      const doorW = b.width * 0.2;
      const doorX0 = b.doorX - doorW / 2;
      const doorX1 = b.doorX + doorW / 2;
      const doorY0 = b.doorY - 10; // door height 10
      // If player is within door region allow entrance by clicking but still push out vertically to avoid clipping
      const withinDoor = p.x > doorX0 && p.x < doorX1 && p.y + 16 > b.y + b.height;
      if (!withinDoor) {
        // Push player out of building
        const dxLeft = (b.x - (p.x + 16));
        const dxRight = ((b.x + b.width) - (p.x - 16));
        const dyTop = (b.y - (p.y + 16));
        const dyBottom = ((b.y + b.height) - (p.y - 16));
        const absX = Math.min(Math.abs(dxLeft), Math.abs(dxRight));
        const absY = Math.min(Math.abs(dyTop), Math.abs(dyBottom));
        if (absX < absY) {
          if (Math.abs(dxLeft) < Math.abs(dxRight)) p.x = b.x - 16;
          else p.x = b.x + b.width + 16;
        } else {
          if (Math.abs(dyTop) < Math.abs(dyBottom)) p.y = b.y - 16;
          else p.y = b.y + b.height + 16;
        }
      }
    }
  });
  // Quest item pickups in world
  for (let i = G.objects.length - 1; i >= 0; i--) {
    const obj = G.objects[i];
    const dx = obj.x - p.x;
    const dy = obj.y - p.y;
    if (dx * dx + dy * dy < 20 * 20) {
      if (!p.inventory.includes(obj.itemId)) {
        p.inventory.push(obj.itemId);
        addMessage(`Collected ${getItemName(obj.itemId)}`);
      }
      G.objects.splice(i, 1);
    }
  }
}

/**
 * Update logic when the player is inside an interior. Constrain the player and
 * interior NPC within the interior boundaries and handle simple wandering.
 */
function updateInterior(dt) {
  const interior = G.currentInterior;
  if (!interior) return;
  // Interior bounding box on screen
  const intX = (G.screen.w - interior.width) / 2;
  const intY = (G.screen.h - G.screen.safeBottom - interior.height) / 2;
  // Clamp player within interior (padding 16)
  const pad = 16;
  const minX = intX + pad;
  const maxX = intX + interior.width - pad;
  const minY = intY + pad;
  const maxY = intY + interior.height - pad;
  G.player.x = Math.max(minX, Math.min(maxX, G.player.x));
  G.player.y = Math.max(minY, Math.min(maxY, G.player.y));
  // Interior NPC wandering: small random movement
  const npc = interior.npc;
  if (Math.random() < 0.02) {
    const angle = Math.random() * Math.PI * 2;
    npc.dx = Math.cos(angle) * 20;
    npc.dy = Math.sin(angle) * 20;
  }
  npc.x += npc.dx * dt;
  npc.y += npc.dy * dt;
  // Keep NPC within interior bounds (relative coordinates)
  const halfW = interior.width / 2 - 20;
  const halfH = interior.height / 2 - 40;
  if (npc.x < -halfW) { npc.x = -halfW; npc.dx = Math.abs(npc.dx); }
  if (npc.x > halfW) { npc.x = halfW; npc.dx = -Math.abs(npc.dx); }
  if (npc.y < -halfH) { npc.y = -halfH; npc.dy = Math.abs(npc.dy); }
  if (npc.y > halfH) { npc.y = halfH; npc.dy = -Math.abs(npc.dy); }
}

/** Main draw function that renders everything on canvas. */
function draw() {
  const ctx = G.ctx;
  ctx.fillStyle = '#12121a';
  ctx.fillRect(0, 0, G.screen.w, G.screen.h);
  // If inside an interior, render the interior room and its contents
  if (G.inInterior) {
    // Draw interior room and occupant
    drawInterior(ctx);
    // Draw the player after interior so they appear on top
    ctx.fillStyle = '#52d1ff';
    ctx.beginPath(); ctx.arc(G.player.x, G.player.y, 16, 0, Math.PI * 2); ctx.fill();
  } else {
    // Draw world: zones, grid, obstacles, buildings, objects, NPCs, player
    drawZones(ctx);
    // Grid overlay
    ctx.strokeStyle = '#202230';
    ctx.lineWidth = 1;
    for (let x = 0; x < G.screen.w; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, G.screen.h); ctx.stroke();
    }
    for (let y = 0; y < G.screen.h; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(G.screen.w, y); ctx.stroke();
    }
    drawObstacles(ctx);
    drawBuildings(ctx);
    drawObjects(ctx);
    // NPCs
    G.npcs.forEach(npc => {
      ctx.fillStyle = npc.color;
      ctx.beginPath(); ctx.arc(npc.x, npc.y, 14, 0, Math.PI * 2); ctx.fill();
    });
    // Player
    ctx.fillStyle = '#52d1ff';
    ctx.beginPath(); ctx.arc(G.player.x, G.player.y, 16, 0, Math.PI * 2); ctx.fill();
  }
  // Draw HUD (health bar, gold, level) always
  drawHUD(ctx);
  // Draw overlay (inventory, quests, status, shop) if any
  drawOpenOverlay(ctx);
  // Draw talk overlay if in conversation
  drawTalkOverlay(ctx);
  // Draw transient messages
  drawMessages(ctx);
}

/** Draw world zones as translucent tinted rectangles with names. */
function drawZones(ctx) {
  if (!G.zones || G.zones.length === 0) return;
  G.zones.forEach((zone, i) => {
    const hue = (i * 60) % 360;
    ctx.fillStyle = `hsla(${hue},30%,25%,0.15)`;
    ctx.fillRect(zone.x, 0, zone.width, G.screen.h - G.screen.safeBottom);
    // Zone name
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '16px system-ui';
    ctx.fillText(zone.name || `Zone ${i + 1}`, zone.x + 12, 24);
  });
}

/** Draw all collectible objects as yellow circles. */
function drawObjects(ctx) {
  ctx.fillStyle = '#ffd447';
  G.objects.forEach(obj => {
    ctx.beginPath(); ctx.arc(obj.x, obj.y, 8, 0, Math.PI * 2); ctx.fill();
  });
}

/** Draw player's HUD: health bar, gold, level. */
function drawHUD(ctx) {
  const { hp, maxHp, gold, level } = G.player;
  // Health bar
  const barW = 200;
  const barH = 12;
  const x = 12;
  const y = 12;
  ctx.fillStyle = '#2a2f45';
  ctx.fillRect(x, y, barW, barH);
  ctx.fillStyle = '#8ae6a2';
  ctx.fillRect(x, y, barW * (hp / maxHp), barH);
  ctx.strokeStyle = '#444'; ctx.strokeRect(x, y, barW, barH);
  ctx.fillStyle = '#cfd3df';
  ctx.font = '12px system-ui';
  ctx.fillText(`HP ${Math.ceil(hp)}/${maxHp}`, x + 4, y + 10);
  // Gold and level
  ctx.fillText(`Gold: ${gold}`, x, y + 28);
  ctx.fillText(`Level: ${level}`, x, y + 44);
}

/** Draw all transient messages at the top of the screen. */
function drawMessages(ctx) {
  let y = 80;
  ctx.font = '14px system-ui';
  G.messages.forEach(m => {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, y - 14, G.screen.w, 20);
    ctx.fillStyle = '#e6e6ea';
    ctx.fillText(m.text, 20, y);
    y += 22;
  });
}

/** Display whichever overlay is currently open (quests, inventory, status, shop). */
function drawOpenOverlay(ctx) {
  if (!G.openOverlay) return;
  if (G.openOverlay === 'quests') drawQuestsOverlay(ctx);
  else if (G.openOverlay === 'inventory') drawInventoryOverlay(ctx);
  else if (G.openOverlay === 'status') drawStatusOverlay(ctx);
  else if (G.openOverlay === 'shop') drawShopOverlay(ctx);
}

/** Draw the quests overlay listing all quests, their status and current step. */
function drawQuestsOverlay(ctx) {
  const w = Math.min(420, G.screen.w - 40);
  const h = Math.min(500, G.screen.h - G.screen.safeBottom - 40);
  const x = (G.screen.w - w) / 2;
  const y = (G.screen.h - G.screen.safeBottom - h) / 2;
  ctx.fillStyle = '#1e2130';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e6e6ea';
  ctx.font = '18px system-ui';
  ctx.fillText('Quests', x + 16, y + 24);
  ctx.font = '13px system-ui';
  let curY = y + 46;
  G.uiZones.overlay = [];
  G.questsState.forEach((qs, index) => {
    ctx.fillStyle = '#cfd3df';
    const status = qs.status.replace('-', ' ');
    ctx.fillText(`${qs.title} (${status})`, x + 16, curY);
    curY += 18;
    if (qs.status === 'not-started') {
      // Draw start button
      const bw = 80, bh = 28;
      const bx = x + 16;
      const by = curY;
      ctx.fillStyle = '#2a2f45';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#cfd3df';
      ctx.fillText('Start', bx + 22, by + 18);
      // Register zone
      G.uiZones.overlay.push({ x: bx, y: by, w: bw, h: bh, on: () => startQuest(qs.id) });
      curY += bh + 8;
    } else {
      // Show current step goal and NPC
      const stepIdx = qs.currentStep;
      const step = qs.steps[stepIdx];
      if (step) {
        ctx.fillStyle = '#9aa0b0';
        ctx.fillText(`→ ${step.goal}`, x + 16, curY);
        curY += 16;
        const npcId = qs.stepAssignments[stepIdx];
        const npcName = getNPCName(npcId);
        ctx.fillText(`Deliver to: ${npcName}`, x + 16, curY);
        curY += 20;
        // Show required items list
        if (step.requires_item_ids && step.requires_item_ids.length) {
          ctx.fillText('Required items:', x + 16, curY);
          curY += 16;
          step.requires_item_ids.forEach(itemId => {
            ctx.fillText(`• ${getItemName(itemId)}`, x + 24, curY);
            curY += 14;
          });
        }
      }
      curY += 8;
    }
    curY += 8;
  });
}

/** Draw the inventory overlay showing equipped items and inventory list. */
function drawInventoryOverlay(ctx) {
  const w = Math.min(380, G.screen.w - 40);
  const h = Math.min(500, G.screen.h - G.screen.safeBottom - 40);
  const x = (G.screen.w - w) / 2;
  const y = (G.screen.h - G.screen.safeBottom - h) / 2;
  ctx.fillStyle = '#1e2130'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e6e6ea'; ctx.font = '18px system-ui'; ctx.fillText('Inventory', x + 16, y + 24);
  ctx.font = '13px system-ui';
  let curY = y + 46;
  // Equipped items
  ctx.fillStyle = '#9aa0b0';
  ctx.fillText('Equipped:', x + 16, curY);
  curY += 16;
  ['weapon', 'armour'].forEach(slot => {
    const itemId = G.player.equipped[slot];
    const name = itemId ? getItemName(itemId) : '(none)';
    ctx.fillStyle = '#cfd3df';
    ctx.fillText(`${slot}: ${name}`, x + 24, curY);
    curY += 16;
  });
  curY += 8;
  ctx.fillStyle = '#9aa0b0'; ctx.fillText('Items:', x + 16, curY);
  curY += 16;
  G.uiZones.overlay = [];
  // List inventory items with click actions for equip/use
  G.player.inventory.forEach((itemId, i) => {
    const item = inventoryData.items.find(it => it.item_id === itemId);
    const name = item ? item.name : itemId;
    const cat = item ? item.category : 'unknown';
    ctx.fillStyle = '#cfd3df';
    ctx.fillText(`${name} [${cat}]`, x + 24, curY);
    // Define zone for click: toggles equip/unequip or uses consumable
    const lineHeight = 16;
    G.uiZones.overlay.push({
      x: x + 24, y: curY - 14, w: w - 48, h: lineHeight,
      on: () => onInventoryItemClick(itemId)
    });
    curY += 16;
  });
}

/** Draw the status overlay showing player's stats and active status effects. */
function drawStatusOverlay(ctx) {
  const w = Math.min(360, G.screen.w - 40);
  const h = Math.min(420, G.screen.h - G.screen.safeBottom - 40);
  const x = (G.screen.w - w) / 2;
  const y = (G.screen.h - G.screen.safeBottom - h) / 2;
  ctx.fillStyle = '#1e2130'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e6e6ea'; ctx.font = '18px system-ui'; ctx.fillText('Status', x + 16, y + 24);
  ctx.font = '13px system-ui';
  let curY = y + 46;
  const p = G.player;
  ctx.fillStyle = '#cfd3df';
  ctx.fillText(`HP: ${Math.ceil(p.hp)}/${p.maxHp}`, x + 16, curY); curY += 16;
  ctx.fillText(`Gold: ${p.gold}`, x + 16, curY); curY += 16;
  ctx.fillText(`Level: ${p.level}`, x + 16, curY); curY += 16;
  ctx.fillText('Skills:', x + 16, curY); curY += 16;
  for (const s in p.skills) {
    ctx.fillText(`• ${s}: ${p.skills[s].toFixed(2)}`, x + 24, curY);
    curY += 14;
  }
  curY += 8;
  ctx.fillText('Active Effects:', x + 16, curY); curY += 16;
  G.statusEffects.forEach(eff => {
    ctx.fillText(`• ${eff.name} (${eff.time.toFixed(1)}s)`, x + 24, curY);
    curY += 14;
  });
}

/** Draw the shop overlay where player can buy random items. */
function drawShopOverlay(ctx) {
  const w = Math.min(380, G.screen.w - 40);
  const h = Math.min(500, G.screen.h - G.screen.safeBottom - 40);
  const x = (G.screen.w - w) / 2;
  const y = (G.screen.h - G.screen.safeBottom - h) / 2;
  ctx.fillStyle = '#1e2130'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e6e6ea'; ctx.font = '18px system-ui'; ctx.fillText('Shop', x + 16, y + 24);
  ctx.font = '13px system-ui';
  let curY = y + 46;
  // Show player's gold
  ctx.fillStyle = '#cfd3df'; ctx.fillText(`Gold: ${G.player.gold}`, x + 16, curY); curY += 20;
  ctx.fillStyle = '#9aa0b0'; ctx.fillText('Items for sale:', x + 16, curY); curY += 16;
  // Show shop items (we generate new random stock on each open)
  if (!G.shopStock) initShopStock();
  G.uiZones.overlay = [];
  G.shopStock.forEach(item => {
    const price = getItemPrice(item);
    const affordable = G.player.gold >= price;
    ctx.fillStyle = affordable ? '#cfd3df' : '#6b6f80';
    ctx.fillText(`${item.name} [${item.category}] - ${price}g`, x + 24, curY);
    // Click to purchase
    const lineH = 16;
    G.uiZones.overlay.push({
      x: x + 24, y: curY - 14, w: w - 48, h: lineH,
      on: () => purchaseItem(item)
    });
    curY += 16;
  });
}

/** Initialise shop stock with a random sample of items. */
function initShopStock() {
  const allItems = inventoryData.items || [];
  // Choose up to 6 random items
  const shuffled = [...allItems].sort(() => Math.random() - 0.5);
  G.shopStock = shuffled.slice(0, Math.min(6, shuffled.length));
}

/** Handle purchasing an item from the shop. Deduct gold and add to inventory. */
function purchaseItem(item) {
  const price = getItemPrice(item);
  if (G.player.gold >= price) {
    G.player.gold -= price;
    G.player.inventory.push(item.item_id);
    addMessage(`Bought ${item.name}`);
    // Remove from stock and refresh
    G.shopStock = G.shopStock.filter(i => i.item_id !== item.item_id);
  } else {
    addMessage('Not enough gold');
  }
}

/** Get price for an item based on its category. */
function getItemPrice(item) {
  const cat = item.category;
  if (cat === 'weapon' || cat === 'armor') return 30;
  if (cat === 'quest') return 10;
  return 20; // consumable or unknown
}

/** Add a transient message to the queue. */
function addMessage(text, duration = 3) {
  G.messages.push({ text, time: duration });
}

/** Convert NPC id to a display name (remove npc_ prefix and capitalise words). */
function getNPCName(npcId) {
  let name = npcId;
  if (name.startsWith('npc_')) name = name.slice(4);
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Convert an item id to its display name. */
function getItemName(itemId) {
  const item = inventoryData.items.find(it => it.item_id === itemId);
  return item ? item.name : itemId;
}

/** Keydown event handler. Handles movement, overlay toggles and ability usage. */
function onKeyDown(e) {
  const p = G.player;
  // Prevent default for certain keys
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Enter', 'KeyE'].includes(e.code)) {
    e.preventDefault();
  }
  // Movement keys
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') p.vx = -p.speed;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') p.vx = p.speed;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') p.vy = -p.speed;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') p.vy = p.speed;
  // Ability keys (Digit1-5)
  if (e.code.startsWith('Digit')) {
    const idx = parseInt(e.code.slice(5)) - 1;
    if (!isNaN(idx)) activateAbility(idx);
  }
  // Toggle overlays with number keys or shortcuts
  if (e.code === 'KeyI') toggleOverlay('inventory');
  if (e.code === 'KeyQ') toggleOverlay('quests');
  if (e.code === 'KeyS') toggleOverlay('status');
  if (e.code === 'KeyP') toggleOverlay('shop');
}

/** Keyup event handler stops movement. */
function onKeyUp(e) {
  const p = G.player;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') { if (p.vx < 0) p.vx = 0; }
  if (e.code === 'ArrowRight' || e.code === 'KeyD') { if (p.vx > 0) p.vx = 0; }
  if (e.code === 'ArrowUp' || e.code === 'KeyW') { if (p.vy < 0) p.vy = 0; }
  if (e.code === 'ArrowDown' || e.code === 'KeyS') { if (p.vy > 0) p.vy = 0; }
}

/** Toggle an overlay on or off. If the requested overlay is already open, close it. */
function toggleOverlay(name) {
  if (G.openOverlay === name) G.openOverlay = null;
  else G.openOverlay = name;
  // Refresh shop stock when opening shop
  if (G.openOverlay === 'shop') initShopStock();
}

/** Handle pointer down events for clicks and taps. */
function onPointerDown(e) {
  if (e && e.preventDefault) e.preventDefault();
  const rect = G.canvas.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  // Overlay interactions take precedence
  if (G.openOverlay) {
    for (const zone of G.uiZones.overlay) {
      if (x >= zone.x && x <= zone.x + zone.w && y >= zone.y && y <= zone.y + zone.h) {
        if (zone.on) zone.on();
        return;
      }
    }
    // Clicking outside overlay closes it
    G.openOverlay = null;
    return;
  }
  // Dialogue interactions
  if (G.talk) {
    // Deliver button or dialogue options are handled in drawTalkOverlay via G.uiZones.talk
    for (const zone of G.uiZones.talk) {
      if (x >= zone.x && x <= zone.x + zone.w && y >= zone.y && y <= zone.y + zone.h) {
        if (zone.on) zone.on();
        return;
      }
    }
    // Click outside talk overlay closes conversation
    G.talk = null;
    return;
  }
  // If inside an interior, handle interior interactions
  if (G.inInterior) {
    // Determine interior door area
    const interior = G.currentInterior;
    const intX = (G.screen.w - interior.width) / 2;
    const intY = (G.screen.h - G.screen.safeBottom - interior.height) / 2;
    const doorW = interior.width * 0.2;
    const doorH = 10;
    const doorX0 = intX + interior.width / 2 - doorW / 2;
    const doorY0 = intY + interior.height - doorH;
    if (x >= doorX0 && x <= doorX0 + doorW && y >= doorY0 && y <= doorY0 + doorH) {
      // Exit interior when clicking door
      exitBuilding();
      return;
    }
    // Check click on interior NPC
    const npc = pickNPCAt(x, y);
    if (npc) {
      startTalk(npc);
      return;
    }
    // Otherwise close overlays
    G.openOverlay = null;
    return;
  }
  // In world: check if clicking on a building door to enter
  for (const b of G.buildings) {
    const dw = b.width * 0.2;
    const dh = 10;
    const dx0 = b.doorX - dw / 2;
    const dy0 = b.doorY - dh;
    if (x >= dx0 && x <= dx0 + dw && y >= dy0 && y <= dy0 + dh) {
      enterBuilding(b);
      return;
    }
  }
  // Check NPC click in world: start talk if within range
  const npc = pickNPCAt(x, y);
  if (npc) {
    startTalk(npc);
    return;
  }
  // Otherwise close overlays
  G.openOverlay = null;
}

/** Find NPC at given coordinates (within 20px radius). */
function pickNPCAt(x, y) {
  if (G.inInterior) {
    // Check against the interior occupant
    const interior = G.currentInterior;
    if (interior) {
      const intX = (G.screen.w - interior.width) / 2;
      const intY = (G.screen.h - G.screen.safeBottom - interior.height) / 2;
      const npc = interior.npc;
      const npcScreenX = intX + interior.width / 2 + npc.x;
      const npcScreenY = intY + interior.height / 2 + npc.y;
      const dx = npcScreenX - x;
      const dy = npcScreenY - y;
      if (dx * dx + dy * dy < 20 * 20) {
        return npc;
      }
    }
    return null;
  } else {
    for (const npc of G.npcs) {
      const dx = npc.x - x;
      const dy = npc.y - y;
      if (dx * dx + dy * dy < 20 * 20) {
        return npc;
      }
    }
    return null;
  }
}

/** Start a dialogue with an NPC. */
function startTalk(npc) {
  if (!npc) return;
  const dialogue = dialoguesData.dialogues[npc.dialogueIndex];
  if (!dialogue) return;
  G.talk = {
    npcId: npc.id,
    dialogueIndex: npc.dialogueIndex,
    currentNode: dialogue.nodes[0],
  };
  // If this node grants items immediately, grant them
  if (G.talk.currentNode.grants_item_ids) {
    grantItems(G.talk.currentNode.grants_item_ids);
  }
}

/** Grant items to player inventory with messages and gold rewards. */
function grantItems(itemIds) {
  itemIds.forEach(id => {
    if (!G.player.inventory.includes(id)) {
      G.player.inventory.push(id);
      addMessage(`Received ${getItemName(id)}`);
      G.player.gold += 5; // reward small gold for items
    }
  });
}

/** Draw the talk overlay showing current dialogue node and options. */
function drawTalkOverlay(ctx) {
  if (!G.talk) return;
  const dialogue = dialoguesData.dialogues[G.talk.dialogueIndex];
  const node = G.talk.currentNode;
  if (!node) return;
  // Panel dimensions
  const w = Math.min(460, G.screen.w - 40);
  let textHeight = 60;
  // Roughly calculate height based on text length
  const textLines = Math.ceil(ctx.measureText(node.text).width / (w - 60));
  textHeight += textLines * 18;
  const optionCount = (node.options ? node.options.length : 0) + 1; // including deliver button maybe
  const h = textHeight + optionCount * 46 + 60;
  const x = (G.screen.w - w) / 2;
  const y = G.screen.h - G.screen.safeBottom - h - 20;
  // Background overlay
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, G.screen.w, G.screen.h);
  // Panel background
  ctx.fillStyle = '#1e2130';
  ctx.fillRect(x, y, w, h);
  // Speaker name
  ctx.fillStyle = '#e6e6ea';
  ctx.font = '18px system-ui';
  // Fallback to the current NPC ID if the node lacks a speaker field. This mirrors
  // the behaviour of earlier versions where every node had a speaker.
  const speakerId = node.speaker || (G.talk && G.talk.npcId);
  ctx.fillText(getNPCName(speakerId), x + 16, y + 30);
  // Dialogue text box
  ctx.fillStyle = '#2a2f45';
  ctx.fillRect(x + 14, y + 40, w - 28, textHeight);
  ctx.fillStyle = '#cfd3df';
  ctx.font = '14px system-ui';
  wrapText(ctx, node.text, x + 24, y + 60, w - 48, 18);
  let oy = y + 40 + textHeight + 10;
  G.uiZones.talk = [];
  // Dialogue options
  if (node.options && node.options.length > 0) {
    node.options.forEach(option => {
      ctx.fillStyle = '#2a2f45'; ctx.fillRect(x + 14, oy, w - 28, 40);
      ctx.fillStyle = '#cfd3df'; ctx.font = '16px system-ui';
      ctx.fillText(option.choice_text, x + 26, oy + 26);
      G.uiZones.talk.push({ x: x + 14, y: oy, w: w - 28, h: 40, on: () => {
        // On option click: grant items, record tags and move to next node
        if (option.grants_item_ids) grantItems(option.grants_item_ids);
        if (option.to_id) {
          const next = dialogue.nodes.find(n => n.node_id === option.to_id);
          if (next) {
            G.talk.currentNode = next;
            // Grant items for next node
            if (next.grants_item_ids) grantItems(next.grants_item_ids);
          }
        } else {
          // End talk
          G.talk = null;
        }
      }});
      oy += 46;
    });
  }
  // Deliver items button if this NPC is assigned to any active quest step requiring delivery
  const deliverInfo = getDeliverInfoForNPC(G.talk.npcId);
  if (deliverInfo) {
    ctx.fillStyle = '#2a2f45'; ctx.fillRect(x + 14, oy, w - 28, 40);
    ctx.fillStyle = '#cfd3df'; ctx.font = '16px system-ui';
    ctx.fillText('Deliver items', x + 26, oy + 26);
    G.uiZones.talk.push({ x: x + 14, y: oy, w: w - 28, h: 40, on: () => {
      finishQuestStepsOnTalk(G.talk.npcId);
    }});
    oy += 46;
  }
  // Close button
  ctx.fillStyle = '#2a2f45'; ctx.fillRect(x + 14, oy, w - 28, 40);
  ctx.fillStyle = '#cfd3df'; ctx.fillText('Close', x + 26, oy + 26);
  G.uiZones.talk.push({ x: x + 14, y: oy, w: w - 28, h: 40, on: () => { G.talk = null; } });
}

/** Word-wrap helper. */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + ' ';
    const metrics = ctx.measureText(test);
    if (metrics.width > maxWidth && i > 0) {
      ctx.fillText(line, x, y);
      line = words[i] + ' ';
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, y);
}

/** Activate an ability by index. Applies effects and sets cooldowns. */
function activateAbility(idx) {
  const ab = G.player.abilities[idx];
  if (!ab) return;
  if (G.player.abilityCooldown[ab.id] > 0) {
    addMessage(`${ab.name} is on cooldown`);
    return;
  }
  // Example ability effects: heal, speed boost, strength buff, random effect
  if (/heal/i.test(ab.name) || /potion/i.test(ab.name)) {
    healPlayer(25);
  } else if (/speed/i.test(ab.name)) {
    G.statusEffects.push({ name: ab.name, type: 'speed', value: 0.5, time: 10 });
  } else if (/strength/i.test(ab.name)) {
    G.statusEffects.push({ name: ab.name, type: 'strength', value: 0.5, time: 10 });
  } else {
    // Random buff
    const types = ['speed', 'strength'];
    const type = types[Math.floor(Math.random() * types.length)];
    G.statusEffects.push({ name: ab.name, type, value: 0.3, time: 10 });
  }
  G.player.abilityCooldown[ab.id] = 30; // 30s cooldown
  addMessage(`Used ability: ${ab.name}`);
}

/** Heal the player and clamp HP to max. */
function healPlayer(amount) {
  G.player.hp = Math.min(G.player.maxHp, G.player.hp + amount);
  addMessage(`Healed ${amount} HP`);
}

/** Damage the player. If HP falls to zero, faint and respawn. */
function damagePlayer(amount) {
  G.player.hp -= amount;
  if (G.player.hp <= 0) {
    G.player.hp = G.player.maxHp;
    G.player.x = G.screen.w / 2;
    G.player.y = G.screen.h / 2;
    G.player.gold = Math.max(0, G.player.gold - 10);
    addMessage('You fainted! Lost some gold.');
  }
}

/** Start a quest by id. Spawns items for first step and updates status. */
function startQuest(id) {
  const qs = G.questsState.find(q => q.id === id);
  if (!qs) return;
  if (qs.status !== 'not-started') return;
  qs.status = 'in-progress';
  qs.currentStep = 0;
  addMessage(`Started quest: ${qs.title}`);
  // Spawn items for first step
  spawnItemsForStep(qs, 0);
}

/** Spawn items required for given quest step, ignoring those granted via dialogue. */
function spawnItemsForStep(qs, stepIndex) {
  const step = qs.steps[stepIndex];
  if (!step) return;
  // Determine which items need to be spawned (exclude those in player's inventory or items granted by NPCs)
  const toSpawn = [];
  (step.requires_item_ids || []).forEach(id => {
    // Check if this item can be obtained via dialogue (granted_item_ids) – skip spawn in such case
    const grantedByDialogue = dialoguesData.dialogues.some(dlg => dlg.nodes.some(n => (n.grants_item_ids || []).includes(id)));
    if (grantedByDialogue) return;
    // Check if player already has this item or it's on map
    if (!G.player.inventory.includes(id) && !G.objects.some(o => o.itemId === id)) {
      toSpawn.push(id);
    }
  });
  // Spawn at random positions within world
  toSpawn.forEach(itemId => {
    const zoneCount = G.zones.length || 1;
    const zone = G.zones[Math.floor(Math.random() * zoneCount)];
    const x = zone.x + Math.random() * zone.width;
    const y = 80 + Math.random() * (G.screen.h - G.screen.safeBottom - 120);
    G.objects.push({ itemId, x, y });
  });
}

/** Determine if there is a quest step ready for delivery to the given NPC. */
function getDeliverInfoForNPC(npcId) {
  for (const qs of G.questsState) {
    if (qs.status === 'in-progress') {
      const stepIdx = qs.currentStep;
      if (qs.stepAssignments[stepIdx] === npcId) {
        const step = qs.steps[stepIdx];
        // Check if player has all required items
        const hasAll = (step.requires_item_ids || []).every(id => G.player.inventory.includes(id));
        if (hasAll) return { qs, stepIdx };
      }
    }
  }
  return null;
}

/** Finish quest steps for an NPC if requirements are met. Performs skill check. */
function finishQuestStepsOnTalk(npcId) {
  const info = getDeliverInfoForNPC(npcId);
  if (!info) {
    addMessage('You do not have the required items');
    return;
  }
  const { qs, stepIdx } = info;
  const npc = G.npcs.find(n => n.id === npcId);
  const step = qs.steps[stepIdx];
  // Perform skill check based on NPC skill and difficulty
  const skill = npc.skill;
  const difficulty = npc.difficulty;
  const success = performSkillCheck(skill, difficulty);
  if (success) {
    addMessage(`Skill check passed (${skill})`);
  } else {
    addMessage(`Skill check failed (${skill})`);
    damagePlayer(10);
  }
  // Remove required items from inventory
  (step.requires_item_ids || []).forEach(id => {
    const idxInInv = G.player.inventory.indexOf(id);
    if (idxInInv >= 0) G.player.inventory.splice(idxInInv, 1);
  });
  // Advance step
  qs.currentStep++;
  if (qs.currentStep >= qs.steps.length) {
    qs.status = 'completed';
    addMessage(`Quest completed: ${qs.title}`);
    G.player.gold += 50;
  } else {
    addMessage(`Step completed: ${step.goal}`);
    G.player.gold += 20;
    // Spawn items for next step
    spawnItemsForStep(qs, qs.currentStep);
  }
}

/** Perform a skill check: returns true if random number < player skill - npc difficulty + random buff. */
function performSkillCheck(skill, difficulty) {
  const playerSkill = G.player.skills[skill] || 0;
  // Incorporate status effects: strength buffs add to relevant skills
  let bonus = 0;
  G.statusEffects.forEach(eff => {
    if (eff.type === skill) bonus += eff.value;
  });
  const roll = Math.random();
  return roll < (playerSkill + bonus) - difficulty + 0.5;
}

/** Handle clicking an inventory item: equip/unequip or use consumable. */
function onInventoryItemClick(itemId) {
  const item = inventoryData.items.find(it => it.item_id === itemId);
  if (!item) return;
  const cat = item.category;
  if (cat === 'weapon' || cat === 'armor') {
    // Equip/unequip
    const slot = cat === 'weapon' ? 'weapon' : 'armour';
    if (G.player.equipped[slot] === itemId) {
      G.player.equipped[slot] = null;
      addMessage(`Unequipped ${item.name}`);
    } else {
      G.player.equipped[slot] = itemId;
      addMessage(`Equipped ${item.name}`);
    }
  } else if (cat === 'consumable') {
    // Use consumable: heal or buff
    if (/heal|potion|elixir/i.test(item.name)) {
      healPlayer(30);
    } else {
      // Random buff
      const types = ['speed', 'strength'];
      const type = types[Math.floor(Math.random() * types.length)];
      G.statusEffects.push({ name: item.name, type, value: 0.3, time: 15 });
      addMessage(`Used ${item.name}`);
    }
    // Remove from inventory
    const idx = G.player.inventory.indexOf(itemId);
    if (idx >= 0) G.player.inventory.splice(idx, 1);
  } else {
    addMessage(`Cannot use ${item.name}`);
  }
}

/** Toggle inventory overlay. */
function showInventory() {
  toggleOverlay('inventory');
}

// Start the game once the DOM is loaded and data has been fetched
window.addEventListener('DOMContentLoaded', async () => {
  await loadGameData();
  initGame();
});