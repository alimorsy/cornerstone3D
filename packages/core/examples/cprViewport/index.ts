import type { Types } from '@cornerstonejs/core';
import {
  Enums,
  RenderingEngine,
  setVolumesForViewports,
  volumeLoader,
} from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  addButtonToToolbar,
  addDropdownToToolbar,
  addManipulationBindings,
  addSliderToToolbar,
  createImageIdsAndCacheMetaData,
  initDemo,
  setTitleAndDescription,
} from '../../../../utils/demo/helpers';

// This is for debugging purposes
console.warn(
  'Click on index.ts to open source code for this example --------->'
);

const { ToolGroupManager } = cornerstoneTools;
const { ViewportType, BlendModes } = Enums;

const volumeName = 'CT_VOLUME_ID'; // Id of the volume less loader prefix
const volumeLoaderScheme = 'cornerstoneStreamingImageVolume'; // Loader id which defines which volume loader to use
const volumeId = `${volumeLoaderScheme}:${volumeName}`; // VolumeId with loader id + volume id
const renderingEngineId = 'myRenderingEngine';
const toolGroupId = 'CPR_TOOL_GROUP_ID';
const coronalViewportId = 'CT_CORONAL';
const cprViewportId = 'CT_CPR';

let cprViewport: Types.ICPRViewport;

// ======== Set up page ======== //
setTitleAndDescription(
  'CPR Viewport',
  'Reformats a CT volume along a curved centerline. The reformation can be straightened or stretched, rotated around the centerline, sampled over a narrower width and rendered as a thick slab.'
);

const size = '500px';
const content = document.getElementById('content');
const viewportGrid = document.createElement('div');

viewportGrid.style.display = 'flex';
viewportGrid.style.flexDirection = 'row';

const coronalElement = document.createElement('div');
const cprElement = document.createElement('div');

for (const element of [coronalElement, cprElement]) {
  element.style.width = size;
  element.style.height = size;
  element.oncontextmenu = (e) => e.preventDefault();
  viewportGrid.appendChild(element);
}

content.appendChild(viewportGrid);

const instructions = document.createElement('p');
instructions.innerText =
  'Left: coronal MPR. Right: the CPR along a curve through the volume. Left click drag for window/level, middle for pan, right for zoom.';
content.append(instructions);

addDropdownToToolbar({
  labelText: 'Mode',
  options: {
    values: ['straightened', 'stretched'],
    defaultValue: 'straightened',
  },
  onSelectedValueChange: (value) => {
    cprViewport.setCPRMode(value as Types.CPRMode);
  },
});

addSliderToToolbar({
  title: 'Rotation',
  range: [0, 360],
  defaultValue: 0,
  onSelectedValueChange: (value) => {
    cprViewport.setCPRRotation(Number(value));
  },
});

addSliderToToolbar({
  title: 'Width (mm)',
  range: [20, 400],
  defaultValue: 200,
  onSelectedValueChange: (value) => {
    cprViewport.setCPRWidth(Number(value));
  },
});

addSliderToToolbar({
  title: 'Slab (mm)',
  range: [0, 40],
  defaultValue: 0,
  onSelectedValueChange: (value) => {
    cprViewport.setSlabThickness(Number(value));
  },
});

const blendModes = {
  MIP: BlendModes.MAXIMUM_INTENSITY_BLEND,
  MinIP: BlendModes.MINIMUM_INTENSITY_BLEND,
  Average: BlendModes.AVERAGE_INTENSITY_BLEND,
};

addDropdownToToolbar({
  labelText: 'Slab blend',
  options: { values: Object.keys(blendModes), defaultValue: 'MIP' },
  onSelectedValueChange: (value) => {
    cprViewport.setBlendMode(blendModes[value as keyof typeof blendModes]);
  },
});

addButtonToToolbar({
  title: 'Reset',
  onClick: () => {
    cprViewport.resetProperties();
    cprViewport.resetCamera();
    cprViewport.render();
  },
});

/**
 * A curve winding through the volume, standing in for a vessel centerline
 * produced by a segmentation or drawn with the CenterlineTool.
 */
function createCenterline(volume: Types.IImageVolume): Types.CPRCenterline {
  const [xMin, xMax, yMin, yMax, zMin, zMax] = volume.imageData.getBounds();
  const points: Types.Point3[] = [];

  for (let index = 0; index <= 100; index++) {
    const t = index / 100;
    points.push([
      xMin + (xMax - xMin) * (0.5 + 0.2 * Math.sin(2 * Math.PI * t)),
      yMin + (yMax - yMin) * (0.5 + 0.1 * Math.cos(2 * Math.PI * t)),
      zMin + (zMax - zMin) * (0.1 + 0.8 * t),
    ]);
  }

  return { points };
}

/**
 * Runs the demo
 */
async function run() {
  // Init Cornerstone and related libraries
  await initDemo();

  const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
  addManipulationBindings(toolGroup);

  // Get Cornerstone imageIds and fetch metadata into RAM
  const imageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463',
    SeriesInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561',
    wadoRsRoot: 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
  });

  // Instantiate a rendering engine
  const renderingEngine = new RenderingEngine(renderingEngineId);

  renderingEngine.setViewports([
    {
      viewportId: coronalViewportId,
      type: ViewportType.ORTHOGRAPHIC,
      element: coronalElement,
      defaultOptions: {
        orientation: Enums.OrientationAxis.CORONAL,
        background: <Types.Point3>[0.2, 0, 0.2],
      },
    },
    {
      viewportId: cprViewportId,
      type: ViewportType.CPR,
      element: cprElement,
      defaultOptions: {
        background: <Types.Point3>[0.2, 0, 0.2],
      },
    },
  ]);

  toolGroup.addViewport(coronalViewportId, renderingEngineId);
  toolGroup.addViewport(cprViewportId, renderingEngineId);

  // Define a volume in memory
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });

  // Set the volume to load
  volume.load();

  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId }],
    [coronalViewportId, cprViewportId]
  );

  cprViewport = renderingEngine.getViewport(
    cprViewportId
  ) as Types.ICPRViewport;
  cprViewport.setCPRWidth(200);
  cprViewport.setCenterline(createCenterline(volume));

  // Render the image
  renderingEngine.renderViewports([coronalViewportId, cprViewportId]);
}

run();
