import { cache, imageLoader, utilities } from '../src/index';

const { VoxelManager } = utilities;

// two 2 x 2 images cached before the volume, in the narrowest type each fits
function cacheImages() {
  const imageIds = ['localImage:narrow', 'localImage:wide'];
  const common = {
    dimensions: [2, 2],
    spacing: [1, 1],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
  imageLoader.createAndCacheLocalImage(imageIds[0], {
    ...common,
    scalarData: Uint8Array.from([10, 10, 10, 10]),
  });
  imageLoader.createAndCacheLocalImage(imageIds[1], {
    ...common,
    scalarData: Int16Array.from([-50, 300, 300, -50]),
  });
  return imageIds;
}

describe('image volume voxel manager', () => {
  afterEach(() => {
    cache.purgeCache();
  });

  it('builds the complete scalar array in the volume data type', () => {
    const imageIds = cacheImages();
    const voxelManager = VoxelManager.createImageVolumeVoxelManager({
      dimensions: [2, 2, 2],
      imageIds,
      numberOfComponents: 1,
      dataType: 'Int16Array',
    });
    const scalars = voxelManager.getCompleteScalarDataArray();

    expect(scalars).toBeInstanceOf(Int16Array);
    expect(Array.from(scalars)).toEqual([10, 10, 10, 10, -50, 300, 300, -50]);
    expect(voxelManager.getAtIJK(1, 0, 1)).toBe(300);
  });

  it('falls back to the first image type without a volume data type', () => {
    const imageIds = cacheImages();
    const voxelManager = VoxelManager.createImageVolumeVoxelManager({
      dimensions: [2, 2, 2],
      imageIds,
      numberOfComponents: 1,
    });

    expect(voxelManager.getCompleteScalarDataArray()).toBeInstanceOf(
      Uint8Array
    );
  });
});
