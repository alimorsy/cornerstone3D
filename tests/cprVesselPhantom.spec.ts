import { test } from 'playwright-test-coverage';
import type { Page } from '@playwright/test';
import {
  visitExample,
  checkForCanvasSnapshot,
  screenShotPaths,
  expectAnnotationText,
} from './utils/index';

// The phantom is built in memory, so nothing streams in after the first
// render. The edge of the reformatted quad rasterizes a pixel differently
// from run to run, so a thin line of pixels is allowed to differ.
const snapshotOptions = { maxDiffPixelRatio: 0.005 };

async function setSlider(page: Page, id: string, value: string) {
  await page
    .locator(`#${id}`)
    .evaluate((element: HTMLInputElement, next: string) => {
      element.value = next;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

test.beforeEach(async ({ page }) => {
  await visitExample(page, 'cprVesselPhantom', 500);
});

test.describe('CPR Vessel Phantom', () => {
  test('should reformat the phantom vessel in both modes', async ({ page }) => {
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprVesselPhantom.reformations,
      [0, 1, 2],
      snapshotOptions
    );
  });

  test('should rotate the sampling plane about the vessel', async ({
    page,
  }) => {
    await setSlider(page, 'cprRotation', '90');
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprVesselPhantom.rotated,
      [1, 2],
      snapshotOptions
    );
  });

  test('should project the bone beside the vessel into a thick slab', async ({
    page,
  }) => {
    await setSlider(page, 'cprSlab', '20');
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprVesselPhantom.slab,
      [1],
      snapshotOptions
    );
  });

  test('should show the true minimal diameter on the straightened CPR', async ({
    page,
  }) => {
    await page.locator('#cprTruth').check();
    await expectAnnotationText(page, 1, '4.00 mm');
    await checkForCanvasSnapshot(
      page,
      '',
      screenShotPaths.cprVesselPhantom.truth,
      [1],
      { ...snapshotOptions, hideAnnotationText: true }
    );
  });
});
