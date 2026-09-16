import { quat, vec3 } from 'gl-matrix';
import vtkImageCPRMapper from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper';
import {
  computeCenterlineOrientations,
  createCenterlinePolyData,
  cprToWorld,
  worldToCPR,
} from '../src/RenderingEngine/helpers/cprCenterline';

function straightLine(length, step = 1) {
  const points = [];
  for (let z = 0; z <= length; z += step) {
    points.push([10, 20, z]);
  }
  return points;
}

function quarterCircle(radius, count) {
  const points = [];
  for (let index = 0; index <= count; index++) {
    const angle = (index / count) * (Math.PI / 2);
    points.push([radius * Math.cos(angle), radius * Math.sin(angle), 5]);
  }
  return points;
}

function createMapper(points, orientations) {
  const mapper = vtkImageCPRMapper.newInstance();
  mapper.setWidth(100);
  mapper.setInputData(
    createCenterlinePolyData(
      points,
      orientations || computeCenterlineOrientations(points)
    ),
    1
  );
  return mapper;
}

function frameAt(orientations, index) {
  const offset = index * 16;
  return {
    x: orientations.slice(offset, offset + 3),
    y: orientations.slice(offset + 4, offset + 7),
    z: orientations.slice(offset + 8, offset + 11),
  };
}

describe('cprCenterline', () => {
  describe('computeCenterlineOrientations', () => {
    it('builds right-handed orthonormal frames whose z axis is the tangent', () => {
      const points = quarterCircle(50, 20);
      const orientations = computeCenterlineOrientations(points);

      expect(orientations.length).toBe(points.length * 16);

      points.forEach((point, index) => {
        const { x, y, z } = frameAt(orientations, index);
        const previous = points[Math.max(index - 1, 0)];
        const next = points[Math.min(index + 1, points.length - 1)];
        const tangent = vec3.normalize(
          vec3.create(),
          vec3.subtract(vec3.create(), next, previous)
        );

        expect(vec3.dot(z, tangent)).toBeCloseTo(1, 6);
        expect(vec3.dot(x, y)).toBeCloseTo(0, 6);
        expect(vec3.dot(x, z)).toBeCloseTo(0, 6);
        expect(vec3.length(x)).toBeCloseTo(1, 6);
        expect(vec3.dot(vec3.cross(vec3.create(), x, y), z)).toBeCloseTo(1, 6);
      });
    });

    it('transports the frame without twisting along the curve', () => {
      const orientations = computeCenterlineOrientations(quarterCircle(50, 40));

      for (let index = 1; index < 41; index++) {
        const { x } = frameAt(orientations, index);
        const { x: previous } = frameAt(orientations, index - 1);
        expect(vec3.dot(x, previous)).toBeGreaterThan(0.99);
      }
    });

    it('starts from the requested lateral axis', () => {
      const orientations = computeCenterlineOrientations(
        straightLine(10),
        [0, 1, 0]
      );
      const { x } = frameAt(orientations, 0);

      expect(x[0]).toBeCloseTo(0, 6);
      expect(x[1]).toBeCloseTo(1, 6);
      expect(x[2]).toBeCloseTo(0, 6);
    });

    it('handles repeated points', () => {
      const points = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 10],
      ];
      const orientations = computeCenterlineOrientations(points);

      expect(Array.from(orientations).every(Number.isFinite)).toBe(true);
      expect(Array.from(frameAt(orientations, 0).z)).toEqual([0, 0, 1]);
    });
  });

  describe('coordinate mapping', () => {
    it('maps image coordinates to world and back on a straight line', () => {
      const mapper = createMapper(straightLine(60), null);

      const world = cprToWorld(mapper, 25, 7);
      const coordinate = worldToCPR(mapper, world);

      expect(world[2]).toBeCloseTo(25, 6);
      expect(coordinate.distance).toBeCloseTo(25, 6);
      expect(coordinate.lateral).toBeCloseTo(7, 6);
      expect(coordinate.depth).toBeCloseTo(0, 6);
    });

    it('reports how far a point is from the sampled surface', () => {
      const points = straightLine(60);
      const orientations = computeCenterlineOrientations(points, [1, 0, 0]);
      const mapper = createMapper(points, orientations);

      // sampling runs along x, so an offset along y is off the surface
      const coordinate = worldToCPR(mapper, [10 + 3, 20 + 4, 30]);

      expect(coordinate.distance).toBeCloseTo(30, 6);
      expect(coordinate.lateral).toBeCloseTo(3, 6);
      expect(coordinate.depth).toBeCloseTo(4, 6);
    });

    it('round trips on a curved centerline in straightened mode', () => {
      const mapper = createMapper(quarterCircle(50, 80), null);
      mapper.useStraightenedMode();
      const height = mapper.getHeight();

      expect(height).toBeCloseTo((Math.PI / 2) * 50, 0);

      for (const distance of [0, 12.3, height / 2, height - 0.5]) {
        for (const lateral of [-20, -1, 0, 8]) {
          const world = cprToWorld(mapper, distance, lateral);
          const coordinate = worldToCPR(mapper, world);

          expect(coordinate.distance).toBeCloseTo(distance, 3);
          expect(coordinate.lateral).toBeCloseTo(lateral, 3);
          expect(coordinate.depth).toBeLessThan(0.01);
        }
      }
    });

    it('round trips on a curved centerline in stretched mode', () => {
      const points = quarterCircle(50, 80);
      const orientations = computeCenterlineOrientations(points);
      const mapper = createMapper(points, orientations);
      const reference = quat.fromMat3(
        quat.create(),
        Array.from(orientations.subarray(40 * 16, 40 * 16 + 16)).filter(
          (_, index) => index % 4 !== 3 && index < 12
        )
      );

      mapper.useStretchedMode();
      mapper.setUniformOrientation(quat.normalize(reference, reference));
      const height = mapper.getHeight();

      expect(mapper.getUseUniformOrientation()).toBe(true);
      expect(height).toBeLessThan((Math.PI / 2) * 50);

      for (const distance of [1, height / 3, height / 2, height - 1]) {
        for (const lateral of [-15, 0, 5]) {
          const world = cprToWorld(mapper, distance, lateral);
          const coordinate = worldToCPR(mapper, world);

          expect(coordinate.distance).toBeCloseTo(distance, 3);
          expect(coordinate.lateral).toBeCloseTo(lateral, 3);
          expect(coordinate.depth).toBeLessThan(0.01);
        }
      }
    });

    it('continues past the ends of the centerline', () => {
      const mapper = createMapper(straightLine(60), null);

      const beyond = cprToWorld(mapper, 70, 0);
      const before = cprToWorld(mapper, -5, 0);

      expect(beyond[2]).toBeCloseTo(70, 6);
      expect(before[2]).toBeCloseTo(-5, 6);
    });

    it('returns nothing without a usable centerline', () => {
      const mapper = vtkImageCPRMapper.newInstance();
      mapper.setInputData(
        createCenterlinePolyData([[0, 0, 0]], new Float32Array(16)),
        1
      );

      expect(worldToCPR(mapper, [0, 0, 0])).toBeUndefined();
    });
  });
});
