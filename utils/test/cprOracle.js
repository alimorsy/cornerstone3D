/**
 * Independent ground truth for the CPR tests: analytic centerline curves with
 * exact positions, tangents, arc lengths and (for planar curves) exact
 * parallel-transport frames, and the forward CPR sampling map derived from
 * the vtkImageCPRMapper shader. Nothing here imports production code,
 * vtk.js or gl-matrix, so agreement with the production mapping is a
 * cross-check between two independent implementations rather than
 * self-consistency.
 */

export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen = (a) => Math.sqrt(vdot(a, a));
export const vnorm = (a) => {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const vdist = (a, b) => vlen(vsub(a, b));
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Applies a frame (three orthonormal column axes) to a local vector. */
export function frameApply(frame, v) {
  return vadd(
    vadd(vscale(frame.x, v[0]), vscale(frame.y, v[1])),
    vscale(frame.z, v[2])
  );
}

/**
 * Straight line from `origin` along `dir`. The frame is constant:
 * x = `normal`, y = z × x, z = dir.
 */
export function straightCurve(origin, dir, length, normal = [1, 0, 0]) {
  const z = vnorm(dir);
  const x = vnorm(vsub(normal, vscale(z, vdot(normal, z))));
  const y = vcross(z, x);
  return {
    length,
    posAt: (s) => vadd(origin, vscale(z, clamp(s, 0, length))),
    tangentAt: () => z,
    frameAt: () => ({ x, y, z }),
  };
}

/**
 * Planar quarter arc of radius R in the XY plane, starting at `origin`
 * heading +X and curving toward +Y: p(θ) = origin + (R sinθ, R(1 − cosθ), 0),
 * s = Rθ. The parallel-transport frame seeded with the plane normal stays on
 * the plane normal, so the frame is exact: x = +Z, z = tangent, y = z × x.
 */
export function quarterArcCurve(origin, R) {
  const length = (R * Math.PI) / 2;
  const theta = (s) => clamp(s, 0, length) / R;
  return {
    length,
    posAt: (s) => {
      const t = theta(s);
      return vadd(origin, [R * Math.sin(t), R * (1 - Math.cos(t)), 0]);
    },
    tangentAt: (s) => {
      const t = theta(s);
      return [Math.cos(t), Math.sin(t), 0];
    },
    frameAt: (s) => {
      const t = theta(s);
      const z = [Math.cos(t), Math.sin(t), 0];
      const x = [0, 0, 1];
      return { x, y: vcross(z, x), z };
    },
  };
}

/**
 * Helix of radius R and pitch P (rise per turn) about +Z:
 * p(t) = origin + (R cos t, R sin t, c t), c = P / 2π, s = t √(R² + c²).
 * Curvature κ = R / (R² + c²) and torsion τ = c / (R² + c²) are constant.
 * Frames are not given in closed form; `frenetAt` returns the Frenet frame,
 * against which a rotation-minimizing frame must rotate at the constant
 * rate τ.
 */
export function helixCurve(origin, R, pitch, turns) {
  const c = pitch / (2 * Math.PI);
  const k = Math.sqrt(R * R + c * c);
  const length = k * turns * 2 * Math.PI;
  const tAt = (s) => clamp(s, 0, length) / k;
  return {
    length,
    torsion: c / (R * R + c * c),
    posAt: (s) => {
      const t = tAt(s);
      return vadd(origin, [R * Math.cos(t), R * Math.sin(t), c * t]);
    },
    tangentAt: (s) => {
      const t = tAt(s);
      return vnorm([-R * Math.sin(t), R * Math.cos(t), c]);
    },
    frenetAt: (s) => {
      const t = tAt(s);
      const tangent = vnorm([-R * Math.sin(t), R * Math.cos(t), c]);
      const normal = [-Math.cos(t), -Math.sin(t), 0];
      return { tangent, normal, binormal: vcross(tangent, normal) };
    },
  };
}

/** Polyline of `n` points uniformly spaced in arc length. */
export function polylineFromCurve(curve, n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push(curve.posAt((i / (n - 1)) * curve.length));
  }
  return points;
}

/**
 * Exact orientations of `n` points in the column-major 4x4 layout
 * vtkImageCPRMapper reads (columns x, y, z of the frame).
 */
export function orientationsFromCurve(curve, n) {
  const orientations = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) {
    const { x, y, z } = curve.frameAt((i / (n - 1)) * curve.length);
    orientations.set([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1], i * 16);
  }
  return orientations;
}

/**
 * The forward CPR sampling map derived from the mapper shader:
 *   straightened: world(s, l) = P(s) + l · (frame(s) · samplingDir)
 *   uniform:      world(s, l) = P(s) + (l + u · (C − P(s))) · u
 * where u is the fixed sampling direction and C the mapper centre point.
 */
export function cprForwardOracle(opts, s, l) {
  const { curve, mode } = opts;
  const P = curve.posAt(s);
  if (mode === 'straightened') {
    const dir = frameApply(curve.frameAt(s), opts.samplingDir || [1, 0, 0]);
    return vadd(P, vscale(dir, l));
  }
  const u = vnorm(opts.uniformDir);
  const offset = opts.centerPoint ? vdot(u, vsub(opts.centerPoint, P)) : 0;
  return vadd(P, vscale(u, l + offset));
}

/** Trilinear interpolation of an x-fastest scalar array at a world point. */
export function trilinear(volume, world) {
  const { dimensions, spacing, origin, data } = volume;
  const [nx, ny, nz] = dimensions;
  const f = [0, 1, 2].map(
    (axis) => (world[axis] - origin[axis]) / spacing[axis]
  );
  if (
    f.some(
      (value, axis) =>
        !Number.isFinite(value) || value < 0 || value > dimensions[axis] - 1
    )
  ) {
    return NaN;
  }
  const i0 = f.map((value, axis) =>
    Math.min(Math.floor(value), dimensions[axis] - 2)
  );
  const d = f.map((value, axis) => value - i0[axis]);
  const at = (i, j, k) => data[(k * ny + j) * nx + i];
  let result = 0;
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const weight =
          (dx ? d[0] : 1 - d[0]) *
          (dy ? d[1] : 1 - d[1]) *
          (dz ? d[2] : 1 - d[2]);
        result += weight * at(i0[0] + dx, i0[1] + dy, i0[2] + dz);
      }
    }
  }
  return result;
}

/** Fills an x-fastest Float32 volume from a continuous field. */
export function fieldVolume(dimensions, spacing, origin, field) {
  const [nx, ny, nz] = dimensions;
  const data = new Float32Array(nx * ny * nz);
  let index = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        data[index++] = field(
          origin[0] + i * spacing[0],
          origin[1] + j * spacing[1],
          origin[2] + k * spacing[2]
        );
      }
    }
  }
  return { dimensions, spacing, origin, data };
}
