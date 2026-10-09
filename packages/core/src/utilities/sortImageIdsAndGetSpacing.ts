import { vec3 } from 'gl-matrix';
import * as metaData from '../metaData';
import { MetadataModules } from '../enums';
import calculateSpacingBetweenImageIds from './calculateSpacingBetweenImageIds';
import type { Point3 } from '../types';
import { coreLog } from './logger';

const log = coreLog.getLogger('utilities', 'sortImageIdsAndGetSpacing');

/**
 * Deviation of a slice position from the regular grid that is tolerated
 * before the images are placed on one, as a fraction of the spacing
 */
const REGULAR_TOLERANCE = 0.01;

interface SortedImageIdsItem {
  zSpacing: number;
  origin: Point3;
  sortedImageIds: string[];
}

interface DistanceImagePair {
  distance: number;
  imageId: string;
}

/**
 * Places images whose positions are not on a regular grid, because of gaps or
 * repeated positions, on the grid of their median spacing. Each slice takes
 * the image nearest to it, so a gap repeats its neighbours and a repeated
 * position keeps its first image.
 *
 * @param pairs - images with their distance along the scan axis, sorted
 * @returns the slice image ids and spacing, or undefined when the positions
 *   are regular or cannot be placed
 */
function placeOnRegularGrid(
  pairs: DistanceImagePair[]
): { sortedImageIds: string[]; zSpacing: number } | undefined {
  const count = pairs.length;
  const first = pairs[0].distance;
  const extent = first - pairs[count - 1].distance;
  const meanSpacing = extent / (count - 1);
  const tolerance = Math.max(REGULAR_TOLERANCE * meanSpacing, 0.01);
  const regular = pairs.every(
    (pair, index) =>
      Math.abs(first - pair.distance - index * meanSpacing) <= tolerance
  );

  if (regular) {
    return;
  }

  // the first image of each position
  const distinct = pairs.filter(
    (pair, index) =>
      index === 0 || pairs[index - 1].distance - pair.distance > tolerance
  );

  if (distinct.length < 2) {
    return;
  }

  const steps = distinct
    .slice(1)
    .map((pair, index) => distinct[index].distance - pair.distance)
    .sort((a, b) => a - b);
  const zSpacing = steps[Math.floor(steps.length / 2)];
  const sliceCount = Math.round(extent / zSpacing) + 1;

  if (sliceCount > 10 * count) {
    log.warn(
      `Slice positions span ${sliceCount} slices of ${zSpacing} mm for ${count} images, keeping their order with a mean spacing`
    );
    return;
  }

  const sortedImageIds = [];
  let nearest = 0;

  for (let slice = 0; slice < sliceCount; slice++) {
    const target = first - slice * zSpacing;

    while (
      nearest + 1 < distinct.length &&
      Math.abs(distinct[nearest + 1].distance - target) <
        Math.abs(distinct[nearest].distance - target)
    ) {
      nearest++;
    }
    sortedImageIds.push(distinct[nearest].imageId);
  }

  log.warn(
    `Slice positions are not on a regular grid: ${count} images placed on ${sliceCount} slices ${zSpacing} mm apart by nearest position`
  );

  return { sortedImageIds, zSpacing };
}
/**
 * Given an array of imageIds, sort them based on their imagePositionPatient, and
 * also returns the spacing between images and the origin of the reference image
 *
 * @param imageIds - array of imageIds
 * @param scanAxisNormal - [x, y, z] array or gl-matrix vec3
 *
 * @returns The sortedImageIds, spacing, and origin of the first image in the series.
 */
export default function sortImageIdsAndGetSpacing(
  imageIds: string[],
  scanAxisNormal?: vec3
): SortedImageIdsItem {
  const {
    imagePositionPatient: referenceImagePositionPatient,
    imageOrientationPatient,
  } = metaData.get(MetadataModules.IMAGE_PLANE, imageIds[0]);

  if (!scanAxisNormal) {
    const rowCosineVec = vec3.fromValues(
      imageOrientationPatient[0],
      imageOrientationPatient[1],
      imageOrientationPatient[2]
    );
    const colCosineVec = vec3.fromValues(
      imageOrientationPatient[3],
      imageOrientationPatient[4],
      imageOrientationPatient[5]
    );

    scanAxisNormal = vec3.create();
    vec3.cross(scanAxisNormal, rowCosineVec, colCosineVec);
  }

  // Check if we are using wadouri scheme
  const usingWadoUri = imageIds[0].split(':')[0] === 'wadouri';

  let zSpacing = calculateSpacingBetweenImageIds(imageIds);

  let sortedImageIds: string[];

  function getDistance(imageId: string) {
    const { imagePositionPatient } = metaData.get(
      MetadataModules.IMAGE_PLANE,
      imageId
    );

    const positionVector = vec3.create();

    vec3.sub(
      positionVector,
      referenceImagePositionPatient,
      imagePositionPatient
    );

    return vec3.dot(positionVector, scanAxisNormal);
  }

  /**
   * If we are using wadors, or wadouri with the metadata of every image
   * already cached, then sort by image position in 3D space, calculate
   * average slice spacing from the entire volume and place the images on a
   * regular grid when their positions are not. If not, then use the sampled
   * images (1st and middle) to calculate slice spacing, and use the provided
   * imageId order. Correct sorting must be done ahead of time.
   */
  const hasAllMetadata =
    !usingWadoUri ||
    imageIds.every((imageId) =>
      metaData.get(MetadataModules.IMAGE_PLANE, imageId)
    );

  if (hasAllMetadata) {
    const distanceImagePairs: DistanceImagePair[] = imageIds.map((imageId) => {
      const distance = getDistance(imageId);

      return {
        distance,
        imageId,
      };
    });

    distanceImagePairs.sort((a, b) => b.distance - a.distance);
    sortedImageIds = distanceImagePairs.map((a) => a.imageId);

    const placed =
      imageIds.length > 1 ? placeOnRegularGrid(distanceImagePairs) : undefined;

    if (placed) {
      sortedImageIds = placed.sortedImageIds;
      zSpacing = placed.zSpacing;
    }
  } else {
    // Using wadouri, so we have only prefetched the first, middle, and last
    // images for metadata. Assume initial imageId array order is pre-sorted,
    // but check orientation.
    const prefetchedImageIds = [
      imageIds[0],
      imageIds[Math.floor(imageIds.length / 2)],
    ];
    sortedImageIds = imageIds;
    const firstImageDistance = getDistance(prefetchedImageIds[0]);
    const middleImageDistance = getDistance(prefetchedImageIds[1]);
    if (firstImageDistance - middleImageDistance < 0) {
      sortedImageIds.reverse();
    }
  }

  const { imagePositionPatient: origin } = metaData.get(
    MetadataModules.IMAGE_PLANE,
    sortedImageIds[0]
  );

  const result: SortedImageIdsItem = {
    zSpacing,
    origin,
    sortedImageIds,
  };

  return result;
}
