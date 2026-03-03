import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/OrbitControls.js";
import {
  MemoryFieldSimulation,
  OOB_HARD_ENTER_THRESHOLD,
  OOB_HARD_EXIT_THRESHOLD,
  OOB_SOFT_ENTER_THRESHOLD,
  OOB_SOFT_EXIT_THRESHOLD,
  SIMPLEX_VERTS,
} from "./sim.js";

console.log("MAIN START");

const app = document.getElementById("app");
const panelRoot = document.querySelector(".panel");
const axisNote = document.getElementById("axisNote");
const controlsRoot = document.getElementById("controls");
const countsRoot = document.getElementById("counts");
const statusLog = document.getElementById("statusLog");
const runStatus = document.getElementById("runStatus");
const oobStatusEvents = document.getElementById("oobStatusEvents");
const oobStatusWindow = document.getElementById("oobStatusWindow");
const presetSelect = document.getElementById("presetSelect");
const applyPresetButton = document.getElementById("applyPresetButton");
const debugOverlay = document.getElementById("debugOverlay");
const toggleButton = document.getElementById("toggleButton");
const resetButton = document.getElementById("resetButton");
const resetViewButton = document.getElementById("resetViewButton");
const exportButton = document.getElementById("exportButton");
const axisNoteToggle = document.getElementById("axisNoteToggle");
const showHullToggle = document.getElementById("showHullToggle");
const autoCenterToggle = document.getElementById("autoCenterToggle");
const logSoftToggle = document.getElementById("logSoftToggle");

const statusLines = [];

function uiLog(message) {
  const timestamp = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const line = `[${timestamp}] ${message}`;
  if (!statusLog) {
    alert("statusLog missing");
    return;
  }
  statusLines.push(line);
  while (statusLines.length > 20) {
    statusLines.shift();
  }
  statusLog.textContent = statusLines.join("\n");
  statusLog.scrollTop = statusLog.scrollHeight;
}

uiLog("main.js start (top)");

window.onerror = function onWindowError(message) {
  uiLog(`ERROR: ${String(message)}`);
};

window.addEventListener("error", (event) => {
  uiLog(`ERROR: ${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  uiLog(`PROMISE: ${String(event.reason)}`);
});

let isRunning = false;
let frameCount = 0;
let animationStarted = false;
let lastRunStatusUpdate = performance.now();
let lastDebugUpdate = performance.now();
let framesAtLastDebug = 0;
let debugVisible = true;
let lastAutoCenterUpdate = performance.now();
let lastOobStatusUpdate = performance.now();
let wireFlashUntil = 0;
let wireFlashColor = "#b8c4cc";
let axisNoteVisible = true;
const EMPTY_OOB_WINDOW_STATS = {
  peakV: 0,
  peakSeverity: "OK",
  breachedNodes: 0,
};
let lastOobWindow = { ...EMPTY_OOB_WINDOW_STATS };

function updateRunStatus() {
  if (runStatus) {
    runStatus.textContent = `running: ${isRunning} | frames: ${frameCount}`;
  } else {
    uiLog("ERROR: runStatus missing");
  }
}

function updateOobStatus() {
  if (oobStatusEvents) {
    oobStatusEvents.textContent = `OOB events - soft: ${simulation.oobSoftCount} | hard: ${simulation.oobHardCount}`;
  }
  if (oobStatusWindow) {
    const pausedLabel = isRunning ? "" : " (paused)";
    oobStatusWindow.textContent =
      `Last 1s - peakV: ${lastOobWindow.peakV.toFixed(4)} (${lastOobWindow.peakSeverity})` +
      ` | breached: ${lastOobWindow.breachedNodes}` +
      ` | enter: ${OOB_SOFT_ENTER_THRESHOLD.toFixed(2)}/${OOB_HARD_ENTER_THRESHOLD.toFixed(2)}` +
      ` exit: ${OOB_SOFT_EXIT_THRESHOLD.toFixed(3)}/${OOB_HARD_EXIT_THRESHOLD.toFixed(3)}` +
      pausedLabel;
  }
}

function syncAxisNoteVisibility() {
  if (axisNote) {
    axisNote.hidden = !axisNoteVisible;
  }
  if (axisNoteToggle) {
    axisNoteToggle.setAttribute("aria-pressed", String(axisNoteVisible));
  }
}

if (!toggleButton) {
  uiLog("ERROR: toggleButton missing");
}
if (!resetButton) {
  uiLog("ERROR: resetButton missing");
}

updateRunStatus();

uiLog("three imported");

const simulation = new MemoryFieldSimulation({ seed: 1337, tetra: SIMPLEX_VERTS });
updateOobStatus();

const sliderSpecs = [
  {
    key: "pressureGain",
    label: "pressureGain",
    min: 0.3,
    max: 1.8,
    step: 0.01,
    precision: 2,
    help: "How strongly activation accumulates into pressure (higher = faster consolidation).",
  },
  {
    key: "viscosity_u",
    label: "viscosity_u",
    min: 0,
    max: 0.95,
    step: 0.01,
    precision: 2,
    help: "Resistance to movement/write in intermediate tier (higher = stickier mid-level memory).",
  },
  {
    key: "viscosity_a",
    label: "viscosity_a",
    min: 0,
    max: 0.98,
    step: 0.01,
    precision: 2,
    help: "Resistance to movement/write in structural tier (higher = harder-to-change priors).",
  },
  {
    key: "threshold_mu",
    label: "threshold_mu",
    min: 0.2,
    max: 0.95,
    step: 0.01,
    precision: 2,
    help: "Pressure needed to consolidate from short-term → intermediate.",
  },
  {
    key: "threshold_ua",
    label: "threshold_ua",
    min: 0.35,
    max: 0.99,
    step: 0.01,
    precision: 2,
    help: "Pressure needed to consolidate into structural priors.",
  },
  {
    key: "maxStep",
    label: "maxStep",
    min: 0.002,
    max: 0.05,
    step: 0.001,
    precision: 3,
    help: "Maximum per-frame motion before damping (lower = smoother, less teleporting).",
  },
  {
    key: "damping",
    label: "damping",
    min: 0,
    max: 0.6,
    step: 0.01,
    precision: 2,
    help: "Velocity damping/inertia mix (higher = smoother, slower settling).",
  },
  {
    key: "clampStrength",
    label: "clampStrength",
    min: 0.05,
    max: 0.5,
    step: 0.01,
    precision: 2,
    help: "How strongly points are pulled back inside the tetrahedron when they drift out. Lower = more volumetric, higher = more boundary-hugging.",
  },
];

const PRESETS = {
  balanced: {
    pressureGain: 1.0,
    viscosity_u: 0.6,
    viscosity_a: 0.85,
    threshold_mu: 0.58,
    threshold_ua: 0.88,
    maxStep: 0.01,
    damping: 0.45,
    clampStrength: 0.32,
  },
  fast: {
    pressureGain: 1.3,
    viscosity_u: 0.5,
    viscosity_a: 0.78,
    threshold_mu: 0.45,
    threshold_ua: 0.75,
    maxStep: 0.008,
    damping: 0.5,
    clampStrength: 0.4,
  },
  sticky: {
    pressureGain: 0.95,
    viscosity_u: 0.85,
    viscosity_a: 0.94,
    threshold_mu: 0.6,
    threshold_ua: 0.88,
    maxStep: 0.009,
    damping: 0.48,
    clampStrength: 0.34,
  },
  reluctant: {
    pressureGain: 1.05,
    viscosity_u: 0.7,
    viscosity_a: 0.92,
    threshold_mu: 0.62,
    threshold_ua: 0.94,
    maxStep: 0.009,
    damping: 0.46,
    clampStrength: 0.35,
  },
  soft_breach: {
    pressureGain: 1.05,
    viscosity_u: 0.6,
    viscosity_a: 0.9,
    threshold_mu: 0.62,
    threshold_ua: 0.9,
    maxStep: 0.012,
    damping: 0.42,
    clampStrength: 0.28,
  },
  hard_break: {
    pressureGain: 1.15,
    viscosity_u: 0.45,
    viscosity_a: 0.82,
    threshold_mu: 0.65,
    threshold_ua: 0.94,
    maxStep: 0.03,
    damping: 0.22,
    clampStrength: 0.18,
  },
};

const sliderElements = new Map();

function setSliderUiValue(spec, value) {
  const controls = sliderElements.get(spec.key);
  if (!controls) {
    return;
  }
  controls.input.value = String(value);
  controls.output.value = Number(value).toFixed(spec.precision ?? 2);
}

for (const spec of sliderSpecs) {
  const row = document.createElement("div");
  row.className = "control-row";

  const label = document.createElement("label");
  label.textContent = spec.label;
  label.htmlFor = spec.key;
  label.title = spec.help;

  const output = document.createElement("output");
  output.htmlFor = spec.key;

  const input = document.createElement("input");
  input.type = "range";
  input.id = spec.key;
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(simulation.params[spec.key]);
  input.title = spec.help;

  const sync = () => {
    const value = Number(input.value);
    output.value = value.toFixed(spec.precision ?? 2);
    simulation.setParams({ [spec.key]: value });
  };

  input.addEventListener("input", sync);
  sync();

  row.append(label, output, input);
  controlsRoot.append(row);
  sliderElements.set(spec.key, { input, output, row });
}

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.style.position = "fixed";
renderer.domElement.style.inset = "0";
renderer.domElement.style.zIndex = "1";
renderer.domElement.style.pointerEvents = "auto";
renderer.domElement.style.display = "block";
document.body.appendChild(renderer.domElement);
uiLog("renderer created");

const scene = new THREE.Scene();
uiLog("scene created");

const simplexVertices = SIMPLEX_VERTS.map(([x, y, z]) => new THREE.Vector3(x, y, z));
const simplexCentroid = simplexVertices.reduce(
  (sum, vertex) => sum.add(vertex.clone()),
  new THREE.Vector3(),
).multiplyScalar(1 / simplexVertices.length);
const boundingRadius = simplexVertices.reduce(
  (maxRadius, vertex) => Math.max(maxRadius, vertex.distanceTo(simplexCentroid)),
  0,
);

const camera = new THREE.PerspectiveCamera(
  46,
  window.innerWidth / Math.max(1, window.innerHeight),
  Math.max(0.01, boundingRadius / 100),
  boundingRadius * 50,
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = true;
controls.minDistance = boundingRadius * 1.3;
controls.maxDistance = boundingRadius * 12;
controls.update();

const defaultViewDirection = new THREE.Vector3(1.1, 0.9, 1.25).normalize();
const defaultViewDistance = boundingRadius * 3.2;

function resetView() {
  camera.position.copy(simplexCentroid).addScaledVector(defaultViewDirection, defaultViewDistance);
  camera.near = Math.max(0.01, boundingRadius / 100);
  camera.far = boundingRadius * 50;
  camera.updateProjectionMatrix();
  camera.lookAt(simplexCentroid);
  controls.target.copy(simplexCentroid);
  controls.update();
}

resetView();

scene.add(new THREE.AmbientLight(0xffffff, 0.85));

const keyLight = new THREE.DirectionalLight(0xb5deff, 1.0);
keyLight.position.copy(simplexCentroid).add(new THREE.Vector3(boundingRadius * 2.5, boundingRadius * 3.0, boundingRadius * 2.8));
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
fillLight.position.copy(simplexCentroid).add(new THREE.Vector3(-boundingRadius * 2.2, boundingRadius * 1.2, -boundingRadius * 2.0));
scene.add(fillLight);

const axesHelper = new THREE.AxesHelper(2.0);
axesHelper.material.transparent = true;
axesHelper.material.opacity = 0.35;
axesHelper.visible = false;
scene.add(axesHelper);

const centroidMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.05, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }),
);
centroidMarker.position.copy(simplexCentroid);
centroidMarker.visible = false;
scene.add(centroidMarker);
syncAxisNoteVisibility();

const edgePairs = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

const edgePoints = [];
for (const [a, b] of edgePairs) {
  edgePoints.push(simplexVertices[a], simplexVertices[b]);
}

const tetraWire = new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints(edgePoints),
  new THREE.LineBasicMaterial({
    color: 0xb8c4cc,
    transparent: true,
    opacity: 0.85,
  }),
);
scene.add(tetraWire);

const hullGeometry = new THREE.BufferGeometry();
const hullPositions = new Float32Array([
  ...SIMPLEX_VERTS[0], ...SIMPLEX_VERTS[1], ...SIMPLEX_VERTS[2],
  ...SIMPLEX_VERTS[0], ...SIMPLEX_VERTS[3], ...SIMPLEX_VERTS[1],
  ...SIMPLEX_VERTS[0], ...SIMPLEX_VERTS[2], ...SIMPLEX_VERTS[3],
  ...SIMPLEX_VERTS[1], ...SIMPLEX_VERTS[3], ...SIMPLEX_VERTS[2],
]);
hullGeometry.setAttribute("position", new THREE.BufferAttribute(hullPositions, 3));

const hull = new THREE.Mesh(
  hullGeometry,
  new THREE.MeshBasicMaterial({
    color: 0x4b6b7a,
    transparent: true,
    opacity: 0.04,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }),
);
hull.visible = false;
scene.add(hull);

function createPointCloud(count, size, opacity) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));

  const material = new THREE.PointsMaterial({
    size,
    vertexColors: true,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    sizeAttenuation: false,
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);
  return points;
}

const nodeCloud = createPointCloud(simulation.shortNodes.length, 4, 0.98);
const intermediateAnchorCloud = createPointCloud(simulation.intermediateNodes.length, 6, 0.45);
const structuralAnchorCloud = createPointCloud(simulation.structuralNodes.length, 10, 0.55);

function baryToXYZ(w, verts3) {
  return [
    w[0] * verts3[0][0] + w[1] * verts3[1][0] + w[2] * verts3[2][0] + w[3] * verts3[3][0],
    w[0] * verts3[0][1] + w[1] * verts3[1][1] + w[2] * verts3[2][1] + w[3] * verts3[3][1],
    w[0] * verts3[0][2] + w[1] * verts3[1][2] + w[2] * verts3[2][2] + w[3] * verts3[3][2],
  ];
}

function nodeToXYZ(node) {
  if (Array.isArray(node.pos) && node.pos.length === 4) {
    return baryToXYZ(node.pos, SIMPLEX_VERTS);
  }
  if (Array.isArray(node.pos) && node.pos.length === 3) {
    return node.pos;
  }
  return [0, 0, 0];
}

function computeNodeRanges(nodes) {
  if (!nodes.length) {
    return {
      x: [0, 0],
      y: [0, 0],
      z: [0, 0],
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < nodes.length; i += 1) {
    const [x, y, z] = nodeToXYZ(nodes[i]);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  return {
    x: [minX, maxX],
    y: [minY, maxY],
    z: [minZ, maxZ],
  };
}

function computeNodeCentroid(nodes) {
  if (!nodes.length) {
    return new THREE.Vector3();
  }

  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const [x, y, z] = nodeToXYZ(nodes[i]);
    sumX += x;
    sumY += y;
    sumZ += z;
  }

  return new THREE.Vector3(sumX / nodes.length, sumY / nodes.length, sumZ / nodes.length);
}

const shortTierColor = new THREE.Color("#00E5FF");
const midTierColor = new THREE.Color("#FF2D95");
const structuralTierColor = new THREE.Color("#FFE600");

function updatePointCloud() {
  const nodePositions = nodeCloud.geometry.attributes.position.array;
  const nodeColors = nodeCloud.geometry.attributes.color.array;
  const midPositions = intermediateAnchorCloud.geometry.attributes.position.array;
  const midColors = intermediateAnchorCloud.geometry.attributes.color.array;
  const structPositions = structuralAnchorCloud.geometry.attributes.position.array;
  const structColors = structuralAnchorCloud.geometry.attributes.color.array;

  for (let i = 0; i < simulation.shortNodes.length; i += 1) {
    const node = simulation.shortNodes[i];
    const xyz = nodeToXYZ(node);
    nodePositions[i * 3] = xyz[0];
    nodePositions[i * 3 + 1] = xyz[1];
    nodePositions[i * 3 + 2] = xyz[2];

    const color = node.tier === 2 ? structuralTierColor : node.tier === 1 ? midTierColor : shortTierColor;

    nodeColors[i * 3] = color.r;
    nodeColors[i * 3 + 1] = color.g;
    nodeColors[i * 3 + 2] = color.b;
  }

  for (let i = 0; i < simulation.intermediateNodes.length; i += 1) {
    const node = simulation.intermediateNodes[i];
    const xyz = nodeToXYZ(node);
    midPositions[i * 3] = xyz[0];
    midPositions[i * 3 + 1] = xyz[1];
    midPositions[i * 3 + 2] = xyz[2];
    midColors[i * 3] = midTierColor.r;
    midColors[i * 3 + 1] = midTierColor.g;
    midColors[i * 3 + 2] = midTierColor.b;
  }

  for (let i = 0; i < simulation.structuralNodes.length; i += 1) {
    const node = simulation.structuralNodes[i];
    const xyz = nodeToXYZ(node);
    structPositions[i * 3] = xyz[0];
    structPositions[i * 3 + 1] = xyz[1];
    structPositions[i * 3 + 2] = xyz[2];
    structColors[i * 3] = structuralTierColor.r;
    structColors[i * 3 + 1] = structuralTierColor.g;
    structColors[i * 3 + 2] = structuralTierColor.b;
  }

  nodeCloud.geometry.attributes.position.needsUpdate = true;
  nodeCloud.geometry.attributes.color.needsUpdate = true;
  intermediateAnchorCloud.geometry.attributes.position.needsUpdate = true;
  intermediateAnchorCloud.geometry.attributes.color.needsUpdate = true;
  structuralAnchorCloud.geometry.attributes.position.needsUpdate = true;
  structuralAnchorCloud.geometry.attributes.color.needsUpdate = true;
}

function updateCounts() {
  let shortCount = 0;
  let intermediateCount = 0;
  let structuralCount = 0;
  for (let i = 0; i < simulation.shortNodes.length; i += 1) {
    const tier = simulation.shortNodes[i].tier;
    if (tier === 2) {
      structuralCount += 1;
    } else if (tier === 1) {
      intermediateCount += 1;
    } else {
      shortCount += 1;
    }
  }
  countsRoot.innerHTML = [
    `Short-term nodes (tier 0): <strong>${shortCount}</strong>`,
    `Consolidated nodes (tier 1): <strong>${intermediateCount}</strong>`,
    `Structural priors (tier 2): <strong>${structuralCount}</strong>`,
  ].join("<br />");
}

function resetSimulation() {
  simulation.reset();
  lastOobWindow = { ...EMPTY_OOB_WINDOW_STATS };
  const balancedPreset = PRESETS.balanced;
  simulation.setParams(balancedPreset);
  for (const spec of sliderSpecs) {
    const controls = sliderElements.get(spec.key);
    if (!controls) {
      continue;
    }
    controls.input.value = String(simulation.params[spec.key]);
    controls.input.dispatchEvent(new Event("input"));
  }
  if (presetSelect) {
    presetSelect.value = "balanced";
  }
  updatePointCloud();
  updateCounts();
  updateOobStatus();
}

function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) {
    uiLog(`ERROR: unknown preset key "${key}"`);
    return;
  }
  uiLog(`Preset selected: ${key}`);

  simulation.reset();
  lastOobWindow = { ...EMPTY_OOB_WINDOW_STATS };
  simulation.setParams(preset);
  for (const spec of sliderSpecs) {
    const controls = sliderElements.get(spec.key);
    if (!controls) {
      continue;
    }
    controls.input.value = String(simulation.params[spec.key]);
    controls.input.dispatchEvent(new Event("input"));
  }
  isRunning = false;
  if (toggleButton) {
    toggleButton.textContent = "Play";
  }
  updateRunStatus();
  updatePointCloud();
  updateCounts();
  updateOobStatus();
  uiLog(`Preset applied: ${key}`);
  uiLog(
    `Applied values: pressureGain=${simulation.params.pressureGain.toFixed(2)} ` +
      `viscosity_u=${simulation.params.viscosity_u.toFixed(2)} ` +
      `viscosity_a=${simulation.params.viscosity_a.toFixed(2)} ` +
      `threshold_mu=${simulation.params.threshold_mu.toFixed(2)} ` +
      `threshold_ua=${simulation.params.threshold_ua.toFixed(2)} ` +
      `maxStep=${simulation.params.maxStep.toFixed(3)} ` +
      `damping=${simulation.params.damping.toFixed(2)} ` +
      `clampStrength=${simulation.params.clampStrength.toFixed(2)}`,
  );
  uiLog(
    `OOB thresholds: enter soft/hard=${OOB_SOFT_ENTER_THRESHOLD.toFixed(2)}/${OOB_HARD_ENTER_THRESHOLD.toFixed(2)} ` +
      `exit soft/hard=${OOB_SOFT_EXIT_THRESHOLD.toFixed(3)}/${OOB_HARD_EXIT_THRESHOLD.toFixed(3)}`,
  );
}

if (toggleButton) {
  toggleButton.textContent = "Play";
  toggleButton.addEventListener("click", () => {
    uiLog("Play clicked");
    isRunning = !isRunning;
    toggleButton.textContent = isRunning ? "Pause" : "Play";
    updateRunStatus();
  });
}

if (resetButton) {
  resetButton.addEventListener("click", () => {
    uiLog("Reset clicked");
    resetSimulation();
    isRunning = false;
    if (toggleButton) {
      toggleButton.textContent = "Play";
    }
    updateRunStatus();
  });
}

if (resetViewButton) {
  resetViewButton.addEventListener("click", () => {
    uiLog("Reset View clicked");
    resetView();
  });
}

if (exportButton) {
  exportButton.addEventListener("click", () => {
    uiLog("Export clicked");
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = url;
    link.download = "tetrahedral-memory-field.png";
    link.click();
  });
}

if (axisNoteToggle) {
  axisNoteToggle.addEventListener("click", () => {
    axisNoteVisible = !axisNoteVisible;
    syncAxisNoteVisibility();
  });
}

if (showHullToggle) {
  showHullToggle.addEventListener("change", () => {
    hull.visible = showHullToggle.checked;
    uiLog(`Show hull: ${showHullToggle.checked}`);
  });
}

if (autoCenterToggle) {
  autoCenterToggle.addEventListener("change", () => {
    uiLog(`Auto-center: ${autoCenterToggle.checked}`);
  });
}

if (logSoftToggle) {
  logSoftToggle.addEventListener("change", () => {
    uiLog(`Log SOFT: ${logSoftToggle.checked}`);
  });
}

if (presetSelect) {
  presetSelect.addEventListener("change", () => {
    applyPreset(presetSelect.value);
  });
}

if (applyPresetButton) {
  applyPresetButton.addEventListener("click", () => {
    const presetKey = presetSelect ? presetSelect.value : "balanced";
    applyPreset(presetKey);
  });
} else {
  uiLog("ERROR: applyPresetButton missing");
}

window.addEventListener("resize", () => {
  try {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    camera.updateProjectionMatrix();
    controls.update();
  } catch (error) {
    uiLog(`RESIZE EXCEPTION: ${error && error.stack ? error.stack : String(error)}`);
  }
});

function formatVector(vector) {
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}

function updateDebugOverlay(now) {
  if (!debugOverlay) {
    return;
  }

  if (!debugVisible) {
    debugOverlay.hidden = true;
    return;
  }

  debugOverlay.hidden = false;
  if (now - lastDebugUpdate < 1000) {
    return;
  }

  const elapsedSeconds = Math.max(0.001, (now - lastDebugUpdate) / 1000);
  const fps = (frameCount - framesAtLastDebug) / elapsedSeconds;
  framesAtLastDebug = frameCount;
  lastDebugUpdate = now;
  const shortRanges = computeNodeRanges(simulation.shortNodes);

  debugOverlay.textContent = [
    `Objects: ${scene.children.length}`,
    `Camera: ${formatVector(camera.position)}`,
    `Wire: ${tetraWire.geometry.getAttribute("position").count > 0 ? "yes" : "no"}`,
    `Points: ${[nodeCloud, intermediateAnchorCloud, structuralAnchorCloud].every((cloud) => cloud.geometry.getAttribute("position").count > 0) ? "yes" : "no"}`,
    `rangeX: ${shortRanges.x[0].toFixed(2)}..${shortRanges.x[1].toFixed(2)}`,
    `rangeY: ${shortRanges.y[0].toFixed(2)}..${shortRanges.y[1].toFixed(2)}`,
    `rangeZ: ${shortRanges.z[0].toFixed(2)}..${shortRanges.z[1].toFixed(2)}`,
    `FPS: ${fps.toFixed(1)}`,
  ].join("\n");
}

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "d") {
    debugVisible = !debugVisible;
    uiLog(`debug ${debugVisible ? "shown" : "hidden"}`);
    updateDebugOverlay(performance.now());
  }
});

resetSimulation();
updateRunStatus();
updateOobStatus();
uiLog("three init ok");

function animate(timestamp) {
  requestAnimationFrame(animate);

  try {
    frameCount += 1;

    if (isRunning) {
      simulation.step();
      updatePointCloud();
      updateCounts();
    }

    if (isRunning && autoCenterToggle?.checked && timestamp - lastAutoCenterUpdate >= 1000) {
      lastAutoCenterUpdate = timestamp;
      const liveCentroid = computeNodeCentroid(simulation.shortNodes);
      controls.target.lerp(liveCentroid, 0.65);
    }

    while (simulation.oobLogQueue.length) {
      const event = simulation.oobLogQueue.shift();
      const severity = typeof event === "string" ? "HARD" : event.severity;
      const message = typeof event === "string" ? event : event.message;
      if (severity === "HARD" || logSoftToggle?.checked) {
        uiLog(message);
      }
      wireFlashColor = severity === "HARD" ? "#ff4d4f" : "#ffe600";
      wireFlashUntil = performance.now() + 300;
    }

    tetraWire.material.color.set(performance.now() < wireFlashUntil ? wireFlashColor : "#b8c4cc");

    centroidMarker.rotation.y += 0.01;

    controls.update();
    renderer.render(scene, camera);

    if (timestamp - lastRunStatusUpdate >= 1000) {
      lastRunStatusUpdate = timestamp;
      updateRunStatus();
    }

    if (timestamp - lastOobStatusUpdate >= 1000) {
      lastOobStatusUpdate = timestamp;
      if (isRunning) {
        lastOobWindow = simulation.consumeOobWindowStats();
      }
      updateOobStatus();
    }

    updateDebugOverlay(timestamp);
  } catch (error) {
    uiLog(`ANIMATE EXCEPTION: ${error && error.stack ? error.stack : String(error)}`);
  }
}

if (!animationStarted) {
  animationStarted = true;
  requestAnimationFrame(animate);
  uiLog("loop scheduled");
}
