import vtkImageCPRMapper from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper';
import {
  computeCenterlineOrientations,
  createCenterlinePolyData,
  cprToWorld,
  worldToCPR,
} from '../src/RenderingEngine/helpers/cprCenterline';
import {
  polylineFromCurve,
  quarterArcCurve,
  vadd,
  vdist,
  vscale,
  vsub,
} from '../../../utils/test/cprOracle';

// Invariants that need no oracle: the mapping must transform the way the
// geometry transforms. Each test moves the whole input and checks the
// output moves identically.

const WIDTH = 40;
// Exact invariants hold up to Float32 storage of the polyline and frames:
// one ulp at 100 mm is 7.6e-6, so 1e-4 leaves a tenfold margin.
const EXACT_MM = 1e-4;

function createMapper(points, initialNormal, width = WIDTH) {
  const mapper = vtkImageCPRMapper.newInstance();
  mapper.setWidth(width);
  mapper.setInputData(
    createCenterlinePolyData(
      points,
      computeCenterlineOrientations(points, initialNormal)
    ),
    1
  );
  mapper.useStraightenedMode();
  return mapper;
}

function samples(height, steps = 9) {
  const result = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      result.push([
        ((i + 0.5) / steps) * height,
        ((j + 0.5) / steps) * WIDTH - WIDTH / 2,
      ]);
    }
  }
  return result;
}

const rotateZ90 = (p) => [-p[1], p[0], p[2]];

describe('CPR mapping metamorphic invariants', () => {
  const curve = quarterArcCurve([10, 10, 30], 60);
  const points = polylineFromCurve(curve, 101);
  const normal = [0, 0, 1];

  it('translating the centerline translates every mapped point exactly', () => {
    const delta = [12.5, -7.25, 3];
    const moved = createMapper(
      points.map((p) => vadd(p, delta)),
      normal
    );
    const mapper = createMapper(points, normal);
    for (const [s, l] of samples(curve.length)) {
      const expected = vadd(cprToWorld(mapper, s, l), delta);
      expect(vdist(cprToWorld(moved, s, l), expected)).toBeLessThan(EXACT_MM);
      const coordinate = worldToCPR(moved, expected);
      expect(Math.abs(coordinate.distance - s)).toBeLessThan(1e-3);
      expect(Math.abs(coordinate.lateral - l)).toBeLessThan(1e-3);
    }
  });

  it('rotating the centerline by 90 degrees rotates every mapped point', () => {
    const rotated = createMapper(points.map(rotateZ90), rotateZ90(normal));
    const mapper = createMapper(points, normal);
    for (const [s, l] of samples(curve.length)) {
      const expected = rotateZ90(cprToWorld(mapper, s, l));
      expect(vdist(cprToWorld(rotated, s, l), expected)).toBeLessThan(EXACT_MM);
    }
  });

  it('doubling the width doubles each lateral offset and leaves the axis', () => {
    const mapper = createMapper(points, normal);
    const wide = createMapper(points, normal, 2 * WIDTH);
    for (const [s, l] of samples(curve.length)) {
      const axis = cprToWorld(mapper, s, 0);
      expect(vdist(cprToWorld(wide, s, 0), axis)).toBeLessThan(EXACT_MM);
      const offset = vsub(cprToWorld(mapper, s, l), axis);
      const wideOffset = vsub(cprToWorld(wide, s, 2 * l), axis);
      expect(vdist(wideOffset, vscale(offset, 2))).toBeLessThan(EXACT_MM);
    }
  });

  it('converges as the polyline densifies', () => {
    const coarse = createMapper(polylineFromCurve(curve, 101), normal);
    const fine = createMapper(polylineFromCurve(curve, 401), normal);
    const finer = createMapper(polylineFromCurve(curve, 801), normal);
    let coarseToFine = 0;
    let fineToFiner = 0;
    for (const [s, l] of samples(curve.length)) {
      coarseToFine = Math.max(
        coarseToFine,
        vdist(cprToWorld(coarse, s, l), cprToWorld(fine, s, l))
      );
      fineToFiner = Math.max(
        fineToFiner,
        vdist(cprToWorld(fine, s, l), cprToWorld(finer, s, l))
      );
    }
    expect(coarseToFine).toBeLessThan(0.05);
    expect(fineToFiner).toBeLessThan(coarseToFine / 4);
  });

  it('reversing the centerline mirrors the distance coordinate', () => {
    const mapper = createMapper(points, normal);
    const reversed = createMapper([...points].reverse(), normal);
    const height = mapper.getHeight();
    expect(reversed.getHeight()).toBeCloseTo(height, 6);
    for (const [s, l] of samples(curve.length)) {
      const world = cprToWorld(mapper, s, l);
      const coordinate = worldToCPR(reversed, world);
      expect(Math.abs(coordinate.distance - (height - s))).toBeLessThan(1e-2);
      expect(Math.abs(Math.abs(coordinate.lateral) - Math.abs(l))).toBeLessThan(
        1e-2
      );
    }
  });

  it('scaling the world by two scales every mapped point by two', () => {
    const mapper = createMapper(points, normal);
    const scaled = createMapper(
      points.map((p) => vscale(p, 2)),
      normal,
      2 * WIDTH
    );
    for (const [s, l] of samples(curve.length)) {
      const expected = vscale(cprToWorld(mapper, s, l), 2);
      expect(vdist(cprToWorld(scaled, 2 * s, 2 * l), expected)).toBeLessThan(
        EXACT_MM
      );
    }
  });
});
