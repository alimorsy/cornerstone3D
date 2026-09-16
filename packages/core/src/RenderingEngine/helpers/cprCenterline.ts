import { quat, vec3 } from 'gl-matrix';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import type { vtkImageCPRMapper } from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper';
import type { Point3 } from '../../types';

/**
 * Position of a world point relative to the surface sampled by a CPR mapper.
 */
export interface CPRCoordinate {
  /** Distance along the centerline, in world units */
  distance: number;
  /** Signed offset along the sampling direction, in world units */
  lateral: number;
  /** Distance between the point and the sampled surface, in world units */
  depth: number;
}

const EPSILON = 1e-6;

function perpendicularTo(direction: vec3): vec3 {
  const axis = vec3.create();
  const absolute = [
    Math.abs(direction[0]),
    Math.abs(direction[1]),
    Math.abs(direction[2]),
  ];
  axis[absolute.indexOf(Math.min(...absolute))] = 1;
  const perpendicular = vec3.cross(vec3.create(), direction, axis);
  return vec3.normalize(perpendicular, perpendicular);
}

/**
 * Computes rotation-minimizing frames along a polyline by parallel transport
 * of an initial normal, which avoids the twisting and flipping of
 * Frenet-Serret frames at straight sections and inflection points.
 *
 * Returns one column-major 4x4 matrix per point (16 numbers) whose columns
 * are the lateral (sampling) axis, the viewing axis and the tangent, which is
 * the orientation layout vtkImageCPRMapper reads from the centerline.
 *
 * @param points - The centerline polyline in world space
 * @param initialNormal - Preferred lateral axis at the first point
 */
export function computeCenterlineOrientations(
  points: Point3[],
  initialNormal?: Point3
): Float32Array {
  const orientations = new Float32Array(points.length * 16);

  if (points.length < 2) {
    return orientations;
  }

  const tangents = points.map((_, index) => {
    const previous = points[Math.max(index - 1, 0)];
    const next = points[Math.min(index + 1, points.length - 1)];
    const tangent = vec3.subtract(vec3.create(), next, previous);

    return vec3.length(tangent) < EPSILON
      ? tangent
      : vec3.normalize(tangent, tangent);
  });

  // Repeated points reuse the tangent of a neighbour
  tangents.forEach((tangent, index) => {
    if (vec3.length(tangent) < EPSILON) {
      const fallback =
        tangents.slice(index + 1).find((other) => vec3.length(other)) ||
        tangents[index - 1] ||
        vec3.fromValues(0, 0, 1);
      vec3.copy(tangent, fallback);
    }
  });

  const normal = initialNormal
    ? vec3.clone(initialNormal)
    : perpendicularTo(tangents[0]);
  vec3.scaleAndAdd(normal, normal, tangents[0], -vec3.dot(normal, tangents[0]));
  if (vec3.length(normal) < EPSILON) {
    vec3.copy(normal, perpendicularTo(tangents[0]));
  }
  vec3.normalize(normal, normal);

  const rotation = quat.create();
  const binormal = vec3.create();

  tangents.forEach((tangent, index) => {
    if (index > 0) {
      quat.rotationTo(rotation, tangents[index - 1], tangent);
      vec3.transformQuat(normal, normal, rotation);
    }
    // Re-orthogonalize the frame to keep it numerically stable
    vec3.normalize(binormal, vec3.cross(binormal, tangent, normal));
    vec3.normalize(normal, vec3.cross(normal, binormal, tangent));

    orientations.set(
      [...normal, 0, ...binormal, 0, ...tangent, 0, 0, 0, 0, 1],
      index * 16
    );
  });

  return orientations;
}

/**
 * Builds the centerline polydata consumed by vtkImageCPRMapper: a single
 * polyline through the points, with the orientation of each point stored as
 * its tensor data.
 */
export function createCenterlinePolyData(
  points: Point3[],
  orientations: Float32Array
): vtkPolyData {
  const polyData = vtkPolyData.newInstance();
  const lines = new Uint32Array(points.length + 1);

  lines[0] = points.length;
  points.forEach((_, index) => {
    lines[index + 1] = index;
  });

  polyData.getPoints().setData(Float32Array.from(points.flat()), 3);
  polyData.getLines().setData(lines);
  polyData.getPointData().setTensors(
    vtkDataArray.newInstance({
      name: 'Orientation',
      numberOfComponents: 16,
      values: orientations,
    })
  );

  return polyData;
}

/**
 * Direction along which the mapper samples the volume at a point of the
 * centerline: the fixed direction in stretched mode, the rotated local frame
 * axis in straightened mode.
 */
function getSamplingDirection(
  mapper: vtkImageCPRMapper,
  orientation: quat | undefined
): vec3 {
  if (mapper.getUseUniformOrientation() || !orientation) {
    return vec3.normalize(vec3.create(), mapper.getUniformDirection());
  }

  return vec3.transformQuat(
    vec3.create(),
    mapper.getTangentDirection(),
    orientation
  );
}

/**
 * Maps a point of the CPR image to the world position it shows.
 *
 * Points beyond the ends of the centerline continue along the end tangent,
 * so the mapping stays continuous outside the image.
 *
 * @param mapper - The CPR mapper with its centerline set
 * @param distance - Distance along the centerline, in world units
 * @param lateral - Signed offset along the sampling direction, in world units
 */
export function cprToWorld(
  mapper: vtkImageCPRMapper,
  distance: number,
  lateral: number
): Point3 | undefined {
  const height = mapper.getHeight();
  const clamped = Math.min(Math.max(distance, 0), height);
  const { position, orientation } =
    mapper.getCenterlinePositionAndOrientation(clamped);

  if (!position) {
    return;
  }

  const samplingDirection = getSamplingDirection(mapper, orientation);
  const centerPoint = mapper.getCenterPoint();
  let offset = lateral;

  if (centerPoint) {
    offset += vec3.dot(
      samplingDirection,
      vec3.subtract(vec3.create(), centerPoint, position)
    );
  }

  const world = vec3.scaleAndAdd(
    vec3.create(),
    position,
    samplingDirection,
    offset
  );

  if (clamped !== distance) {
    const points = mapper.getOrientedCenterline().getPoints();
    const last = points.getNumberOfPoints() - 1;
    const tangent = vec3.subtract(
      vec3.create(),
      points.getPoint(clamped === 0 ? 1 : last) as vec3,
      points.getPoint(clamped === 0 ? 0 : last - 1) as vec3
    );
    vec3.normalize(tangent, tangent);
    vec3.scaleAndAdd(world, world, tangent, distance - clamped);
  }

  return [world[0], world[1], world[2]];
}

/**
 * Finds where a world point falls on the CPR image, and how far it is from
 * the surface the image samples.
 *
 * The nearest centerline point is found on the polyline with the metric the
 * mapper uses for the mode: full distance in straightened mode, distance
 * perpendicular to the fixed sampling direction in stretched mode.
 *
 * @param mapper - The CPR mapper with its centerline set
 * @param worldPos - The world point to locate
 */
export function worldToCPR(
  mapper: vtkImageCPRMapper,
  worldPos: Point3
): CPRCoordinate | undefined {
  const centerline = mapper.getOrientedCenterline();
  const points = centerline.getPoints();
  const numberOfPoints = points.getNumberOfPoints();

  if (numberOfPoints < 2) {
    return;
  }

  const distances = centerline.getDistancesToFirstPoint();
  const uniformDirection = mapper.getUseUniformOrientation()
    ? vec3.normalize(vec3.create(), mapper.getUniformDirection())
    : undefined;
  const removeUniform = (vector: vec3) =>
    uniformDirection
      ? vec3.scaleAndAdd(
          vector,
          vector,
          uniformDirection,
          -vec3.dot(vector, uniformDirection)
        )
      : vector;

  const start = vec3.create();
  const end = vec3.create();
  const segment = vec3.create();
  const toPoint = vec3.create();
  const residual = vec3.create();
  let best = { index: 0, t: 0, residualSquared: Infinity };

  for (let index = 0; index < numberOfPoints - 1; index++) {
    points.getPoint(index, start);
    points.getPoint(index + 1, end);
    removeUniform(vec3.subtract(segment, end, start));
    removeUniform(vec3.subtract(toPoint, worldPos, start));

    const segmentLengthSquared = vec3.squaredLength(segment);
    const t =
      segmentLengthSquared < EPSILON
        ? 0
        : Math.min(
            Math.max(vec3.dot(toPoint, segment) / segmentLengthSquared, 0),
            1
          );
    const residualSquared = vec3.squaredLength(
      vec3.scaleAndAdd(residual, toPoint, segment, -t)
    );

    if (residualSquared < best.residualSquared) {
      best = { index, t, residualSquared };
    }
  }

  let distance =
    distances[best.index] +
    best.t * (distances[best.index + 1] - distances[best.index]);
  let sample = sampleCenterline(mapper, worldPos, distance);

  if (!sample) {
    return;
  }

  let tangent: vec3;

  if (uniformDirection) {
    points.getPoint(best.index, start);
    points.getPoint(best.index + 1, end);
    tangent = vec3.normalize(
      segment,
      removeUniform(vec3.subtract(segment, end, start))
    );
  } else {
    // The sampling direction is interpolated between the frames at the ends
    // of each segment, so the sampled surface bends between the vertices:
    // refine the distance around the nearest segment by minimising the
    // distance to the surface (golden-section search)
    const segmentLength = distances[best.index + 1] - distances[best.index];
    const cost = (candidate: number) => {
      const candidateSample = sampleCenterline(mapper, worldPos, candidate);
      return candidateSample
        ? vec3.squaredLength(candidateSample.residual)
        : Infinity;
    };
    const ratio = (Math.sqrt(5) - 1) / 2;
    let low = Math.max(distance - segmentLength, 0);
    let high = Math.min(
      distance + segmentLength,
      distances[numberOfPoints - 1]
    );
    let lower = high - ratio * (high - low);
    let upper = low + ratio * (high - low);
    let lowerCost = cost(lower);
    let upperCost = cost(upper);

    for (let iteration = 0; iteration < 30 && high - low > 1e-4; iteration++) {
      if (lowerCost < upperCost) {
        high = upper;
        upper = lower;
        upperCost = lowerCost;
        lower = high - ratio * (high - low);
        lowerCost = cost(lower);
      } else {
        low = lower;
        lower = upper;
        lowerCost = upperCost;
        upper = low + ratio * (high - low);
        upperCost = cost(upper);
      }
    }

    distance = (low + high) / 2;
    sample = sampleCenterline(mapper, worldPos, distance) || sample;
    tangent = vec3.transformQuat(
      vec3.create(),
      mapper.getNormalDirection(),
      sample.orientation
    );
  }

  const { position, samplingDirection, lateralOffset } = sample;
  const centerPoint = mapper.getCenterPoint();
  let lateral = lateralOffset;

  if (centerPoint) {
    lateral -= vec3.dot(
      samplingDirection,
      vec3.subtract(vec3.create(), centerPoint, position)
    );
  }

  const depth = vec3.length(
    vec3.scaleAndAdd(
      residual,
      sample.residual,
      tangent,
      -vec3.dot(sample.residual, tangent)
    )
  );

  return { distance, lateral, depth };
}

function sampleCenterline(
  mapper: vtkImageCPRMapper,
  worldPos: Point3,
  distance: number
) {
  const { position, orientation } =
    mapper.getCenterlinePositionAndOrientation(distance);

  if (!position) {
    return;
  }

  const samplingDirection = getSamplingDirection(mapper, orientation);
  const offset = vec3.subtract(vec3.create(), worldPos, position);
  const lateralOffset = vec3.dot(offset, samplingDirection);
  const residual = vec3.scaleAndAdd(
    vec3.create(),
    offset,
    samplingDirection,
    -lateralOffset
  );

  return { position, orientation, samplingDirection, lateralOffset, residual };
}
