import type { Types } from '@cornerstonejs/core';
import { vec3 } from 'gl-matrix';
import resampleCenterline from './resampleCenterline';

function segmentLengths(points: Types.Point3[]): number[] {
  return points
    .slice(1)
    .map((point, index) => vec3.distance(point, points[index]));
}

describe('resampleCenterline', () => {
  it('samples a straight line at the requested spacing', () => {
    const points = resampleCenterline(
      [
        [0, 0, 0],
        [0, 0, 10],
      ],
      2
    );

    expect(points.length).toBe(6);
    expect(points[0]).toEqual([0, 0, 0]);
    expect(points[5]).toEqual([0, 0, 10]);
    segmentLengths(points).forEach((length) => {
      expect(length).toBeCloseTo(2, 6);
    });
  });

  it('passes through the control points of a curve', () => {
    const controlPoints: Types.Point3[] = [
      [0, 0, 0],
      [10, 5, 0],
      [20, 0, 5],
      [30, -5, 10],
    ];
    const points = resampleCenterline(controlPoints, 0.5);

    controlPoints.forEach((controlPoint) => {
      const nearest = Math.min(
        ...points.map((point) => vec3.distance(point, controlPoint))
      );
      expect(nearest).toBeLessThan(0.5);
    });
    segmentLengths(points).forEach((length) => {
      expect(length).toBeGreaterThan(0.25);
      expect(length).toBeLessThan(0.75);
    });
    expect(points[points.length - 1]).toEqual(controlPoints[3]);
  });

  it('ignores repeated control points', () => {
    const points = resampleCenterline(
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 4],
      ],
      1
    );

    expect(points.length).toBe(5);
    expect(points.every((point) => point.every(Number.isFinite))).toBe(true);
  });

  it('returns fewer than two points unchanged', () => {
    expect(resampleCenterline([[1, 2, 3]], 1)).toEqual([[1, 2, 3]]);
    expect(resampleCenterline([], 1)).toEqual([]);
  });
});
