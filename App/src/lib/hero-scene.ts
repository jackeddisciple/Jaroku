// Hero scene — a system of nodes and edges that reads as a compiled graph, because that
// is what the product actually builds. Restraint is the brief: two dozen nodes, a low
// number of edges, one small drift, one gentle pointer response. Nothing else.
//
// Everything gated:
//   - Reduced motion → the scene renders one static frame and never animates.
//   - No WebGL     → we do not import Three at all; a CSS fallback replaces the canvas.
//   - Tab hidden   → the loop stops.
//   - Off-screen   → the mount is deferred until intersection with the viewport.
//   - Mobile       → density and edge count reduced (see cfg).
//
// The exports below are wired by src/components/HeroCanvas.astro. This file is only
// imported dynamically, so its bundle never appears on any page but the home.

import * as THREE from "three";

interface Options {
  canvas: HTMLCanvasElement;
  reducedMotion: boolean;
}

interface Node {
  base: THREE.Vector3;
  pos: THREE.Vector3;
  radius: number;
  phase: number;
  seed: number;
  kind: "router" | "tool" | "model" | "state";
}

const NODE_COLOURS: Record<Node["kind"], number> = {
  router: 0x2b5cff,
  tool: 0x0b0d10,
  model: 0x148a4c,
  state: 0x8a92a1,
};

export function startHero({ canvas, reducedMotion }: Options): () => void {
  const isMobile = window.matchMedia("(max-width: 720px)").matches;

  const cfg = {
    nodeCount: isMobile ? 14 : 28,
    edgeReach: isMobile ? 1.7 : 1.9,
    drift: 0.35,
    pointerStrength: 0.25,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(cfg.dpr);
  renderer.setClearColor(0xffffff, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const size = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    const view = 3.4;
    camera.left = -view * aspect;
    camera.right = view * aspect;
    camera.top = view;
    camera.bottom = -view;
    camera.updateProjectionMatrix();
  };
  size();

  // Nodes ------------------------------------------------------------------
  const nodes: Node[] = [];
  const nodeGeo = new THREE.SphereGeometry(1, 20, 20);
  const nodeGroup = new THREE.Group();
  scene.add(nodeGroup);

  const kinds: Node["kind"][] = ["router", "tool", "model", "state"];
  const spread = isMobile ? 4.8 : 6.2;
  for (let i = 0; i < cfg.nodeCount; i++) {
    const kind = kinds[i % kinds.length];
    const angle = (i / cfg.nodeCount) * Math.PI * 2;
    const r = spread * (0.55 + Math.random() * 0.45);
    const jitter = () => (Math.random() - 0.5) * 1.2;
    const base = new THREE.Vector3(
      Math.cos(angle) * r + jitter(),
      Math.sin(angle) * r * 0.6 + jitter(),
      (Math.random() - 0.5) * 0.4,
    );
    const radius = kind === "router" ? 0.14 : kind === "model" ? 0.11 : 0.09;
    const material = new THREE.MeshBasicMaterial({
      color: NODE_COLOURS[kind],
      transparent: true,
      opacity: kind === "state" ? 0.55 : 0.95,
    });
    const mesh = new THREE.Mesh(nodeGeo, material);
    mesh.scale.setScalar(radius);
    mesh.position.copy(base);
    nodeGroup.add(mesh);
    nodes.push({
      base,
      pos: mesh.position,
      radius,
      phase: Math.random() * Math.PI * 2,
      seed: Math.random(),
      kind,
    });
  }

  // Edges ------------------------------------------------------------------
  type EdgeIndex = [number, number, number];
  const edges: EdgeIndex[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = nodes[i].base.distanceTo(nodes[j].base);
      if (d < cfg.edgeReach) edges.push([i, j, d]);
    }
  }
  const positions = new Float32Array(edges.length * 6);
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x9aa4b2,
    transparent: true,
    opacity: 0.28,
  });
  const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  scene.add(edgeLines);

  // Pulses ------------------------------------------------------------------
  // A short lit segment travels an edge, then dies. Cheap: one shared geometry, a
  // per-pulse position and a colour. Cap kept low so a single frame stays under budget.
  interface Pulse { edge: EdgeIndex; t: number; speed: number; }
  const pulseCap = isMobile ? 3 : 6;
  const pulses: Pulse[] = [];
  const pulseGeo = new THREE.SphereGeometry(0.05, 8, 8);
  const pulseMat = new THREE.MeshBasicMaterial({ color: 0x2b5cff, transparent: true, opacity: 0.9 });
  const pulseGroup = new THREE.Group();
  scene.add(pulseGroup);
  const pulseMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < pulseCap; i++) {
    const m = new THREE.Mesh(pulseGeo, pulseMat.clone());
    m.visible = false;
    pulseGroup.add(m);
    pulseMeshes.push(m);
  }

  const spawnPulse = () => {
    const dead = pulseMeshes.findIndex((m) => !m.visible);
    if (dead === -1) return;
    const edge = edges[Math.floor(Math.random() * edges.length)];
    if (!edge) return;
    pulses[dead] = { edge, t: 0, speed: 0.15 + Math.random() * 0.25 };
    pulseMeshes[dead].visible = true;
  };

  // Pointer -----------------------------------------------------------------
  const pointer = { x: 0, y: 0, active: false };
  const raycasterVec = new THREE.Vector2();
  const onMove = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    raycasterVec.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    raycasterVec.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    // Map pointer into scene X/Y in the same units the nodes live in.
    pointer.x = raycasterVec.x * (camera.right);
    pointer.y = raycasterVec.y * (camera.top);
    pointer.active = true;
  };
  const onLeave = () => { pointer.active = false; };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);

  // Render loop -------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let running = true;
  let elapsed = 0;
  let pulseTimer = 0;

  const step = (now: number) => {
    if (!running) return;
    raf = requestAnimationFrame(step);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    // Nodes drift on a slow sine, and are pulled toward the pointer inversely to distance.
    for (const n of nodes) {
      const wobble = Math.sin(elapsed * 0.6 + n.phase) * 0.03;
      const wobble2 = Math.cos(elapsed * 0.4 + n.phase * 1.3) * 0.03;
      n.pos.x = n.base.x + wobble;
      n.pos.y = n.base.y + wobble2;

      if (pointer.active) {
        const dx = pointer.x - n.pos.x;
        const dy = pointer.y - n.pos.y;
        const d2 = dx * dx + dy * dy + 0.4;
        const pull = cfg.pointerStrength / d2;
        n.pos.x += dx * pull * dt * 4;
        n.pos.y += dy * pull * dt * 4;
      }
    }

    // Sync node meshes back from the working vectors (they alias mesh.position already).
    for (let i = 0; i < nodeGroup.children.length; i++) {
      (nodeGroup.children[i] as THREE.Mesh).position.copy(nodes[i].pos);
    }

    // Rebuild edge line positions.
    for (let e = 0; e < edges.length; e++) {
      const [i, j] = edges[e];
      const a = nodes[i].pos;
      const b = nodes[j].pos;
      const o = e * 6;
      positions[o + 0] = a.x; positions[o + 1] = a.y; positions[o + 2] = a.z;
      positions[o + 3] = b.x; positions[o + 4] = b.y; positions[o + 5] = b.z;
    }
    edgeGeo.attributes.position.needsUpdate = true;

    // Pulses
    pulseTimer -= dt;
    if (pulseTimer <= 0) { spawnPulse(); pulseTimer = 0.35 + Math.random() * 0.6; }
    for (let i = 0; i < pulseMeshes.length; i++) {
      const p = pulses[i];
      const m = pulseMeshes[i];
      if (!m.visible || !p) continue;
      p.t += p.speed * dt / Math.max(0.01, p.edge[2]);
      if (p.t >= 1) { m.visible = false; continue; }
      const a = nodes[p.edge[0]].pos;
      const b = nodes[p.edge[1]].pos;
      m.position.lerpVectors(a, b, p.t);
    }

    renderer.render(scene, camera);
  };

  if (reducedMotion) {
    // One frame, then nothing.
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(step);
  }

  // Visibility / resize -----------------------------------------------------
  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!reducedMotion) {
      if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(step);
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  const onResize = () => size();
  window.addEventListener("resize", onResize);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    edgeGeo.dispose();
    edgeMat.dispose();
    pulseGeo.dispose();
    nodeGeo.dispose();
    for (const m of pulseMeshes) (m.material as THREE.Material).dispose();
    for (const child of nodeGroup.children) ((child as THREE.Mesh).material as THREE.Material).dispose();
    renderer.dispose();
  };
}
