import { createRng } from "./random.js";

const SIMPLEX_RADIUS = 1.7;

export const SIMPLEX_VERTS = [
  [0, SIMPLEX_RADIUS, 0],
  [(2 * Math.sqrt(2) * SIMPLEX_RADIUS) / 3, -SIMPLEX_RADIUS / 3, 0],
  [(-Math.sqrt(2) * SIMPLEX_RADIUS) / 3, -SIMPLEX_RADIUS / 3, Math.sqrt(2 / 3) * SIMPLEX_RADIUS],
  [(-Math.sqrt(2) * SIMPLEX_RADIUS) / 3, -SIMPLEX_RADIUS / 3, -Math.sqrt(2 / 3) * SIMPLEX_RADIUS],
];

const TOP_RANGE = {
  short: [0.04, 0.22],
  intermediate: [0.25, 0.52],
  structural: [0.58, 0.88],
};

const DEFAULT_PARAMS = {
  pressureGain: 1.24,
  viscosity_u: 0.45,
  viscosity_a: 0.66,
  threshold_mu: 0.5,
  threshold_ua: 0.67,
  maxStep: 0.02,
  damping: 0.25,
  clampStrength: 0.2,
  oobThreshold: 0.02,
  oobConsecutive: 3,
};

export const OOB_SOFT_ENTER_THRESHOLD = 0.02;
export const OOB_SOFT_EXIT_THRESHOLD = 0.015;
export const OOB_HARD_ENTER_THRESHOLD = 0.1;
export const OOB_HARD_EXIT_THRESHOLD = 0.085;
export const OOB_EVENT_COOLDOWN_FRAMES = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function addScaled(out, direction, scale) {
  out[0] += direction[0] * scale;
  out[1] += direction[1] * scale;
  out[2] += direction[2] * scale;
}

function distanceSquared(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function magnitude(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function severityRank(severity) {
  if (severity === "HARD") {
    return 2;
  }
  if (severity === "SOFT") {
    return 1;
  }
  return 0;
}

function invert3x3(matrix) {
  const [m00, m01, m02] = matrix[0];
  const [m10, m11, m12] = matrix[1];
  const [m20, m21, m22] = matrix[2];

  const c00 = m11 * m22 - m12 * m21;
  const c01 = m02 * m21 - m01 * m22;
  const c02 = m01 * m12 - m02 * m11;
  const c10 = m12 * m20 - m10 * m22;
  const c11 = m00 * m22 - m02 * m20;
  const c12 = m02 * m10 - m00 * m12;
  const c20 = m10 * m21 - m11 * m20;
  const c21 = m01 * m20 - m00 * m21;
  const c22 = m00 * m11 - m01 * m10;

  const determinant = m00 * c00 + m01 * c10 + m02 * c20;
  const invDet = 1 / determinant;

  return [
    [c00 * invDet, c01 * invDet, c02 * invDet],
    [c10 * invDet, c11 * invDet, c12 * invDet],
    [c20 * invDet, c21 * invDet, c22 * invDet],
  ];
}

function multiplyMat3Vec3(matrix, vector) {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
  ];
}

export class MemoryFieldSimulation {
  constructor({ seed = 1337, tetra = SIMPLEX_VERTS } = {}) {
    this.seed = seed;
    this.params = { ...DEFAULT_PARAMS };
    this.frame = 0;
    this.tetra = tetra.map((vertex) => [...vertex]);
    this.origin = [...this.tetra[0]];
    this.edgeMatrix = [
      [
        this.tetra[1][0] - this.origin[0],
        this.tetra[2][0] - this.origin[0],
        this.tetra[3][0] - this.origin[0],
      ],
      [
        this.tetra[1][1] - this.origin[1],
        this.tetra[2][1] - this.origin[1],
        this.tetra[3][1] - this.origin[1],
      ],
      [
        this.tetra[1][2] - this.origin[2],
        this.tetra[2][2] - this.origin[2],
        this.tetra[3][2] - this.origin[2],
      ],
    ];
    this.inverseEdgeMatrix = invert3x3(this.edgeMatrix);
    this.reset();
  }

  setParams(nextParams) {
    Object.assign(this.params, nextParams);
  }

  reset() {
    this.rng = createRng(this.seed);
    this.frame = 0;
    this.oobSoftCount = 0;
    this.oobHardCount = 0;
    this.lastV = 0;
    this.lastSeverity = "OK";
    this.oobLogQueue = [];
    this.peakVThisSecond = 0;
    this.peakSeverityThisSecond = "OK";
    this.breachedNodesThisSecond = new Set();
    this.shortNodes = Array.from({ length: 400 }, (_, index) => this.createShortNode(index));
    this.intermediateNodes = Array.from({ length: 60 }, () => this.createAnchor("intermediate"));
    this.structuralNodes = Array.from({ length: 8 }, () => this.createAnchor("structural"));
    for (let i = 0; i < this.shortNodes.length; i += 1) {
      const node = this.shortNodes[i];
      node.tier = 0;
      node.pressure = 0;
      node.activation = 0;
      node.aboveUaFrames = 0;
      node.oobCounter = 0;
      node.previousSeverity = "OK";
      node.cooldownFrames = 0;
      if (Array.isArray(node.vel)) {
        node.vel[0] = 0;
        node.vel[1] = 0;
        node.vel[2] = 0;
      } else {
        node.vel = [0, 0, 0];
      }
    }
  }

  createShortNode(index) {
    const bary = this.randomBaryInBand(TOP_RANGE.short);
    const phaseOffset = this.rng() * Math.PI * 2;
    return {
      index,
      bary,
      pos: this.baryToCartesian(bary),
      vel: [0, 0, 0],
      oobCounter: 0,
      activation: 0.2 + this.rng() * 0.25,
      pressure: 0.18 + this.rng() * 0.2,
      aboveUaFrames: 0,
      phaseOffset,
      tier: 0,
      previousSeverity: "OK",
      cooldownFrames: 0,
    };
  }

  createAnchor(kind) {
    const band = kind === "structural" ? TOP_RANGE.structural : TOP_RANGE.intermediate;
    const bary = this.randomBaryInBand(band);
    return {
      kind,
      bary,
      pos: this.baryToCartesian(bary),
      vel: [0, 0, 0],
      driftTarget: this.randomBaryInBand(band),
    };
  }

  consumeOobWindowStats() {
    const snapshot = {
      peakV: this.peakVThisSecond,
      peakSeverity: this.peakSeverityThisSecond,
      breachedNodes: this.breachedNodesThisSecond.size,
    };
    this.peakVThisSecond = 0;
    this.peakSeverityThisSecond = "OK";
    this.breachedNodesThisSecond.clear();
    return snapshot;
  }

  recordOobWindowSample(nodeIndex, violationMass, severity) {
    if (violationMass > 0) {
      this.breachedNodesThisSecond.add(nodeIndex);
    }
    if (violationMass > this.peakVThisSecond) {
      this.peakVThisSecond = violationMass;
    }
    if (severityRank(severity) > severityRank(this.peakSeverityThisSecond)) {
      this.peakSeverityThisSecond = severity;
    }
  }

  randomBaryInBand([minTop, maxTop]) {
    const weights = [];
    let sum = 0;
    for (let i = 0; i < 4; i += 1) {
      const value = -Math.log(Math.max(1e-6, this.rng()));
      weights.push(value);
      sum += value;
    }

    for (let i = 0; i < 4; i += 1) {
      weights[i] /= sum;
    }

    const topWeight = lerp(minTop, maxTop, this.rng());
    const remaining = Math.max(1e-6, 1 - weights[0]);
    const scale = (1 - topWeight) / remaining;
    weights[0] = topWeight;

    for (let i = 1; i < 4; i += 1) {
      weights[i] *= scale;
    }

    return weights;
  }

  baryToCartesian(bary) {
    const out = [0, 0, 0];
    for (let i = 0; i < 4; i += 1) {
      out[0] += this.tetra[i][0] * bary[i];
      out[1] += this.tetra[i][1] * bary[i];
      out[2] += this.tetra[i][2] * bary[i];
    }
    return out;
  }

  cartesianToBary(point) {
    const offset = [
      point[0] - this.origin[0],
      point[1] - this.origin[1],
      point[2] - this.origin[2],
    ];
    const [w1, w2, w3] = multiplyMat3Vec3(this.inverseEdgeMatrix, offset);
    const w0 = 1 - w1 - w2 - w3;

    return [w0, w1, w2, w3];
  }

  sanitizeBary(rawBary, band = null) {
    const bary = [...rawBary];
    for (let i = 0; i < 4; i += 1) {
      bary[i] = Math.max(0, bary[i]);
    }

    let sum = bary[0] + bary[1] + bary[2] + bary[3];
    if (sum <= 1e-8) {
      bary[0] = 0.25;
      bary[1] = 0.25;
      bary[2] = 0.25;
      bary[3] = 0.25;
      sum = 1;
    }

    for (let i = 0; i < 4; i += 1) {
      bary[i] /= sum;
    }

    if (band) {
      const [minTop, maxTop] = band;
      const targetTop = clamp(bary[0], minTop, maxTop);
      const others = Math.max(1e-6, bary[1] + bary[2] + bary[3]);
      const scale = (1 - targetTop) / others;
      bary[0] = targetTop;
      bary[1] *= scale;
      bary[2] *= scale;
      bary[3] *= scale;
    }

    const margin = 0.05;
    const biasStrength = 0.15;
    let biased = false;
    for (let i = 0; i < 4; i += 1) {
      if (bary[i] < margin) {
        bary[i] += biasStrength * (margin - bary[i]);
        biased = true;
      }
    }

    if (biased) {
      const biasedSum = bary[0] + bary[1] + bary[2] + bary[3];
      for (let i = 0; i < 4; i += 1) {
        bary[i] /= biasedSum;
      }
    }

    return bary;
  }

  clampPoint(point, band = null) {
    const hardBary = this.sanitizeBary(this.cartesianToBary(point), band);
    const projectedPos = this.baryToCartesian(hardBary);
    const clampStrength = clamp(this.params.clampStrength, 0.05, 0.5);
    const blendedPos = [
      point[0] + (projectedPos[0] - point[0]) * clampStrength,
      point[1] + (projectedPos[1] - point[1]) * clampStrength,
      point[2] + (projectedPos[2] - point[2]) * clampStrength,
    ];
    const bary = this.sanitizeBary(this.cartesianToBary(blendedPos), band);

    return {
      bary,
      pos: this.baryToCartesian(bary),
    };
  }

  findNearest(point, collection) {
    let nearest = collection[0];
    let nearestDistance = Infinity;

    for (let i = 0; i < collection.length; i += 1) {
      const candidate = collection[i];
      const d2 = distanceSquared(point, candidate.pos);
      if (d2 < nearestDistance) {
        nearestDistance = d2;
        nearest = candidate;
      }
    }

    return nearest;
  }

  applyMotion(node, desiredPos, band) {
    const maxStep = Math.max(0.002, this.params.maxStep);
    const damping = clamp(this.params.damping, 0, 0.6);
    const previousPos = [...node.pos];
    const delta = [
      desiredPos[0] - node.pos[0],
      desiredPos[1] - node.pos[1],
      desiredPos[2] - node.pos[2],
    ];
    const deltaMagnitude = magnitude(delta);

    if (deltaMagnitude > maxStep) {
      const scale = maxStep / deltaMagnitude;
      delta[0] *= scale;
      delta[1] *= scale;
      delta[2] *= scale;
    }

    node.vel[0] = node.vel[0] * (1 - damping) + delta[0];
    node.vel[1] = node.vel[1] * (1 - damping) + delta[1];
    node.vel[2] = node.vel[2] * (1 - damping) + delta[2];

    const nextPos = [
      node.pos[0] + node.vel[0],
      node.pos[1] + node.vel[1],
      node.pos[2] + node.vel[2],
    ];
    if (Object.prototype.hasOwnProperty.call(node, "oobCounter")) {
      const rawBary = this.cartesianToBary(nextPos);
      const violationMass =
        Math.max(0, -rawBary[0]) +
        Math.max(0, -rawBary[1]) +
        Math.max(0, -rawBary[2]) +
        Math.max(0, -rawBary[3]);
      let severity = "OK";
      if (node.previousSeverity === "HARD") {
        if (violationMass > OOB_HARD_EXIT_THRESHOLD) {
          severity = "HARD";
        } else if (violationMass >= OOB_SOFT_ENTER_THRESHOLD) {
          severity = "SOFT";
        }
      } else if (node.previousSeverity === "SOFT") {
        if (violationMass >= OOB_HARD_ENTER_THRESHOLD) {
          severity = "HARD";
        } else if (violationMass > OOB_SOFT_EXIT_THRESHOLD) {
          severity = "SOFT";
        }
      } else if (violationMass >= OOB_HARD_ENTER_THRESHOLD) {
        severity = "HARD";
      } else if (violationMass >= OOB_SOFT_ENTER_THRESHOLD) {
        severity = "SOFT";
      }
      this.lastV = violationMass;
      this.lastSeverity = severity;
      this.recordOobWindowSample(node.index, violationMass, severity);

      if (node.cooldownFrames > 0) {
        node.cooldownFrames -= 1;
      }

      const isCoolingDown = node.cooldownFrames > 0;

      if (!isCoolingDown && severity === "SOFT" && node.previousSeverity === "OK") {
        this.oobSoftCount += 1;
        node.cooldownFrames = OOB_EVENT_COOLDOWN_FRAMES;
        this.oobLogQueue.push({
          severity,
          message: `OOB ${severity} V=${violationMass.toFixed(4)} node=${node.index} frame=${this.frame}`,
        });
      } else if (
        !isCoolingDown &&
        severity === "HARD" &&
        (node.previousSeverity === "OK" || node.previousSeverity === "SOFT")
      ) {
        this.oobHardCount += 1;
        node.cooldownFrames = OOB_EVENT_COOLDOWN_FRAMES;
        this.oobLogQueue.push({
          severity,
          message: `OOB ${severity} V=${violationMass.toFixed(4)} node=${node.index} frame=${this.frame}`,
        });
      }
      node.oobCounter = severity === "OK" ? 0 : 1;
      node.previousSeverity = severity === "OK" ? "OK" : severity;
    }
    const clamped = this.clampPoint(nextPos, band);
    node.bary = clamped.bary;
    node.pos = clamped.pos;
    node.vel[0] = clamped.pos[0] - previousPos[0];
    node.vel[1] = clamped.pos[1] - previousPos[1];
    node.vel[2] = clamped.pos[2] - previousPos[2];
  }

  step() {
    this.frame += 1;
    const params = this.params;
    const muStay = params.threshold_mu * 0.72;
    const uaStay = params.threshold_ua * 0.76;
    const midViscosity = Math.max(0.02, 1 - params.viscosity_u);
    const structuralViscosity = Math.max(0.015, 1 - params.viscosity_a);

    for (let i = 0; i < this.shortNodes.length; i += 1) {
      const node = this.shortNodes[i];
      const oscillation = 0.5 + 0.5 * Math.sin(node.phaseOffset + this.frame * 0.032 + node.index * 0.07);
      const stochastic = this.rng();
      node.activation = clamp(
        (0.2 + 0.8 * oscillation) * (0.35 + params.pressureGain * 0.65) + stochastic * 0.18,
        0,
        1,
      );
      node.pressure = clamp(node.pressure * 0.9 + node.activation * 0.1, 0, 1);

      if (node.pressure > params.threshold_ua) {
        node.aboveUaFrames += 1;
      } else {
        node.aboveUaFrames = Math.max(0, node.aboveUaFrames - 2);
      }

      if (node.tier === 2 && node.pressure < uaStay) {
        node.tier = 1;
      }
      if (node.tier >= 1 && node.pressure < muStay) {
        node.tier = 0;
      }
      if (node.pressure > params.threshold_mu) {
        node.tier = Math.max(node.tier, 1);
      }
      if (node.aboveUaFrames > 28) {
        node.tier = 2;
      }

      // All short-term nodes keep a small stochastic motion; higher tiers are
      // more stable and therefore jitter less.
      const jitterScale = node.tier === 0 ? 0.009 : node.tier === 1 ? 0.006 : 0.0035;
      const desiredPos = [
        node.pos[0] + (this.rng() - 0.5) * jitterScale,
        node.pos[1] + (this.rng() - 0.5) * jitterScale,
        node.pos[2] + (this.rng() - 0.5) * jitterScale,
      ];

      if (node.tier === 0) {
        desiredPos[1] -= 0.003;
      } else if (node.tier === 1) {
        const nearestIntermediate = this.findNearest(desiredPos, this.intermediateNodes);
        addScaled(
          desiredPos,
          [
            nearestIntermediate.pos[0] - desiredPos[0],
            nearestIntermediate.pos[1] - desiredPos[1],
            nearestIntermediate.pos[2] - desiredPos[2],
          ],
          0.018 * midViscosity,
        );
        desiredPos[1] += 0.008 * midViscosity;
      } else {
        const nearestStructural = this.findNearest(desiredPos, this.structuralNodes);
        addScaled(
          desiredPos,
          [
            nearestStructural.pos[0] - desiredPos[0],
            nearestStructural.pos[1] - desiredPos[1],
            nearestStructural.pos[2] - desiredPos[2],
          ],
          0.012 * structuralViscosity,
        );
        desiredPos[1] += 0.006 * structuralViscosity;
      }

      const band =
        node.tier === 0
          ? TOP_RANGE.short
          : node.tier === 1
            ? [TOP_RANGE.short[0], TOP_RANGE.intermediate[1]]
            : [TOP_RANGE.intermediate[0], TOP_RANGE.structural[1]];
      this.applyMotion(node, desiredPos, band);
    }

    this.updateAnchors(this.intermediateNodes, "intermediate");
    this.updateAnchors(this.structuralNodes, "structural");

    if (this.frame <= 5) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;

      for (let i = 0; i < this.shortNodes.length; i += 1) {
        const node = this.shortNodes[i];
        minX = Math.min(minX, node.pos[0]);
        maxX = Math.max(maxX, node.pos[0]);
        minZ = Math.min(minZ, node.pos[2]);
        maxZ = Math.max(maxZ, node.pos[2]);
      }

      if (maxX - minX < 1e-3 || maxZ - minZ < 1e-3) {
        throw new Error("DEGENERATE: ranges collapsed after step");
      }
    }
  }

  updateAnchors(anchors, kind) {
    const band = kind === "structural" ? TOP_RANGE.structural : TOP_RANGE.intermediate;
    const sourceTier = kind === "structural" ? 2 : 1;
    const viscosity =
      kind === "structural" ? Math.max(0.01, 1 - this.params.viscosity_a) : Math.max(0.015, 1 - this.params.viscosity_u);
    const speed = kind === "structural" ? 0.0035 : 0.008;
    const assignments = Array.from({ length: anchors.length }, () => ({
      sum: [0, 0, 0],
      count: 0,
    }));

    for (let i = 0; i < this.shortNodes.length; i += 1) {
      const node = this.shortNodes[i];
      if (node.tier < sourceTier) {
        continue;
      }

      let nearestIndex = 0;
      let nearestDistance = Infinity;
      for (let j = 0; j < anchors.length; j += 1) {
        const d2 = distanceSquared(node.pos, anchors[j].pos);
        if (d2 < nearestDistance) {
          nearestDistance = d2;
          nearestIndex = j;
        }
      }

      const assignment = assignments[nearestIndex];
      assignment.sum[0] += node.pos[0];
      assignment.sum[1] += node.pos[1];
      assignment.sum[2] += node.pos[2];
      assignment.count += 1;
    }

    for (let i = 0; i < anchors.length; i += 1) {
      const anchor = anchors[i];
      const assignment = assignments[i];

      if (assignment.count > 0) {
        // Re-anchor to the centroid of the currently consolidating nodes in this tier.
        anchor.driftTarget = this.clampPoint(
          [
            assignment.sum[0] / assignment.count,
            assignment.sum[1] / assignment.count + (kind === "structural" ? 0.07 : 0.03),
            assignment.sum[2] / assignment.count,
          ],
          band,
        ).bary;
      } else if (distanceSquared(anchor.pos, this.baryToCartesian(anchor.driftTarget)) < 0.01) {
        anchor.driftTarget = this.randomBaryInBand(band);
      }

      const targetPoint = this.baryToCartesian(anchor.driftTarget);
      const desiredPos = [...anchor.pos];
      addScaled(
        desiredPos,
        [
          targetPoint[0] - desiredPos[0],
          targetPoint[1] - desiredPos[1],
          targetPoint[2] - desiredPos[2],
        ],
        speed * viscosity,
      );
      this.applyMotion(anchor, desiredPos, band);
    }
  }

  getTierCounts() {
    const counts = [0, 0, 0];
    for (let i = 0; i < this.shortNodes.length; i += 1) {
      counts[this.shortNodes[i].tier] += 1;
    }
    return counts;
  }
}
