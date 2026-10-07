import * as cornerstone3D from '@cornerstonejs/core';
import * as csTools3d from '../src/index';
import * as testUtils from '../../../utils/test/testUtils';
import { performMouseDownAndUp } from '../../../utils/test/testUtilsMouseEvents';

const { Enums, utilities, volumeLoader, setVolumesForViewports } =
  cornerstone3D;
const { Events, ViewportType } = Enums;
const {
  CenterlineTool,
  LengthTool,
  ToolGroupManager,
  Enums: csToolsEnums,
  annotation,
  utilities: toolsUtilities,
} = csTools3d;
const { Events: csToolsEvents } = csToolsEnums;
const { createNormalizedMouseEvent, createViewports } = testUtils;

const renderingEngineId = utilities.uuidv4();
const toolGroupId = 'default';
const axialViewportId = 'AXIAL';
const cprViewportId = 'CPR';

const volumeId = testUtils.encodeVolumeIdInfo({
  loader: 'fakeVolumeLoader',
  name: 'volumeURI',
  rows: 100,
  columns: 100,
  slices: 10,
  xSpacing: 1,
  ySpacing: 1,
});

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves on the first accepted event, or rejects before karma's 6 s
// no-activity limit would disconnect the browser.
function once(element, type, accept = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      element.removeEventListener(type, listener);
      reject(new Error(`no accepted ${type} event within ${timeout} ms`));
    }, timeout);
    const listener = (evt) => {
      if (!accept(evt)) {
        return;
      }
      clearTimeout(timer);
      element.removeEventListener(type, listener);
      resolve(evt);
    };
    element.addEventListener(type, listener);
  });
}

function mouseEventsAt(vp, element, index) {
  const { imageData } = vp.getImageData();
  const { pageX, pageY, clientX, clientY, worldCoord } =
    createNormalizedMouseEvent(imageData, index, element, vp);
  const init = { target: element, buttons: 1, clientX, clientY, pageX, pageY };
  return {
    init,
    down: () => new MouseEvent('mousedown', init),
    up: () => new MouseEvent('mouseup', { ...init, buttons: 0 }),
    world: worldCoord,
  };
}

function mouseInitAtCanvas(vp, element, canvasPoint) {
  const rect = vp.getCanvas().getBoundingClientRect();
  const clientX = rect.left + canvasPoint[0];
  const clientY = rect.top + canvasPoint[1];
  return {
    target: element,
    buttons: 1,
    clientX,
    clientY,
    pageX: clientX + window.pageXOffset,
    pageY: clientY + window.pageYOffset,
  };
}

describe('CenterlineTool:', () => {
  let renderingEngine;
  let defaultTimeout;

  beforeEach(function () {
    defaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 15000;
    const testEnv = testUtils.setupTestEnvironment({
      renderingEngineId,
      toolGroupIds: [toolGroupId],
      tools: [CenterlineTool, LengthTool],
      toolActivations: {
        [CenterlineTool.toolName]: { bindings: [{ mouseButton: 1 }] },
      },
      viewportIds: [axialViewportId, cprViewportId],
    });
    renderingEngine = testEnv.renderingEngine;
  });

  afterEach(function () {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout;
    testUtils.cleanupTestEnvironment({
      renderingEngineId,
      toolGroupIds: [toolGroupId],
    });
  });

  async function setup() {
    const [axialElement, cprElement] = createViewports(renderingEngine, [
      {
        viewportId: axialViewportId,
        viewportType: ViewportType.ORTHOGRAPHIC,
        orientation: Enums.OrientationAxis.AXIAL,
        width: 256,
        height: 256,
      },
      {
        viewportId: cprViewportId,
        viewportType: ViewportType.CPR,
        width: 256,
        height: 256,
      },
    ]);
    const axialVp = renderingEngine.getViewport(axialViewportId);
    const cprVp = renderingEngine.getViewport(cprViewportId);

    await volumeLoader.createAndCacheVolume(volumeId, { imageIds: [] });
    const rendered = once(axialElement, Events.IMAGE_RENDERED);
    await setVolumesForViewports(
      renderingEngine,
      [{ volumeId }],
      [axialViewportId, cprViewportId]
    );
    cprVp.setCPRWidth(60);
    axialVp.render();
    await rendered;
    // the tool reads the camera and slice from the rendered viewport
    await wait(300);

    return { axialElement, cprElement, axialVp, cprVp };
  }

  it('draws a centerline with clicks and reformats the CPR viewport along it', async () => {
    const { axialElement, cprElement, axialVp, cprVp } = await setup();
    expect(cprVp.getCenterline()).toBeUndefined();

    const clicks = [
      [20, 20, 4],
      [50, 35, 4],
      [80, 20, 4],
    ].map((index) => mouseEventsAt(axialVp, axialElement, index));
    const finish = mouseEventsAt(axialVp, axialElement, [90, 40, 4]);

    // first click creates the annotation, later clicks extend it
    await performMouseDownAndUp(axialElement, clicks[0].down(), clicks[0].up());
    expect(cprVp.getCenterline()).toBeUndefined();
    for (const click of clicks.slice(1)) {
      await performMouseDownAndUp(
        axialElement,
        click.down(),
        click.up(),
        null,
        null,
        false
      );
    }
    expect(cprVp.getCenterline()).toBeDefined();

    // a double click adds its point and finishes the centerline
    axialElement.dispatchEvent(finish.down());
    document.dispatchEvent(finish.up());
    axialElement.dispatchEvent(finish.down());
    document.dispatchEvent(finish.up());
    axialElement.dispatchEvent(new MouseEvent('dblclick', finish.init));
    // longer than the double-click detection window of the mouse listener
    await wait(600);

    const annotations = annotation.state.getAnnotations(
      CenterlineTool.toolName,
      axialElement
    );
    expect(annotations.length).toBe(1);
    const [centerline] = annotations;
    const worlds = [...clicks.map((click) => click.world), finish.world];
    expect(centerline.data.handles.points.length).toBe(4);
    centerline.data.handles.points.forEach((point, index) => {
      expect(distance(point, worlds[index])).toBeLessThan(1e-6);
    });

    const { polyline } = centerline.data.contour;
    const chords = worlds
      .slice(1)
      .reduce((sum, world, index) => sum + distance(world, worlds[index]), 0);
    const polylineLength = polyline
      .slice(1)
      .reduce((sum, point, index) => sum + distance(point, polyline[index]), 0);
    expect(polylineLength).toBeGreaterThanOrEqual(chords);
    expect(polylineLength).toBeLessThan(1.2 * chords);
    expect(distance(polyline[0], worlds[0])).toBeLessThan(1e-6);
    expect(distance(polyline[polyline.length - 1], worlds[3])).toBeLessThan(
      1e-6
    );

    const applied = cprVp.getCenterline();
    expect(applied.points.length).toBe(polyline.length);
    expect(cprVp.getCenterlineLength()).toBeCloseTo(polylineLength, 3);

    const rendered = once(cprElement, Events.IMAGE_RENDERED);
    cprVp.render();
    await rendered;
    const canvas = cprVp.getCanvas();
    const { data } = canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height);
    let reformatted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255)) {
        reformatted++;
      }
    }
    expect(reformatted).toBeGreaterThan(5000);
  });

  it('removes the centerline from the CPR viewport with the annotation', async () => {
    const { axialElement, axialVp, cprVp } = await setup();
    const clicks = [
      [20, 20, 4],
      [60, 40, 4],
    ].map((index) => mouseEventsAt(axialVp, axialElement, index));
    await performMouseDownAndUp(axialElement, clicks[0].down(), clicks[0].up());
    await performMouseDownAndUp(
      axialElement,
      clicks[1].down(),
      clicks[1].up(),
      null,
      null,
      false
    );
    axialElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    // the key listener keeps the pressed key as a modifier until it is
    // released, which would stop every mouse binding from matching
    document.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    await wait(100);
    expect(cprVp.getCenterline()).toBeDefined();

    const [centerline] = annotation.state.getAnnotations(
      CenterlineTool.toolName,
      axialElement
    );
    annotation.state.removeAnnotation(centerline.annotationUID);
    expect(cprVp.getCenterline()).toBeUndefined();
  });

  it('measures lengths on the CPR viewport between points on the surface', async () => {
    const { cprElement, cprVp } = await setup();
    const points = toolsUtilities.centerline.resampleCenterline(
      [
        [20, 20, 4],
        [50, 35, 4],
        [80, 20, 4],
      ],
      1
    );
    cprVp.setCenterline({ points });
    cprVp.resetCamera();
    const rendered = once(cprElement, Events.IMAGE_RENDERED);
    cprVp.render();
    await rendered;

    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    toolGroup.setToolPassive(CenterlineTool.toolName);
    toolGroup.setToolActive(LengthTool.toolName, {
      bindings: [{ mouseButton: 1 }],
    });

    const p1 = [100, 100];
    const p2 = [160, 150];
    const expected = [p1, p2].map((p) => cprVp.canvasToWorld(p));
    expect(Number.isFinite(expected[0][0])).toBe(true);

    const completed = once(
      cprElement,
      csToolsEvents.ANNOTATION_RENDERED,
      () => {
        const [length] = annotation.state.getAnnotations(
          LengthTool.toolName,
          cprElement
        );
        return length && !length.invalidated && length.data.cachedStats;
      }
    );
    // press at p1, drag to p2 once the deferred mouse down has been
    // processed (an undragged length is discarded on mouse up), release
    const start = mouseInitAtCanvas(cprVp, cprElement, p1);
    const end = mouseInitAtCanvas(cprVp, cprElement, p2);
    await performMouseDownAndUp(
      cprElement,
      new MouseEvent('mousedown', start),
      new MouseEvent('mouseup', { ...end, buttons: 0 }),
      () => document.dispatchEvent(new MouseEvent('mousemove', end))
    );
    await completed;

    const [length] = annotation.state.getAnnotations(
      LengthTool.toolName,
      cprElement
    );
    const handles = length.data.handles.points;
    expect(handles.length).toBe(2);
    handles.forEach((handle, index) => {
      expect(distance(handle, expected[index])).toBeLessThan(1e-3);
      // the handles lie on the reformatted surface, so they map back
      const canvas = cprVp.worldToCanvas(handle);
      expect(Math.abs(canvas[0] - [p1, p2][index][0])).toBeLessThan(0.01);
      expect(Math.abs(canvas[1] - [p1, p2][index][1])).toBeLessThan(0.01);
    });
    const [stats] = Object.values(length.data.cachedStats);
    expect(stats.length).toBeCloseTo(distance(expected[0], expected[1]), 3);
    expect(stats.unit).toBe('mm');
  });
});
