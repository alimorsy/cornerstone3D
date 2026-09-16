import type { Types } from '@cornerstonejs/core';
import {
  Enums,
  RenderingEngine,
  setVolumesForViewports,
  volumeLoader,
} from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
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

const {
  CenterlineTool,
  LengthTool,
  WindowLevelTool,
  ToolGroupManager,
  Enums: csToolsEnums,
} = cornerstoneTools;

const { ViewportType } = Enums;
const { MouseBindings } = csToolsEnums;

const volumeName = 'CT_VOLUME_ID'; // Id of the volume less loader prefix
const volumeLoaderScheme = 'cornerstoneStreamingImageVolume'; // Loader id which defines which volume loader to use
const volumeId = `${volumeLoaderScheme}:${volumeName}`; // VolumeId with loader id + volume id
const renderingEngineId = 'myRenderingEngine';
const toolGroupId = 'CPR_TOOL_GROUP_ID';
const cprViewportId = 'CT_CPR';
const viewportIds = ['CT_AXIAL', 'CT_SAGITTAL', 'CT_CORONAL', cprViewportId];
const orientations = [
  Enums.OrientationAxis.AXIAL,
  Enums.OrientationAxis.SAGITTAL,
  Enums.OrientationAxis.CORONAL,
];
const toolNames = [
  CenterlineTool.toolName,
  LengthTool.toolName,
  WindowLevelTool.toolName,
];

let selectedToolName = toolNames[0];
let renderingEngine: RenderingEngine;

// ======== Set up page ======== //
setTitleAndDescription(
  'CPR Centerline Tool',
  'Draws a centerline through a volume and reformats it in a CPR viewport.'
);

const size = '450px';
const content = document.getElementById('content');
const viewportGrid = document.createElement('div');

viewportGrid.style.display = 'flex';
viewportGrid.style.flexDirection = 'row';
viewportGrid.style.flexWrap = 'wrap';
viewportGrid.style.width = '900px';

const elements = viewportIds.map(() => {
  const element = document.createElement('div');

  element.style.width = size;
  element.style.height = size;
  element.oncontextmenu = (e) => e.preventDefault();
  viewportGrid.appendChild(element);

  return element;
});

content.appendChild(viewportGrid);

const instructions = document.createElement('p');
instructions.innerText =
  'Centerline: left click control points on any MPR viewport, scrolling between clicks to follow a structure, and double click (or press Enter) to finish. Backspace removes the last point and Escape cancels. Drag a control point on its slice to adjust the curve; the CPR viewport (bottom right) follows.\n' +
  'Length: measure on the MPR viewports or on the CPR. Middle click drag pans, right click drag zooms, the mouse wheel scrolls.';
content.append(instructions);

addDropdownToToolbar({
  options: { values: toolNames, defaultValue: selectedToolName },
  onSelectedValueChange: (newSelectedToolName) => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);

    toolGroup.setToolPassive(selectedToolName);
    toolGroup.setToolActive(newSelectedToolName as string, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });
    selectedToolName = newSelectedToolName as string;
  },
});

addDropdownToToolbar({
  labelText: 'CPR mode',
  options: {
    values: ['straightened', 'stretched'],
    defaultValue: 'straightened',
  },
  onSelectedValueChange: (value) => {
    getCPRViewport().setCPRMode(value as Types.CPRMode);
  },
});

addSliderToToolbar({
  title: 'CPR rotation',
  range: [0, 360],
  defaultValue: 0,
  onSelectedValueChange: (value) => {
    getCPRViewport().setCPRRotation(Number(value));
  },
});

function getCPRViewport(): Types.ICPRViewport {
  return renderingEngine.getViewport(cprViewportId) as Types.ICPRViewport;
}

/**
 * Runs the demo
 */
async function run() {
  // Init Cornerstone and related libraries
  await initDemo();

  cornerstoneTools.addTool(CenterlineTool);
  cornerstoneTools.addTool(WindowLevelTool);

  const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

  // Pan, zoom, scroll and the Length tool
  addManipulationBindings(toolGroup);
  toolGroup.addTool(CenterlineTool.toolName);
  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.setToolActive(CenterlineTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  toolGroup.setToolPassive(LengthTool.toolName);
  toolGroup.setToolPassive(WindowLevelTool.toolName);

  // Get Cornerstone imageIds and fetch metadata into RAM
  const imageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463',
    SeriesInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561',
    wadoRsRoot: 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
  });

  // Instantiate a rendering engine
  renderingEngine = new RenderingEngine(renderingEngineId);

  renderingEngine.setViewports(
    viewportIds.map((viewportId, index) => ({
      viewportId,
      type: orientations[index] ? ViewportType.ORTHOGRAPHIC : ViewportType.CPR,
      element: elements[index],
      defaultOptions: {
        orientation: orientations[index],
        background: <Types.Point3>[0.2, 0, 0.2],
      },
    }))
  );

  viewportIds.forEach((viewportId) =>
    toolGroup.addViewport(viewportId, renderingEngineId)
  );

  // Define a volume in memory
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });

  // Set the volume to load
  volume.load();

  await setVolumesForViewports(renderingEngine, [{ volumeId }], viewportIds);

  // Render the image
  renderingEngine.renderViewports(viewportIds);
}

run();
