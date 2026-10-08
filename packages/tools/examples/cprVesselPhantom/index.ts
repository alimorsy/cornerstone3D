import type { Types } from '@cornerstonejs/core';
import {
  Enums,
  RenderingEngine,
  eventTarget,
  setVolumesForViewports,
} from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  addButtonToToolbar,
  addCheckboxToToolbar,
  addDropdownToToolbar,
  addManipulationBindings,
  addSliderToToolbar,
  createVesselPhantomVolume,
  initDemo,
  setTitleAndDescription,
} from '../../../../utils/demo/helpers';
import type { VesselPhantom } from '../../../../utils/demo/helpers/createVesselPhantomVolume';

// This is for debugging purposes
console.warn(
  'Click on index.ts to open source code for this example --------->'
);

const {
  CenterlineTool,
  LengthTool,
  WindowLevelTool,
  ToolGroupManager,
  annotation,
  Enums: csToolsEnums,
} = cornerstoneTools;

const { ViewportType, BlendModes } = Enums;
const { MouseBindings, Events: toolsEvents } = csToolsEnums;

const volumeId = 'cprVesselPhantom';
const renderingEngineId = 'myRenderingEngine';
const toolGroupId = 'CPR_TOOL_GROUP_ID';
const mprViewportId = 'CT_CORONAL';
const straightenedViewportId = 'CPR_STRAIGHTENED';
const stretchedViewportId = 'CPR_STRETCHED';
const viewportIds = [
  mprViewportId,
  straightenedViewportId,
  stretchedViewportId,
];
const cprViewportIds = [straightenedViewportId, stretchedViewportId];
const toolNames = [
  LengthTool.toolName,
  CenterlineTool.toolName,
  WindowLevelTool.toolName,
];
const blendModes = {
  MIP: BlendModes.MAXIMUM_INTENSITY_BLEND,
  MinIP: BlendModes.MINIMUM_INTENSITY_BLEND,
  Average: BlendModes.AVERAGE_INTENSITY_BLEND,
};
const defaults = { rotation: 0, width: 80, slab: 0, blend: 'MIP' };
const sweepDuration = 6000;

let selectedToolName = toolNames[0];
let renderingEngine: RenderingEngine;
let phantom: VesselPhantom;
let showTruth = false;
let truthAnnotationUID: string;
let lastMeasuredLength: number;
let sweepFrame: number;

// ======== Set up page ======== //
setTitleAndDescription(
  'CPR Vessel Phantom',
  'Reformats a synthetic vessel with a known stenosis, built in memory, so measurements on the CPR can be checked against the truth.'
);

const size = '400px';
const content = document.getElementById('content');
const viewportGrid = document.createElement('div');

viewportGrid.style.display = 'flex';
viewportGrid.style.flexDirection = 'row';
viewportGrid.style.width = '1200px';

const elements = viewportIds.map(() => {
  const element = document.createElement('div');

  element.style.width = size;
  element.style.height = size;
  element.oncontextmenu = (e) => e.preventDefault();
  viewportGrid.appendChild(element);

  return element;
});

content.appendChild(viewportGrid);

const readout = document.createElement('p');
readout.id = 'cprReadout';
content.append(readout);

const instructions = document.createElement('p');
instructions.innerText =
  'Left: coronal slice. Middle: straightened CPR. Right: stretched CPR, both along the same centerline.\n' +
  'Length: drag on the straightened CPR across the narrowest lumen and compare with the minimal diameter above. Sweep rotates the sampling plane around the vessel and shows the eccentric calcified plaque. The slab pulls in the bone beside the vessel.\n' +
  'Centerline "Drawn with tool": click control points on the coronal slice, scrolling between clicks, and double click to finish.';
content.append(instructions);

addDropdownToToolbar({
  id: 'cprCenterline',
  labelText: 'Centerline',
  options: {
    values: ['Phantom truth', 'Drawn with tool'],
    defaultValue: 'Phantom truth',
  },
  onSelectedValueChange: (value) => {
    if (value === 'Phantom truth') {
      applyTruthCenterline();
    } else {
      clearCenterline();
      setPrimaryTool(CenterlineTool.toolName);
    }
  },
});

addDropdownToToolbar({
  id: 'cprTool',
  labelText: 'Tool',
  options: { values: toolNames, defaultValue: selectedToolName },
  onSelectedValueChange: (value) => setPrimaryTool(value as string),
});

addSliderToToolbar({
  id: 'cprRotation',
  title: 'Rotation',
  range: [0, 360],
  defaultValue: defaults.rotation,
  onSelectedValueChange: (value) => setRotation(Number(value)),
});

addButtonToToolbar({
  id: 'cprSweep',
  title: 'Sweep',
  onClick: toggleSweep,
});

addSliderToToolbar({
  id: 'cprWidth',
  title: 'Width (mm)',
  range: [20, 160],
  defaultValue: defaults.width,
  onSelectedValueChange: (value) => {
    getCPRViewports().forEach((viewport) =>
      viewport.setCPRWidth(Number(value))
    );
    updateTruthAnnotation();
  },
});

addSliderToToolbar({
  id: 'cprSlab',
  title: 'Slab (mm)',
  range: [0, 30],
  defaultValue: defaults.slab,
  onSelectedValueChange: (value) => {
    getCPRViewports().forEach((viewport) =>
      viewport.setSlabThickness(Number(value))
    );
  },
});

addDropdownToToolbar({
  id: 'cprBlend',
  labelText: 'Slab blend',
  options: { values: Object.keys(blendModes), defaultValue: defaults.blend },
  onSelectedValueChange: (value) => {
    getCPRViewports().forEach((viewport) =>
      viewport.setBlendMode(blendModes[value as keyof typeof blendModes])
    );
  },
});

addCheckboxToToolbar({
  id: 'cprTruth',
  title: 'Show ground truth',
  onChange: (checked) => {
    showTruth = checked;
    updateTruthAnnotation();
  },
});

addButtonToToolbar({
  id: 'cprReset',
  title: 'Reset',
  onClick: reset,
});

function getCPRViewports(): Types.ICPRViewport[] {
  return cprViewportIds.map(
    (viewportId) =>
      renderingEngine.getViewport(viewportId) as Types.ICPRViewport
  );
}

function setPrimaryTool(toolName: string) {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);

  toolGroup.setToolPassive(selectedToolName);
  toolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  selectedToolName = toolName;
  (<HTMLSelectElement>document.getElementById('cprTool')).value = toolName;
}

function setRotation(degrees: number) {
  getCPRViewports().forEach((viewport) => viewport.setCPRRotation(degrees));
  (<HTMLInputElement>document.getElementById('cprRotation')).value = String(
    Math.round(degrees)
  );
  updateTruthAnnotation();
}

function toggleSweep() {
  const button = document.getElementById('cprSweep');

  if (sweepFrame) {
    cancelAnimationFrame(sweepFrame);
    sweepFrame = undefined;
    button.innerText = 'Sweep';
    return;
  }

  const start = performance.now();
  const step = (now: number) => {
    setRotation((((now - start) / sweepDuration) * 360) % 360);
    sweepFrame = requestAnimationFrame(step);
  };

  button.innerText = 'Stop';
  sweepFrame = requestAnimationFrame(step);
}

function applyTruthCenterline() {
  const mprElement = elements[0];

  // Removing a drawn centerline clears the CPR viewports it was applied to
  annotation.state
    .getAnnotations(CenterlineTool.toolName, mprElement)
    ?.forEach((drawn) =>
      annotation.state.removeAnnotation(drawn.annotationUID)
    );
  getCPRViewports().forEach((viewport) =>
    viewport.setCenterline({ points: phantom.centerline })
  );
  updateTruthAnnotation();
  updateReadout();
}

function clearCenterline() {
  getCPRViewports().forEach((viewport) => viewport.setCenterline(undefined));
  updateTruthAnnotation();
  updateReadout();
}

/**
 * Draws the true minimal lumen diameter as a locked length on the
 * straightened CPR, across the sampling direction at the stenosis, so that a
 * measurement made there can be compared with it. The stretched CPR samples
 * obliquely to the vessel, where the chord is longer than the diameter.
 */
function updateTruthAnnotation() {
  if (truthAnnotationUID) {
    annotation.state.removeAnnotation(truthAnnotationUID);
    truthAnnotationUID = undefined;
  }

  const viewport = renderingEngine.getViewport(
    straightenedViewportId
  ) as Types.ICPRViewport;

  if (!showTruth || !viewport.getCenterline()) {
    renderingEngine.renderViewports(cprViewportIds);
    return;
  }

  const { position, diameter } = phantom.stenosis;
  const canvasPoint = viewport.worldToCanvas(position);
  const lateral = viewport.canvasToWorld([canvasPoint[0] + 1, canvasPoint[1]]);
  const direction = lateral.map((value, i) => value - position[i]);
  const scale = diameter / 2 / Math.hypot(...direction);
  const points = [1, -1].map(
    (sign) =>
      <Types.Point3>(
        position.map((value, i) => value + sign * scale * direction[i])
      )
  );
  const truth = LengthTool.createAnnotationForViewport(viewport, {
    data: { handles: { points } },
  });

  annotation.state.addAnnotation(truth, viewport.element);
  annotation.locking.setAnnotationLocked(truth.annotationUID, true);
  truthAnnotationUID = truth.annotationUID;
  renderingEngine.renderViewports(cprViewportIds);
}

function updateReadout() {
  const viewport = renderingEngine.getViewport(
    straightenedViewportId
  ) as Types.ICPRViewport;
  const { length, diameter, stenosis } = phantom;
  const lines = [
    `Phantom: lumen ${diameter.toFixed(1)} mm, stenosis at ${stenosis.distance.toFixed(1)} mm along the centerline with a minimal diameter of ${stenosis.diameter.toFixed(2)} mm, centerline length ${length.toFixed(1)} mm.`,
    `Viewport: centerline length ${viewport.getCenterlineLength().toFixed(1)} mm.`,
    `Last length measured: ${
      lastMeasuredLength === undefined
        ? 'none yet'
        : `${lastMeasuredLength.toFixed(2)} mm`
    }.`,
  ];

  readout.innerText = lines.join('\n');
}

function reset() {
  if (sweepFrame) {
    toggleSweep();
  }

  (<HTMLInputElement>document.getElementById('cprWidth')).value = String(
    defaults.width
  );
  (<HTMLInputElement>document.getElementById('cprSlab')).value = String(
    defaults.slab
  );
  (<HTMLSelectElement>document.getElementById('cprBlend')).value =
    defaults.blend;

  getCPRViewports().forEach((viewport) => {
    viewport.resetProperties();
    viewport.setCPRWidth(defaults.width);
    viewport.setSlabThickness(defaults.slab);
    viewport.setBlendMode(blendModes[defaults.blend]);
    viewport.setProperties({ voiRange: phantom.voiRange });
    viewport.resetCamera();
  });
  renderingEngine.getViewport(mprViewportId).resetCamera();
  setRotation(defaults.rotation);
  renderingEngine.renderViewports(viewportIds);
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
  toolGroup.setToolActive(LengthTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  toolGroup.setToolPassive(CenterlineTool.toolName);
  toolGroup.setToolPassive(WindowLevelTool.toolName);

  // Build the volume in memory, no network needed
  phantom = createVesselPhantomVolume(volumeId);

  // Instantiate a rendering engine
  renderingEngine = new RenderingEngine(renderingEngineId);

  renderingEngine.setViewports(
    viewportIds.map((viewportId, index) => ({
      viewportId,
      type: index === 0 ? ViewportType.ORTHOGRAPHIC : ViewportType.CPR,
      element: elements[index],
      defaultOptions: {
        orientation: index === 0 ? Enums.OrientationAxis.CORONAL : undefined,
        background: <Types.Point3>[0.2, 0, 0.2],
      },
    }))
  );

  viewportIds.forEach((viewportId) =>
    toolGroup.addViewport(viewportId, renderingEngineId)
  );

  await setVolumesForViewports(renderingEngine, [{ volumeId }], viewportIds);

  viewportIds.forEach((viewportId) =>
    (<Types.IVolumeViewport>(
      renderingEngine.getViewport(viewportId)
    )).setProperties({ voiRange: phantom.voiRange })
  );

  const [straightened, stretched] = getCPRViewports();
  straightened.setCPRMode('straightened');
  stretched.setCPRMode('stretched');
  renderingEngine.getViewport(mprViewportId).resetCamera();
  getCPRViewports().forEach((viewport) => viewport.setCPRWidth(defaults.width));

  // Report lengths measured with the Length tool
  eventTarget.addEventListener(toolsEvents.ANNOTATION_MODIFIED, (evt) => {
    const { annotation: modified } = (<CustomEvent>evt).detail;

    if (
      modified?.metadata?.toolName !== LengthTool.toolName ||
      modified.annotationUID === truthAnnotationUID
    ) {
      return;
    }

    const [stats] = Object.values(modified.data.cachedStats ?? {}) as {
      length?: number;
    }[];

    if (stats?.length) {
      lastMeasuredLength = stats.length;
      updateReadout();
    }
  });

  applyTruthCenterline();

  // Render the image
  renderingEngine.renderViewports(viewportIds);
}

run();
