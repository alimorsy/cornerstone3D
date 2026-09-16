import type Point3 from './Point3';

/**
 * How a CPR viewport unrolls the centerline.
 *
 * - `straightened`: the centerline becomes a straight vertical axis and every
 *   row is sampled perpendicular to the local tangent, so lengths along the
 *   vessel are preserved.
 * - `stretched`: every row is sampled along one fixed direction, so the
 *   vessel keeps its shape as seen from the viewing direction.
 */
type CPRMode = 'straightened' | 'stretched';

/**
 * A centerline for a CPR viewport.
 */
interface CPRCenterline {
  /** World space points of the centerline polyline, at least two */
  points: Point3[];
  /**
   * Optional orientation of each point as a column-major 4x4 matrix
   * (16 numbers per point) whose columns are the lateral sampling axis, the
   * viewing axis and the tangent. Computed as rotation-minimizing frames
   * when omitted.
   */
  orientations?: Float32Array;
}

export type { CPRCenterline, CPRMode };
