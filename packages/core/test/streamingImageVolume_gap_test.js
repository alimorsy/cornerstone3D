import * as cornerstone3D from '../src/index';
import * as testUtils from '../../../utils/test/testUtils';

const { cache, volumeLoader, utilities } = cornerstone3D;

const renderingEngineId = utilities.uuidv4();

// 16 x 16 images at z = 0, 1, 2 and 4 mm: slice 3 has no image of its own
function gapImageIds() {
  return [0, 1, 2, 4].map((sliceIndex) =>
    testUtils.encodeImageIdInfo({
      loader: 'fakeImageLoader',
      name: 'gapSeries',
      rows: 16,
      columns: 16,
      barStart: 0,
      barWidth: 4,
      xSpacing: 1,
      ySpacing: 1,
      sliceIndex,
    })
  );
}

describe('StreamingImageVolume with a gap --', () => {
  beforeEach(function () {
    testUtils.setupTestEnvironment({ renderingEngineId });
  });

  afterEach(function () {
    testUtils.cleanupTestEnvironment({ renderingEngineId });
  });

  it('places the images on a regular grid and completes every slice', async () => {
    const imageIds = gapImageIds();
    const volumeId = 'cornerstoneStreamingImageVolume:gap';
    const volume = await volumeLoader.createAndCacheVolume(volumeId, {
      imageIds,
    });

    expect(volume.dimensions[2]).toBe(5);
    expect(volume.spacing[2]).toBeCloseTo(1, 6);
    // the slice at 3 mm shows the image at 2 mm, the nearer of its neighbours
    expect(volume.imageIds).toEqual([
      imageIds[0],
      imageIds[1],
      imageIds[2],
      imageIds[2],
      imageIds[3],
    ]);
    expect(volume.getImageIdIndex(imageIds[2])).toBe(2);
    expect(volume.getImageIdIndices(imageIds[2])).toEqual([2, 3]);

    const status = await new Promise((resolve) => {
      volume.load((result) => {
        if (result.framesProcessed === result.totalNumFrames) {
          resolve(result);
        }
      });
    });

    expect(status.totalNumFrames).toBe(5);
    expect(volume.loadStatus.loaded).toBe(true);
    expect(cache.getVolume(volumeId)).toBe(volume);
  });
});
