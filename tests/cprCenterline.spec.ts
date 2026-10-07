import { test } from 'playwright-test-coverage';
import type { Page } from '@playwright/test';
import {
  visitExample,
  checkForCanvasSnapshot,
  screenShotPaths,
  simulateClicksOnElement,
  simulateDrawPath,
  expectAnnotationText,
} from './utils/index';

// The viewport renders once more 2 s after the volume has finished
// streaming, so a capture only counts once it has stayed unchanged longer.
// The edge of the reformatted quad rasterizes a pixel differently from
// run to run, so a thin line of pixels is allowed to differ.
const snapshotOptions = {
  stableMs: 3000,
  timeoutMs: 60000,
  maxDiffPixelRatio: 0.005,
};

// Clicks closer than the 400 ms double-click window would be merged, so
// the control points are placed with a pause between them.
async function drawCenterline(page: Page) {
  const axial = page.locator('.cornerstone-canvas').nth(0);
  await simulateClicksOnElement({
    locator: axial,
    points: [
      { x: 150, y: 180 },
      { x: 225, y: 150 },
      { x: 300, y: 200 },
    ],
    delayBetweenClicks: 500,
  });
  await simulateClicksOnElement({
    locator: axial,
    points: [{ x: 340, y: 290 }],
    doubleClick: true,
  });
  await page.waitForTimeout(1000);
}

test.beforeEach(async ({ page }) => {
  await visitExample(page, 'cprCenterline', 2000);
  // the reformation is only final once every slice has streamed in
  await page.waitForLoadState('networkidle', { timeout: 110000 });
});

test.describe('CPR Centerline', () => {
  test('should reformat along a centerline drawn on the axial viewport', async ({
    page,
  }) => {
    await drawCenterline(page);
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprCenterline.centerline,
      [0, 3],
      snapshotOptions
    );
  });

  test('should measure a length on the reformatted image', async ({ page }) => {
    await drawCenterline(page);
    await page.getByRole('combobox').first().selectOption('Length');
    const cpr = page.locator('.cornerstone-canvas').nth(3);
    // the draw helper dispatches raw mouse events, which only reach an
    // element inside the browser window; the line stays close to the
    // centerline, where the reformation is one-to-one
    await cpr.scrollIntoViewIfNeeded();
    await simulateDrawPath(
      page,
      cpr,
      [
        [205, 215],
        [245, 235],
      ],
      { steps: 10 }
    );
    await expectAnnotationText(page, 3, /\d+(\.\d+)? mm/);
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprCenterline.length,
      [3],
      { ...snapshotOptions, hideAnnotationText: true }
    );
  });
});
