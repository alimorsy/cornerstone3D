import type { Types } from '@cornerstonejs/core';
import { vec3 } from 'gl-matrix';
import vtkSpline3D from '@kitware/vtk.js/Common/DataModel/Spline3D';

/**
 * Interpolates a smooth curve through the control points and samples it at a
 * uniform spacing, giving the dense polyline a CPR viewport reformats along.
 *
 * @param controlPoints - Control points in world space
 * @param spacing - Distance between samples in world units
 * @returns The sampled polyline, from the first to the last control point
 */
export default function resampleCenterline(
  controlPoints: Types.Point3[],
  spacing: number
): Types.Point3[] {
  const points = controlPoints.filter(
    (point, index) =>
      index === 0 || vec3.distance(point, controlPoints[index - 1]) > 0
  );

  if (points.length < 2) {
    return points.map((point) => [...point] as Types.Point3);
  }

  // Evaluate the spline densely, then walk it at the requested spacing. The
  // spline needs three control points; two are joined by a straight line.
  const dense: Types.Point3[] = [];

  if (points.length === 2) {
    dense.push([...points[0]] as Types.Point3);
  } else {
    const spline = vtkSpline3D.newInstance({ close: false });
    spline.computeCoefficients(points as unknown as number[]);

    for (let interval = 0; interval < points.length - 1; interval++) {
      const steps = Math.max(
        Math.ceil(
          vec3.distance(points[interval], points[interval + 1]) / spacing
        ) * 4,
        4
      );
      for (let step = 0; step < steps; step++) {
        dense.push(spline.getPoint(interval, step / steps) as Types.Point3);
      }
    }
  }
  dense.push([...points[points.length - 1]] as Types.Point3);

  const resampled: Types.Point3[] = [dense[0]];
  let remaining = spacing;

  for (let index = 1; index < dense.length; index++) {
    let start = dense[index - 1];
    const end = dense[index];
    let length = vec3.distance(start, end);

    while (length >= remaining) {
      const point = vec3.lerp(
        vec3.create(),
        start,
        end,
        remaining / length
      ) as Types.Point3;
      resampled.push(point);
      start = point;
      length -= remaining;
      remaining = spacing;
    }
    remaining -= length;
  }

  const last = dense[dense.length - 1];
  if (vec3.distance(resampled[resampled.length - 1], last) > spacing / 2) {
    resampled.push(last);
  } else {
    resampled[resampled.length - 1] = last;
  }

  return resampled;
}
