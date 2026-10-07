import * as cornerstone3D from '../src/index';
import * as testUtils from '../../../utils/test/testUtils';
import {
  fieldVolume,
  orientationsFromCurve,
  polylineFromCurve,
  quarterArcCurve,
  trilinear,
  vadd,
  vscale,
} from '../../../utils/test/cprOracle';

const { Enums, volumeLoader, utilities } = cornerstone3D;
const { ViewportType, Events, BlendModes } = Enums;

const renderingEngineId = utilities.uuidv4();
const viewportId = 'CPR_VIEWPORT';
const CANVAS = 400;

// Error budgets. Gray: the texture filter, the transfer function lookup and
// the framebuffer each quantize to 8 bits, one gray level apiece. Pixel: a
// step edge rendered through trilinear filtering is a 1 mm ramp, 16 px here,
// so 8-bit quantization moves its midpoint by 0.05 px; half a pixel catches
// any pixel-centre convention mismatch.
const TAU_GRAY = 3;
const TAU_PIXEL = 0.5;

// Quarter arc of radius 16 mm in the z = 32 plane of a 64 mm cube, sampled
// 12 mm either side, which keeps every sample inside the volume for every
// rotation and mode under test.
const DIMENSIONS = [64, 64, 64];
const RADIUS = 16;
const WIDTH = 24;
const curve = quarterArcCurve([16, 16, 32], RADIUS);

const fields = {
  // linear everywhere: trilinear interpolation reproduces it exactly
  linear: (x, y, z) => x + y + 2 * z,
  gradientX: (x, y, z) => 4 * x,
  // edge midway between the voxel centres at x = 31 and x = 32
  step: (x) => (x < 31.5 ? 40 : 200),
};

function createPhantom(name) {
  const volume = fieldVolume(DIMENSIONS, [1, 1, 1], [0, 0, 0], fields[name]);
  // derived image ids keep the default VOI from fetching the images
  const volumeId = `derived:cprPhantom:${name}:${utilities.uuidv4()}`;
  volumeLoader.createLocalVolume(volumeId, {
    dimensions: DIMENSIONS,
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scalarData: Uint8Array.from(volume.data),
    metadata: {
      FrameOfReferenceUID: 'CPR_PHANTOM_FOR',
      PhotometricInterpretation: 'MONOCHROME2',
      BitsAllocated: 8,
      BitsStored: 8,
      HighBit: 7,
      PixelRepresentation: 0,
      Modality: 'CT',
    },
  });
  return { volumeId, volume };
}

function capture(vp, element, action) {
  return new Promise((resolve) => {
    const listener = () => {
      element.removeEventListener(Events.IMAGE_RENDERED, listener);
      const canvas = vp.getCanvas();
      resolve(
        canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      );
    };
    element.addEventListener(Events.IMAGE_RENDERED, listener);
    action?.();
    vp.render();
  });
}

const gray = (image, u, v) => image.data[(v * image.width + u) * 4];

function isBackground(image, u, v) {
  if (u < 0 || v < 0 || u >= image.width || v >= image.height) {
    return true;
  }
  const i = (v * image.width + u) * 4;
  return image.data[i] === 255 && image.data[i + 1] === 0;
}

function insideImage(image, u, v, margin = 4) {
  for (let dv = -margin; dv <= margin; dv++) {
    for (let du = -margin; du <= margin; du++) {
      if (isBackground(image, u + du, v + dv)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Compares every 20th pixel of the rendered image with the intensity the
 * oracle predicts at the world point the viewport says the pixel samples.
 */
function expectProvenance(vp, image, predict, label) {
  let tested = 0;
  let maxError = 0;
  for (let v = 10; v < image.height; v += 20) {
    for (let u = 10; u < image.width; u += 20) {
      if (!insideImage(image, u, v)) {
        continue;
      }
      const expected = predict(vp.canvasToWorld([u + 0.5, v + 0.5]));
      expect(Number.isFinite(expected))
        .withContext(`${label}: sample at (${u}, ${v}) left the volume`)
        .toBe(true);
      maxError = Math.max(maxError, Math.abs(gray(image, u, v) - expected));
      tested++;
    }
  }
  expect(tested).withContext(label).toBeGreaterThan(100);
  expect(maxError)
    .withContext(`${label}: max gray error over ${tested} pixels`)
    .toBeLessThanOrEqual(TAU_GRAY);
}

function imageDifference(a, b) {
  let total = 0;
  let count = 0;
  for (let v = 0; v < a.height; v += 4) {
    for (let u = 0; u < a.width; u += 4) {
      if (insideImage(a, u, v, 0) && insideImage(b, u, v, 0)) {
        total += Math.abs(gray(a, u, v) - gray(b, u, v));
        count++;
      }
    }
  }
  return count ? total / count : 0;
}

function imageBounds(image) {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let v = 0; v < image.height; v++) {
    for (let u = 0; u < image.width; u++) {
      if (!isBackground(image, u, v)) {
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  return { minU, maxU, minV, maxV };
}

/** Sub-pixel column where a row's gray values cross `level`, or undefined. */
function measureCrossing(image, v, level) {
  const crossings = [];
  for (let u = 0; u < image.width - 1; u++) {
    if (!insideImage(image, u, v, 0) || !insideImage(image, u + 1, v, 0)) {
      continue;
    }
    const a = gray(image, u, v) - level;
    const b = gray(image, u + 1, v) - level;
    if (a !== b && a * b <= 0 && !(a === 0 && crossings.length)) {
      crossings.push(u + 0.5 + a / (a - b));
    }
  }
  return crossings.length === 1 ? crossings[0] : undefined;
}

/** Canvas x where the viewport's own mapping reaches world x = `planeX`. */
function predictCrossing(vp, image, v, planeX) {
  let low = 0;
  let high = image.width;
  while (isBackground(image, Math.floor(low), v) && low < high) {
    low++;
  }
  while (isBackground(image, Math.ceil(high) - 1, v) && high > low) {
    high--;
  }
  if (high - low < 20) {
    return undefined;
  }
  const at = (x) => vp.canvasToWorld([x, v + 0.5])[0] - planeX;
  let a = at(low);
  let b = at(high);
  if (a * b > 0) {
    return undefined;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const m = at(mid);
    if (a * m <= 0) {
      high = mid;
      b = m;
    } else {
      low = mid;
      a = m;
    }
  }
  return (low + high) / 2;
}

describe('CPRViewport GPU --', () => {
  let renderingEngine;

  beforeEach(function () {
    const testEnv = testUtils.setupTestEnvironment({
      renderingEngineId,
      toolGroupIds: ['default'],
    });
    renderingEngine = testEnv.renderingEngine;
  });

  afterEach(function () {
    testUtils.cleanupTestEnvironment({
      renderingEngineId,
      toolGroupIds: ['default'],
    });
  });

  async function setup(phantom) {
    const element = testUtils.createViewports(renderingEngine, {
      viewportId,
      viewportType: ViewportType.CPR,
      width: CANVAS,
      height: CANVAS,
    });
    const vp = renderingEngine.getViewport(viewportId);
    const { volumeId, volume } = createPhantom(phantom);
    await vp.setVolumes([{ volumeId }]);
    vp.setCPRWidth(WIDTH);
    vp.setCenterline({
      points: polylineFromCurve(curve, 101),
      orientations: orientationsFromCurve(curve, 101),
    });
    vp.setProperties({ voiRange: { lower: 0, upper: 255 } });
    vp.resetCamera();
    const sample = (world) => trilinear(volume, world);
    return { vp, element, volume, sample };
  }

  it('reports the arc length of the centerline', async () => {
    const { vp } = await setup('linear');
    expect(vp.getCenterlineLength()).toBeCloseTo(curve.length, 2);
  });

  it('fits the reformatted image to the canvas on resetCamera', async () => {
    const { vp, element } = await setup('linear');
    const image = await capture(vp, element);
    const { minU, maxU, minV, maxV } = imageBounds(image);
    // the image is 24 mm wide and 25.1 mm tall: height fills the canvas
    expect(maxV - minV + 1).toBeGreaterThanOrEqual(CANVAS - 2);
    const expectedWidth = (WIDTH / curve.length) * CANVAS;
    expect(Math.abs(maxU - minU + 1 - expectedWidth)).toBeLessThan(3);
    expect(Math.abs(minU - (CANVAS - 1 - maxU))).toBeLessThan(3);
  });

  it('renders each pixel from the world point canvasToWorld reports', async () => {
    const { vp, element, sample } = await setup('linear');
    const image = await capture(vp, element);
    expectProvenance(vp, image, sample, 'straightened, rotation 0');
  });

  it('applies the rotation to the sampling direction', async () => {
    const { vp, element, sample } = await setup('linear');
    const before = await capture(vp, element);
    const image = await capture(vp, element, () => vp.setCPRRotation(90));
    expect(vp.getCPRRotation()).toBe(90);
    expect(imageDifference(before, image)).toBeGreaterThan(1);
    expectProvenance(vp, image, sample, 'straightened, rotation 90');
  });

  it('renders stretched mode from its own mapping', async () => {
    const { vp, element, sample } = await setup('linear');
    const before = await capture(vp, element, () => vp.setCPRRotation(90));
    const image = await capture(vp, element, () => vp.setCPRMode('stretched'));
    expect(vp.getCPRMode()).toBe('stretched');
    expect(imageDifference(before, image)).toBeGreaterThan(1);
    expectProvenance(vp, image, sample, 'stretched, rotation 90');
  });

  it('keeps the mapping and the image together after pan and zoom', async () => {
    const { vp, element, sample } = await setup('linear');
    const image = await capture(vp, element, () => {
      vp.setZoom(2);
      vp.setPan([30, -15]);
    });
    expect(vp.getZoom()).toBeCloseTo(2, 6);
    expect(vp.getPan()[0]).toBeCloseTo(30, 3);
    expect(vp.getPan()[1]).toBeCloseTo(-15, 3);
    expectProvenance(vp, image, sample, 'zoom 2, pan [30, -15]');
  });

  it('places a step edge where canvasToWorld predicts, to half a pixel', async () => {
    const { vp, element } = await setup('step');
    const image = await capture(vp, element, () => vp.setCPRRotation(90));
    const rows = [];
    let maxError = 0;
    for (let v = 10; v < image.height - 10; v += 10) {
      const predicted = predictCrossing(vp, image, v, 31.5);
      const measured =
        predicted === undefined ? undefined : measureCrossing(image, v, 120);
      if (measured === undefined) {
        continue;
      }
      maxError = Math.max(maxError, Math.abs(measured - predicted));
      rows.push([v, measured, predicted, measured - predicted]);
    }
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(maxError)
      .withContext(
        `max edge error over ${rows.length} rows; [row, measured, predicted, difference] = ${JSON.stringify(
          rows.map((row) => row.map((value) => Number(value.toFixed(2))))
        )}`
      )
      .toBeLessThan(TAU_PIXEL);
  });

  it('projects the slab along the surface normal with each blend mode', async () => {
    const { vp, element } = await setup('gradientX');
    // the surface normal at rotation 0 is the in-plane binormal, along
    // which V = 4x changes at 4·sinθ per mm with sinθ = (x - 16) / 16
    const normalSlope = (world) => (4 * (world[0] - RADIUS)) / RADIUS;
    const halfSlab = 4;
    const cases = [
      [BlendModes.MAXIMUM_INTENSITY_BLEND, 1],
      [BlendModes.MINIMUM_INTENSITY_BLEND, -1],
      [BlendModes.AVERAGE_INTENSITY_BLEND, 0],
    ];
    for (const [blendMode, sign] of cases) {
      const image = await capture(vp, element, () => {
        vp.setBlendMode(blendMode);
        vp.setSlabThickness(2 * halfSlab);
      });
      expect(vp.getSlabThickness()).toBe(2 * halfSlab);
      expectProvenance(
        vp,
        image,
        (world) => 4 * world[0] + sign * halfSlab * normalSlope(world),
        `blend mode ${blendMode}`
      );
    }
    const image = await capture(vp, element, () => vp.resetSlabThickness());
    expectProvenance(vp, image, (world) => 4 * world[0], 'slab reset');
  });

  it('inverts canvasToWorld on the surface and rejects points off it', async () => {
    const { vp, element } = await setup('linear');
    const image = await capture(vp, element);
    let tested = 0;
    for (let v = 10; v < image.height; v += 40) {
      for (let u = 10; u < image.width; u += 40) {
        if (!insideImage(image, u, v)) {
          continue;
        }
        const canvas = [u + 0.5, v + 0.5];
        const world = vp.canvasToWorld(canvas);
        const back = vp.worldToCanvas(world);
        expect(Math.abs(back[0] - canvas[0])).toBeLessThan(0.01);
        expect(Math.abs(back[1] - canvas[1])).toBeLessThan(0.01);
        // 3 mm along the in-plane normal is beyond the 1 mm surface tolerance
        const theta = Math.asin(
          Math.min(1, Math.max(-1, (world[0] - RADIUS) / RADIUS))
        );
        const normal = [Math.sin(theta), -Math.cos(theta), 0];
        const off = vp.worldToCanvas(vadd(world, vscale(normal, 3)));
        expect(off[0]).toBeLessThan(-1000);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(20);
  });
});
