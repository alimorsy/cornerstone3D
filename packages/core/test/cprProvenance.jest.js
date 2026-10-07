import { quat, vec3 } from 'gl-matrix';
import vtkImageCPRMapper from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper';
import {
  computeCenterlineOrientations,
  createCenterlinePolyData,
  cprToWorld,
  worldToCPR,
} from '../src/RenderingEngine/helpers/cprCenterline';
import {
  cprForwardOracle,
  frameApply,
  helixCurve,
  orientationsFromCurve,
  polylineFromCurve,
  quarterArcCurve,
  straightCurve,
  vdist,
  vdot,
  vscale,
  vadd,
} from '../../../utils/test/cprOracle';

// Error budget: the mapper interpolates positions linearly between polyline
// vertices, so the forward map differs from the exact curve by at most the
// chord sagitta R(1 - cos(dθ/2)): 1.9e-3 mm at 101 vertices on the R = 60
// arc. The inverse refines to 1e-4 mm. 0.02 mm covers both tenfold and is
// fifty times smaller than a one-voxel error.
const TAU_MM = 0.02;
const WIDTH = 40;

function createMapper(
  curve,
  n,
  orientations = orientationsFromCurve(curve, n)
) {
  const mapper = vtkImageCPRMapper.newInstance();
  mapper.setWidth(WIDTH);
  mapper.setInputData(
    createCenterlinePolyData(polylineFromCurve(curve, n), orientations),
    1
  );
  mapper.useStraightenedMode();
  return mapper;
}

function grid(height, steps = 21) {
  const samples = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      samples.push([
        ((i + 0.5) / steps) * height,
        ((j + 0.5) / steps) * WIDTH - WIDTH / 2,
      ]);
    }
  }
  return samples;
}

function expectGridProvenance(mapper, oracle, height) {
  let max = 0;
  for (const [s, l] of grid(height)) {
    const error = vdist(
      cprToWorld(mapper, s, l),
      cprForwardOracle(oracle, s, l)
    );
    max = Math.max(max, error);
  }
  expect(max).toBeLessThan(TAU_MM);
  return max;
}

function expectGridInvertibility(mapper, oracle, height) {
  for (const [s, l] of grid(height)) {
    const coordinate = worldToCPR(mapper, cprForwardOracle(oracle, s, l));
    expect(Math.abs(coordinate.distance - s)).toBeLessThan(TAU_MM);
    expect(Math.abs(coordinate.lateral - l)).toBeLessThan(TAU_MM);
    expect(coordinate.depth).toBeLessThan(TAU_MM);
  }
}

describe('CPR mapping provenance against the analytic oracle', () => {
  describe('straight centerline', () => {
    const curve = straightCurve([64, 64, 20], [0, 0, 1], 88, [1, 0, 0]);
    const mapper = createMapper(curve, 45);
    const oracle = { curve, mode: 'straightened', samplingDir: [1, 0, 0] };

    it('maps the image centre to the centerline midpoint', () => {
      const world = cprToWorld(mapper, curve.length / 2, 0);
      expect(vdist(world, [64, 64, 64])).toBeLessThan(TAU_MM);
    });

    it('maps a lateral offset along the sampling axis', () => {
      const world = cprToWorld(mapper, 10, 7.5);
      expect(vdist(world, [71.5, 64, 30])).toBeLessThan(TAU_MM);
    });

    it('agrees with the oracle on a 21x21 grid, forward and inverse', () => {
      expectGridProvenance(mapper, oracle, curve.length);
      expectGridInvertibility(mapper, oracle, curve.length);
    });
  });

  describe('quarter arc (R = 60), straightened', () => {
    const curve = quarterArcCurve([10, 10, 30], 60);
    const mapper = createMapper(curve, 101);
    const oracle = { curve, mode: 'straightened', samplingDir: [1, 0, 0] };

    it('reports the arc length as the image height', () => {
      expect(mapper.getHeight()).toBeCloseTo(curve.length, 2);
    });

    it('agrees with the oracle on a 21x21 grid', () => {
      const max = expectGridProvenance(mapper, oracle, curve.length);
      // the residual is the chord approximation, not a systematic offset
      expect(max).toBeLessThan(0.005);
    });

    it('inverts oracle world points to their image coordinates', () => {
      expectGridInvertibility(mapper, oracle, curve.length);
    });

    it('reports the distance of a point from the sampled surface', () => {
      const s = curve.length / 3;
      const off = frameApply(curve.frameAt(s), [0, 1, 0]);
      const world = vadd(cprForwardOracle(oracle, s, 5), vscale(off, 4));
      const coordinate = worldToCPR(mapper, world);
      expect(coordinate.distance).toBeCloseTo(s, 1);
      expect(coordinate.lateral).toBeCloseTo(5, 1);
      expect(coordinate.depth).toBeCloseTo(4, 1);
    });
  });

  describe('rotation of the sampling frame', () => {
    const curve = quarterArcCurve([10, 10, 30], 60);

    for (const degrees of [30, 90, 180, 270]) {
      it(`rotated by ${degrees} degrees matches the rotated oracle`, () => {
        const mapper = createMapper(curve, 101);
        const angle = (degrees * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        mapper.setDirectionMatrix([cos, sin, 0, -sin, cos, 0, 0, 0, 1]);
        const oracle = {
          curve,
          mode: 'straightened',
          samplingDir: [cos, sin, 0],
        };
        expectGridProvenance(mapper, oracle, curve.length);
        expectGridInvertibility(mapper, oracle, curve.length);
      });
    }

    it('rotation moves off-axis samples (the rotation is live)', () => {
      const mapper = createMapper(curve, 101);
      const before = cprToWorld(mapper, 20, 10);
      mapper.setDirectionMatrix([0, 1, 0, -1, 0, 0, 0, 0, 1]);
      const after = cprToWorld(mapper, 20, 10);
      expect(vdist(before, after)).toBeGreaterThan(5);
      expect(vdist(cprToWorld(mapper, 20, 0), before)).toBeCloseTo(10, 1);
    });
  });

  describe('stretched (uniform direction) mode', () => {
    it('samples along one fixed direction with the centre point offset', () => {
      const curve = quarterArcCurve([10, 10, 30], 60);
      const mapper = createMapper(curve, 101);
      // sample perpendicular to the arc plane: projected distances equal
      // arc lengths, so the oracle is exact
      const frame = curve.frameAt(0);
      const reference = quat.fromMat3(quat.create(), [
        ...frame.x,
        ...frame.y,
        ...frame.z,
      ]);
      mapper.useStretchedMode();
      mapper.setUniformOrientation(quat.normalize(reference, reference));
      expect(mapper.getUseUniformOrientation()).toBe(true);
      expect(mapper.getHeight()).toBeCloseTo(curve.length, 2);

      const oracle = {
        curve,
        mode: 'uniform',
        uniformDir: [0, 0, 1],
        centerPoint: curve.posAt(0),
      };
      expectGridProvenance(mapper, oracle, curve.length);
      expectGridInvertibility(mapper, oracle, curve.length);
    });

    it('differs from straightened mode on an in-plane sampling direction', () => {
      const curve = quarterArcCurve([10, 10, 30], 60);
      const mapper = createMapper(curve, 101);
      mapper.setDirectionMatrix([0, 1, 0, -1, 0, 0, 0, 0, 1]);
      const straightened = cprToWorld(mapper, curve.length / 2, 10);
      mapper.useStretchedMode();
      const frame = curve.frameAt(0);
      mapper.setUniformOrientation(
        quat.fromMat3(quat.create(), [...frame.x, ...frame.y, ...frame.z])
      );
      const stretched = cprToWorld(mapper, mapper.getHeight() / 2, 10);
      expect(vdist(straightened, stretched)).toBeGreaterThan(1);
    });
  });

  describe('frames from computeCenterlineOrientations', () => {
    it('match the exact frames of a planar arc', () => {
      const curve = quarterArcCurve([10, 10, 30], 60);
      const n = 101;
      const points = polylineFromCurve(curve, n);
      const ours = computeCenterlineOrientations(points, [0, 0, 1]);
      const exact = orientationsFromCurve(curve, n);
      const errorAt = (i) => {
        let max = 0;
        for (const column of [0, 4, 8]) {
          for (let axis = 0; axis < 3; axis++) {
            max = Math.max(
              max,
              Math.abs(
                ours[i * 16 + column + axis] - exact[i * 16 + column + axis]
              )
            );
          }
        }
        return max;
      };
      // On a circle the central-difference chord is parallel to the exact
      // tangent, so interior frames are exact up to Float32 storage. The end
      // vertices only have a one-sided chord, which leans by dθ/2.
      const halfStep = curve.length / (n - 1) / 60 / 2;
      for (let i = 1; i < n - 1; i++) {
        expect(errorAt(i)).toBeLessThan(1e-5);
      }
      expect(errorAt(0)).toBeLessThan(halfStep + 1e-5);
      expect(errorAt(n - 1)).toBeLessThan(halfStep + 1e-5);
    });

    it('rotate against the Frenet frame of a helix at the torsion rate', () => {
      const curve = helixCurve([0, 0, 0], 15, 30, 1.5);
      const n = 301;
      const step = curve.length / (n - 1);
      const points = polylineFromCurve(curve, n);
      const orientations = computeCenterlineOrientations(points);
      // Interior tangents are central differences, accurate to O(step²);
      // the end vertices only have a one-sided chord and are skipped.
      const angles = [];
      for (let i = 1; i < n - 1; i++) {
        const { normal, binormal, tangent } = curve.frenetAt(i * step);
        const x = Array.from(orientations.subarray(i * 16, i * 16 + 3));
        const z = Array.from(orientations.subarray(i * 16 + 8, i * 16 + 11));
        expect(Math.abs(vdot(x, tangent))).toBeLessThan(1e-3);
        expect(vdot(z, tangent)).toBeGreaterThan(0.9999);
        angles.push(Math.atan2(vdot(x, binormal), vdot(x, normal)));
      }
      // A rotation-minimizing frame turns relative to the Frenet frame at
      // exactly -τ, constant on a helix. Budget: the chord tangents are off
      // by about 5e-5 rad, 0.5% of the 9.5e-3 rad turned per step, so each
      // step is held to 2% and the accumulated rotation to 1%.
      let total = 0;
      for (let i = 1; i < angles.length; i++) {
        let delta = angles[i] - angles[i - 1];
        delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
        expect(Math.abs(Math.abs(delta) / step - curve.torsion)).toBeLessThan(
          0.02 * curve.torsion
        );
        total += delta;
      }
      const expected = curve.torsion * step * (angles.length - 1);
      expect(Math.abs(Math.abs(total) - expected)).toBeLessThan(
        0.01 * expected
      );
    });

    it('stay orthonormal and right handed with unit determinant', () => {
      const curve = helixCurve([0, 0, 0], 15, 30, 2);
      const orientations = computeCenterlineOrientations(
        polylineFromCurve(curve, 401)
      );
      for (let i = 0; i < 401; i++) {
        const o = orientations.subarray(i * 16, i * 16 + 16);
        const x = [o[0], o[1], o[2]];
        const y = [o[4], o[5], o[6]];
        const z = [o[8], o[9], o[10]];
        const determinant = vdot(x, [
          y[1] * z[2] - y[2] * z[1],
          y[2] * z[0] - y[0] * z[2],
          y[0] * z[1] - y[1] * z[0],
        ]);
        expect(Math.abs(vdot(x, y))).toBeLessThan(1e-4);
        expect(Math.abs(vdot(y, z))).toBeLessThan(1e-4);
        expect(Math.abs(vdot(x, x) - 1)).toBeLessThan(1e-4);
        expect(determinant).toBeGreaterThan(0.999);
        expect(determinant).toBeLessThan(1.001);
      }
    });
  });

  describe('degenerate inputs', () => {
    const curve = quarterArcCurve([10, 10, 30], 60);

    it('tolerates a repeated interior vertex', () => {
      const points = polylineFromCurve(curve, 51);
      points.splice(25, 0, [...points[25]]);
      const mapper = vtkImageCPRMapper.newInstance();
      mapper.setWidth(WIDTH);
      mapper.setInputData(
        createCenterlinePolyData(
          points,
          computeCenterlineOrientations(points, [0, 0, 1])
        ),
        1
      );
      const oracle = { curve, mode: 'straightened', samplingDir: [1, 0, 0] };
      const world = cprForwardOracle(oracle, curve.length / 2, 3);
      const coordinate = worldToCPR(mapper, world);
      expect(Number.isFinite(coordinate.distance)).toBe(true);
      expect(coordinate.lateral).toBeCloseTo(3, 1);
    });

    it('rejects non-finite world points instead of poisoning the result', () => {
      const mapper = createMapper(curve, 51);
      expect(worldToCPR(mapper, [NaN, 10, 30])).toBeUndefined();
      expect(worldToCPR(mapper, [10, Infinity, 30])).toBeUndefined();
    });

    it('rejects non-finite image coordinates', () => {
      const mapper = createMapper(curve, 51);
      expect(cprToWorld(mapper, NaN, 0)).toBeUndefined();
      expect(cprToWorld(mapper, 10, Infinity)).toBeUndefined();
    });

    it('is deterministic on a hairpin where two arms are equidistant', () => {
      const points = [];
      for (let i = 0; i <= 40; i++) {
        points.push([i, 0, 0]);
      }
      for (let i = 1; i <= 40; i++) {
        points.push([40 - i, 4, 0]);
      }
      const mapper = vtkImageCPRMapper.newInstance();
      mapper.setWidth(WIDTH);
      mapper.setInputData(
        createCenterlinePolyData(points, computeCenterlineOrientations(points)),
        1
      );
      const first = worldToCPR(mapper, [20, 2, 0]);
      const second = worldToCPR(mapper, [20, 2, 0]);
      expect(first).toEqual(second);
      expect(Number.isFinite(first.distance)).toBe(true);
      expect(Math.abs(first.depth)).toBeLessThan(2 + TAU_MM);
    });
  });
});

describe('vec3 helpers used by the oracle agree with gl-matrix', () => {
  it('frameApply equals a quaternion rotation of the same frame', () => {
    const curve = quarterArcCurve([0, 0, 0], 10);
    const frame = curve.frameAt(7);
    const q = quat.fromMat3(quat.create(), [
      ...frame.x,
      ...frame.y,
      ...frame.z,
    ]);
    const v = [0.3, -0.5, 0.8];
    const expected = vec3.transformQuat(vec3.create(), v, q);
    // gl-matrix quaternions and vectors are Float32
    expect(vdist(frameApply(frame, v), Array.from(expected))).toBeLessThan(
      1e-6
    );
  });
});
