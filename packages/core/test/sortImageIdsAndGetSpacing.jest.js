import * as metaData from '../src/metaData';
import sortImageIdsAndGetSpacing from '../src/utilities/sortImageIdsAndGetSpacing';

// one image per z position, in the order given, with an identity orientation
function registerSeries(scheme, positions) {
  const planes = {};
  const imageIds = positions.map((z, index) => {
    const imageId = `${scheme}:series/${index}`;
    planes[imageId] = {
      imagePositionPatient: [0, 0, z],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      rowPixelSpacing: 1,
      columnPixelSpacing: 1,
      pixelSpacing: [1, 1],
      sliceThickness: 2.5,
    };
    return imageId;
  });
  metaData.addProvider(
    (type, imageId) =>
      type === 'imagePlaneModule' ? planes[imageId] : undefined,
    10000
  );
  return imageIds;
}

const sliceIndices = (sortedImageIds) =>
  sortedImageIds.map((imageId) => Number(imageId.split('/')[1]));

describe('sortImageIdsAndGetSpacing', () => {
  afterEach(() => {
    metaData.removeAllProviders();
  });

  it('keeps regularly spaced images as they are', () => {
    const imageIds = registerSeries('wadors', [0, 2.5, 5, 7.5, 10]);
    const { sortedImageIds, zSpacing, origin } =
      sortImageIdsAndGetSpacing(imageIds);

    expect(sliceIndices(sortedImageIds)).toEqual([0, 1, 2, 3, 4]);
    expect(zSpacing).toBeCloseTo(2.5, 6);
    expect(origin).toEqual([0, 0, 0]);
  });

  it('fills a gap with the nearest images', () => {
    const imageIds = registerSeries('wadors', [0, 2.5, 5, 15, 17.5]);
    const { sortedImageIds, zSpacing } = sortImageIdsAndGetSpacing(imageIds);

    expect(zSpacing).toBeCloseTo(2.5, 6);
    // slices at 7.5 and 10 take the image at 5, at 12.5 the one at 15
    expect(sliceIndices(sortedImageIds)).toEqual([0, 1, 2, 2, 2, 3, 3, 4]);
  });

  it('keeps the first image of a repeated position', () => {
    const imageIds = registerSeries('wadors', [0, 0, 2.5, 2.5, 5, 5]);
    const { sortedImageIds, zSpacing } = sortImageIdsAndGetSpacing(imageIds);

    expect(zSpacing).toBeCloseTo(2.5, 6);
    expect(sliceIndices(sortedImageIds)).toEqual([0, 2, 4]);
  });

  it('sorts wadouri images by position when all their metadata is cached', () => {
    const imageIds = registerSeries('wadouri', [5, 0, 10, 2.5, 7.5]);
    const { sortedImageIds, zSpacing } = sortImageIdsAndGetSpacing(imageIds);

    expect(sliceIndices(sortedImageIds)).toEqual([1, 3, 0, 4, 2]);
    expect(zSpacing).toBeCloseTo(2.5, 6);
  });
});
