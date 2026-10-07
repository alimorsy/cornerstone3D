import { test } from 'playwright-test-coverage';
import type { Page } from '@playwright/test';
import {
  visitExample,
  checkForCanvasSnapshot,
  screenShotPaths,
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

async function setSlider(page: Page, index: number, value: string) {
  await page
    .locator('input[type="range"]')
    .nth(index)
    .evaluate((element: HTMLInputElement, next: string) => {
      element.value = next;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
}

test.beforeEach(async ({ page }) => {
  await visitExample(page, 'cprViewport', 2000);
  // the reformation is only final once every slice has streamed in
  await page.waitForLoadState('networkidle', { timeout: 110000 });
});

test.describe('CPR Viewport', () => {
  test('should reformat the volume along the centerline', async ({ page }) => {
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprViewport.straightened,
      [0, 1],
      snapshotOptions
    );
  });

  test('should stretch the centerline along a fixed direction', async ({
    page,
  }) => {
    await page.getByRole('combobox').first().selectOption('stretched');
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprViewport.stretched,
      [1],
      snapshotOptions
    );
  });

  test('should rotate the sampling plane about the centerline', async ({
    page,
  }) => {
    await setSlider(page, 0, '90');
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprViewport.rotated,
      [1],
      snapshotOptions
    );
  });

  test('should project a slab through the centerline', async ({ page }) => {
    await setSlider(page, 2, '20');
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprViewport.slab,
      [1],
      snapshotOptions
    );
  });
});
