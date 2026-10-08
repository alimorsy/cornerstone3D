import type { Types } from '@cornerstonejs/core';
import { volumeLoader } from '@cornerstonejs/core';

/**
 * A synthetic CT angiography volume with a known vessel, built in memory so
 * that examples run without any network access and can be checked against
 * the truth they were built from.
 */
export interface VesselPhantom {
  volumeId: string;
  volume: Types.IImageVolume;
  /** Points along the lumen axis, one per millimetre of arc length */
  centerline: Types.Point3[];
  /** Arc length of the centerline in mm */
  length: number;
  /** Lumen diameter away from the stenosis in mm */
  diameter: number;
  stenosis: {
    /** Distance along the centerline in mm */
    distance: number;
    position: Types.Point3;
    /** Minimal lumen diameter in mm */
    diameter: number;
  };
  /** Window that shows tissue, lumen, wall and bone */
  voiRange: { lower: number; upper: number };
}

const DIMENSIONS: Types.Point3 = [128, 128, 128];
const SPACING: Types.Point3 = [1, 1, 1];
const TISSUE = 40;
const LUMEN = 350;
const WALL = 90;
const CALCIUM = 900;
const BONE = 600;
const NOISE = 8;
const RADIUS = 4;
const STENOSIS_SEVERITY = 0.5;
const STENOSIS_SIGMA = 8;
const BONE_CENTER = [112, 64];
const BONE_RADIUS = 7;

/** A tortuous, non-planar course that climbs along z, about 120 mm long */
function curve(t: number): Types.Point3 {
  const phase = 2 * Math.PI * 0.8 * t;

  return [
    64 + 30 * Math.sin(phase),
    64 + 18 * Math.sin(phase + 1),
    16 + 96 * t,
  ];
}

function lumenRadius(distance: number, stenosisDistance: number): number {
  const offset = (distance - stenosisDistance) / STENOSIS_SIGMA;

  return RADIUS * (1 - STENOSIS_SEVERITY * Math.exp(-offset * offset));
}

/** Deterministic noise so that screenshots are reproducible */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the phantom volume, caches it under `volumeId` and returns it with
 * its ground truth.
 */
export default function createVesselPhantomVolume(
  volumeId: string
): VesselPhantom {
  const [columns, rows, slices] = DIMENSIONS;
  const scalarData = new Int16Array(columns * rows * slices).fill(TISSUE);
  const index = (x: number, y: number, z: number) =>
    (z * rows + y) * columns + x;

  // Sample the curve densely and measure its arc length
  const samples = 4000;
  const dense: { point: Types.Point3; distance: number }[] = [];
  let length = 0;

  for (let i = 0; i <= samples; i++) {
    const point = curve(i / samples);

    if (i > 0) {
      const previous = dense[i - 1].point;
      length += Math.hypot(
        point[0] - previous[0],
        point[1] - previous[1],
        point[2] - previous[2]
      );
    }

    dense.push({ point, distance: length });
  }

  const pointAt = (distance: number): Types.Point3 => {
    let i = 1;

    while (i < dense.length - 1 && dense[i].distance < distance) {
      i++;
    }

    const { point: a, distance: da } = dense[i - 1];
    const { point: b, distance: db } = dense[i];
    const t = db > da ? (distance - da) / (db - da) : 0;

    return [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
      a[2] + t * (b[2] - a[2]),
    ];
  };

  const stenosisDistance = length / 2;

  // Paint the lumen and wall by splatting spheres along the curve
  const paintSphere = (
    center: Types.Point3,
    radius: number,
    value: number,
    onlyBelow?: number
  ) => {
    const [cx, cy, cz] = center;

    for (let z = Math.ceil(cz - radius); z <= Math.floor(cz + radius); z++) {
      for (let y = Math.ceil(cy - radius); y <= Math.floor(cy + radius); y++) {
        for (
          let x = Math.ceil(cx - radius);
          x <= Math.floor(cx + radius);
          x++
        ) {
          if (
            x < 0 ||
            y < 0 ||
            z < 0 ||
            x >= columns ||
            y >= rows ||
            z >= slices
          ) {
            continue;
          }

          const i = index(x, y, z);

          if (
            Math.hypot(x - cx, y - cy, z - cz) <= radius &&
            (onlyBelow === undefined || scalarData[i] < onlyBelow)
          ) {
            scalarData[i] = value;
          }
        }
      }
    }
  };

  for (let distance = 0; distance <= length; distance += 0.5) {
    const radius = lumenRadius(distance, stenosisDistance);

    paintSphere(pointAt(distance), radius + 1, WALL, WALL);
  }

  for (let distance = 0; distance <= length; distance += 0.5) {
    paintSphere(
      pointAt(distance),
      lumenRadius(distance, stenosisDistance),
      LUMEN
    );
  }

  // An eccentric calcified plaque in the wall just past the stenosis
  const plaqueDistance = stenosisDistance + 5;
  const plaqueCenter = pointAt(plaqueDistance);
  const ahead = pointAt(plaqueDistance + 1);
  const tangent = [
    ahead[0] - plaqueCenter[0],
    ahead[1] - plaqueCenter[1],
    ahead[2] - plaqueCenter[2],
  ];
  const tangentLength = Math.hypot(...tangent);
  const side = [1 - (tangent[0] * tangent[0]) / tangentLength ** 2, 0, 0];
  side[1] = -(tangent[0] * tangent[1]) / tangentLength ** 2;
  side[2] = -(tangent[0] * tangent[2]) / tangentLength ** 2;
  const sideLength = Math.hypot(...side);
  const plaqueOffset = lumenRadius(plaqueDistance, stenosisDistance) + 0.5;

  paintSphere(
    [
      plaqueCenter[0] + (plaqueOffset * side[0]) / sideLength,
      plaqueCenter[1] + (plaqueOffset * side[1]) / sideLength,
      plaqueCenter[2] + (plaqueOffset * side[2]) / sideLength,
    ],
    2.5,
    CALCIUM
  );

  // A bony column beside the vessel, picked up by thick slabs
  for (let z = 0; z < slices; z++) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        if (Math.hypot(x - BONE_CENTER[0], y - BONE_CENTER[1]) <= BONE_RADIUS) {
          scalarData[index(x, y, z)] = BONE;
        }
      }
    }
  }

  const random = createRandom(1);

  for (let i = 0; i < scalarData.length; i++) {
    scalarData[i] += Math.round((random() - 0.5) * 2 * NOISE);
  }

  const volume = volumeLoader.createLocalVolume(volumeId, {
    dimensions: DIMENSIONS,
    spacing: SPACING,
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scalarData,
    metadata: {
      FrameOfReferenceUID: 'CPR_VESSEL_PHANTOM_FOR',
      Modality: 'CT',
      PhotometricInterpretation: 'MONOCHROME2',
      BitsAllocated: 16,
      BitsStored: 16,
      HighBit: 15,
      PixelRepresentation: 1,
    },
  });

  // Flag every frame for upload to the GPU, as a loader would while
  // streaming the images in
  volume.invalidate();

  const centerline: Types.Point3[] = [];

  for (let distance = 0; distance < length; distance += 1) {
    centerline.push(pointAt(distance));
  }
  centerline.push(pointAt(length));

  return {
    volumeId,
    volume,
    centerline,
    length,
    diameter: 2 * RADIUS,
    stenosis: {
      distance: stenosisDistance,
      position: pointAt(stenosisDistance),
      diameter: 2 * RADIUS * (1 - STENOSIS_SEVERITY),
    },
    voiRange: { lower: -150, upper: 550 },
  };
}
