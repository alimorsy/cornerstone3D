/**
 * Unit tests for the palette color lookup table normalization of the image
 * pixel typed provider.
 */

import { describe, it, expect } from '@jest/globals';
import { pixelDataUpdate } from '../src/utilities/metadataProvider/pixelDataUpdate';

function paletteModule(entries, data) {
  const descriptor = [entries, 0, 8];
  return {
    redPaletteColorLookupTableDescriptor: descriptor,
    greenPaletteColorLookupTableDescriptor: descriptor,
    bluePaletteColorLookupTableDescriptor: descriptor,
    redPaletteColorLookupTableData: data(),
    greenPaletteColorLookupTableData: data(),
    bluePaletteColorLookupTableData: data(),
  };
}

function bytes(length, entries) {
  const array = new Uint8Array(length);
  for (let i = 0; i < entries; i++) {
    array[i] = i % 256;
  }
  return array.buffer;
}

describe('pixelDataUpdate palette color lookup tables', () => {
  it('accepts an odd number of 8-bit entries padded to an even length', () => {
    const entries = 4053;
    const result = pixelDataUpdate(
      () => paletteModule(entries, () => bytes(entries + 1, entries)),
      'imageId',
      {},
      {}
    );

    for (const color of ['red', 'green', 'blue']) {
      const table = result[`${color}PaletteColorLookupTableData`];
      expect(table).toBeInstanceOf(Uint8Array);
      expect(table.length).toBe(entries);
      expect(table[entries - 1]).toBe((entries - 1) % 256);
    }
  });

  it('reads more than 256 8-bit entries byte by byte', () => {
    const entries = 300;
    const result = pixelDataUpdate(
      () => paletteModule(entries, () => bytes(entries, entries)),
      'imageId',
      {},
      {}
    );
    const table = result.redPaletteColorLookupTableData;

    expect(table.length).toBe(entries);
    expect(Array.from(table.slice(254, 258))).toEqual([254, 255, 0, 1]);
  });

  it('rejects a table whose length matches neither 8 nor 16 bits', () => {
    expect(() =>
      pixelDataUpdate(
        () => paletteModule(256, () => bytes(300, 256)),
        'imageId',
        {},
        {}
      )
    ).toThrow(/length mismatch/);
  });
});
