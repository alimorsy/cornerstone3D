import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import type vtkAbstractImageMapper from '@kitware/vtk.js/Rendering/Core/AbstractImageMapper';
import vtkImageCPRMapper from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper';
import { ProjectionMode } from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper/Constants';
import vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import { RENDERING_DEFAULTS } from '../constants';
import cache from '../cache/cache';
import { BlendModes, Events } from '../enums';
import eventTarget from '../eventTarget';
import type {
  ActorEntry,
  CPRCenterline,
  CPRMode,
  EventTypes,
  IImageVolume,
  IVolumeInput,
  Point2,
  Point3,
  ViewReference,
  VolumeActor,
} from '../types';
import type { ViewportInput } from '../types/IViewport';
import createLinearRGBTransferFunction from '../utilities/createLinearRGBTransferFunction';
import triggerEvent from '../utilities/triggerEvent';
import uuidv4 from '../utilities/uuidv4';
import BaseVolumeViewport from './BaseVolumeViewport';
import {
  computeCenterlineOrientations,
  createCenterlinePolyData,
  cprToWorld,
  worldToCPR,
} from './helpers/cprCenterline';
import setDefaultVolumeVOI from './helpers/setDefaultVolumeVOI';

const OFFSCREEN_CANVAS_POSITION: Point2 = [-1e5, -1e5];
const MAXIMUM_SLAB_SAMPLES = 101;

const projectionModes = new Map<BlendModes, ProjectionMode>([
  [BlendModes.MAXIMUM_INTENSITY_BLEND, ProjectionMode.MAX],
  [BlendModes.MINIMUM_INTENSITY_BLEND, ProjectionMode.MIN],
  [BlendModes.AVERAGE_INTENSITY_BLEND, ProjectionMode.AVERAGE],
]);

// vtkImageCPRMapper reads standard point-data scalars, which volumes keep
// in their voxel manager instead. Each volume gets one scalar-bearing copy
// of its image data, shared by every CPR viewport that shows it.
const scalarImageDataCache = new WeakMap<vtkImageData, vtkImageData>();

function updateScalars(volume: IImageVolume, imageData: vtkImageData): void {
  const values = volume.voxelManager.getCompleteScalarDataArray();
  const [x, y, z] = imageData.getDimensions();

  imageData.getPointData().setScalars(
    vtkDataArray.newInstance({
      name: 'Pixels',
      numberOfComponents: values.length / (x * y * z),
      values,
    })
  );
  imageData.modified();
}

function getScalarImageData(volume: IImageVolume): vtkImageData {
  const { imageData } = volume;

  if (imageData.getPointData().getScalars()) {
    return imageData;
  }

  let scalarImageData = scalarImageDataCache.get(imageData);

  if (!scalarImageData) {
    scalarImageData = vtkImageData.newInstance();
    scalarImageData.setDimensions(imageData.getDimensions());
    scalarImageData.setSpacing(imageData.getSpacing());
    scalarImageData.setDirection(imageData.getDirection());
    scalarImageData.setOrigin(imageData.getOrigin());
    updateScalars(volume, scalarImageData);
    scalarImageDataCache.set(imageData, scalarImageData);
  }

  return scalarImageData;
}

/**
 * A viewport rendering a curved planar reformation (CPR) of a volume: the
 * volume is sampled along a centerline and shown as a flat image whose
 * vertical axis follows the centerline. The reformation is rendered by
 * vtkImageCPRMapper.
 *
 * Set the volume with `setVolumes` and the path with `setCenterline`. The
 * reformation can be straightened or stretched (`setCPRMode`), rotated
 * around the centerline (`setCPRRotation`), and rendered as a thick slab
 * through `setSlabThickness` and `setBlendMode`.
 *
 * `canvasToWorld` and `worldToCanvas` map through the centerline, so
 * annotation tools measure real world positions on the reformation. World
 * points that are not on the sampled surface map off canvas.
 */
class CPRViewport extends BaseVolumeViewport {
  private mapper: vtkImageCPRMapper;
  private actor: vtkImageSlice;
  private centerline: CPRCenterline | undefined;
  private centerlineLength = 0;
  private cprMode: CPRMode = 'straightened';
  private cprRotation = 0;
  private cprWidth: number | undefined;
  // Orientation of the frame at the middle of the centerline; the reformation
  // is placed and viewed in world space relative to this frame
  private referenceFrame = quat.create();
  private actorMatrix = mat4.create();
  private inverseActorMatrix = mat4.create();
  private removeVolumeListener: (() => void) | undefined;
  // The camera projection, which the public transforms extend through the
  // centerline
  private projectCanvasToWorld: (canvasPos: Point2) => Point3;
  private projectWorldToCanvas: (worldPos: Point3) => Point2;

  constructor(props: ViewportInput) {
    super(props);

    this.mapper = vtkImageCPRMapper.newInstance();
    const imageMapper = this.mapper as unknown as vtkAbstractImageMapper;
    imageMapper.setBackgroundColor(0, 0, 0, 0);
    this.actor = vtkImageSlice.newInstance();
    this.actor.setMapper(imageMapper);
    this.actor.setVisibility(false);

    // BaseVolumeViewport assigns the transforms as instance properties, so
    // they are wrapped here rather than overridden
    this.projectCanvasToWorld = this.canvasToWorld;
    this.projectWorldToCanvas = this.worldToCanvas;

    this.canvasToWorld = (canvasPos: Point2): Point3 => {
      const worldOnImage = this.projectCanvasToWorld(canvasPos);

      if (!this.centerline) {
        return worldOnImage;
      }

      const model = vec3.transformMat4(
        vec3.create(),
        worldOnImage,
        this.inverseActorMatrix
      );
      const distance = this.mapper.getHeight() - model[1];
      const lateral = model[0] - this.mapper.getWidth() / 2;

      return cprToWorld(this.mapper, distance, lateral) || worldOnImage;
    };

    this.worldToCanvas = (worldPos: Point3): Point2 => {
      if (!this.centerline) {
        return this.projectWorldToCanvas(worldPos);
      }

      const coordinate = worldToCPR(this.mapper, worldPos);

      if (!coordinate || coordinate.depth > this.getSurfaceTolerance()) {
        return [...OFFSCREEN_CANVAS_POSITION] as Point2;
      }

      const model = vec3.fromValues(
        coordinate.lateral + this.mapper.getWidth() / 2,
        this.mapper.getHeight() - coordinate.distance,
        0
      );

      return this.projectWorldToCanvas(
        vec3.transformMat4(model, model, this.actorMatrix) as Point3
      );
    };
  }

  /**
   * Sets the volume to reformat. Only the first volume input is used.
   */
  public async setVolumes(
    volumeInputArray: IVolumeInput[],
    immediate = false,
    suppressEvents = false
  ): Promise<void> {
    const { volumeId, actorUID, callback } = volumeInputArray[0];
    const volume = cache.getVolume(volumeId);

    if (!volume) {
      throw new Error(
        `imageVolume with id: ${volumeId} does not exist, you need to create/allocate the volume first`
      );
    }

    this.removeVolumeListener?.();
    this._FrameOfReferenceUID = volume.metadata.FrameOfReferenceUID;
    this._addVolumeId(volumeId);

    const imageData = getScalarImageData(volume);
    this.mapper.setInputData(imageData, 0);

    if (this.cprWidth === undefined) {
      const [x, y, z] = imageData.getDimensions();
      const [dx, dy, dz] = imageData.getSpacing();
      this.mapper.setWidth(Math.hypot(x * dx, y * dy, z * dz));
    }

    if (imageData !== volume.imageData) {
      // Streaming volumes fill their voxel manager after this point, so the
      // scalars are copied again once the volume has loaded
      const onLoaded = (evt: EventTypes.ImageVolumeLoadingCompletedEvent) => {
        if (evt.detail.volumeId === volumeId) {
          updateScalars(volume, imageData);
          this.render();
        }
      };
      eventTarget.addEventListener(
        Events.IMAGE_VOLUME_LOADING_COMPLETED,
        onLoaded
      );
      this.removeVolumeListener = () =>
        eventTarget.removeEventListener(
          Events.IMAGE_VOLUME_LOADING_COMPLETED,
          onLoaded
        );
    }

    const actorEntry: ActorEntry = {
      uid: actorUID || uuidv4(),
      actor: this.actor,
      referencedId: volumeId,
    };
    this.setActors([actorEntry]);
    this.updateActorVisibility();

    await setDefaultVolumeVOI(this.actor, volume);
    const property = this.actor.getProperty();
    if (!property.getRGBTransferFunction(0)) {
      const [lower, upper] = volume.voxelManager.getRange();
      property.setRGBTransferFunction(
        0,
        createLinearRGBTransferFunction({ lower, upper })
      );
      property.setUseLookupTableScalarRange(true);
    }

    callback?.({ volumeActor: this.actor as unknown as VolumeActor, volumeId });

    if (!suppressEvents) {
      triggerEvent(this.element, Events.VOLUME_VIEWPORT_NEW_VOLUME, {
        viewportId: this.id,
        volumeActors: [actorEntry],
      });
    }

    if (immediate) {
      this.render();
    }
  }

  /**
   * Sets the centerline to reformat along, or clears it when undefined.
   * Orientations are computed as rotation-minimizing frames when the
   * centerline does not provide them.
   */
  public setCenterline(centerline?: CPRCenterline): void {
    const hadCenterline = !!this.centerline;

    if (!centerline || centerline.points.length < 2) {
      this.centerline = undefined;
      this.centerlineLength = 0;
      this.mapper.setInputData(vtkPolyData.newInstance(), 1);
    } else {
      const points = centerline.points.map((point) => [...point] as Point3);
      const orientations =
        centerline.orientations?.length === points.length * 16
          ? centerline.orientations
          : computeCenterlineOrientations(points);

      this.centerline = { points, orientations };
      this.centerlineLength = points.reduce(
        (length, point, index) =>
          index ? length + vec3.distance(point, points[index - 1]) : 0,
        0
      );
      this.mapper.setInputData(
        createCenterlinePolyData(points, orientations),
        1
      );
      this.updateReferenceFrame();
      this.applyMode();
      this.updateGeometry();
    }

    this.updateActorVisibility();

    if (this.centerline) {
      this.updateCamera(hadCenterline);
    }

    this.render();

    triggerEvent(this.element, Events.CPR_CENTERLINE_MODIFIED, {
      viewportId: this.id,
      centerline: this.centerline,
    });
  }

  public getCenterline(): CPRCenterline | undefined {
    return this.centerline;
  }

  /**
   * Length of the centerline in world units.
   */
  public getCenterlineLength(): number {
    return this.centerlineLength;
  }

  public setCPRMode(mode: CPRMode): void {
    if (mode === this.cprMode) {
      return;
    }

    this.cprMode = mode;
    this.updateReformation();
  }

  public getCPRMode(): CPRMode {
    return this.cprMode;
  }

  /**
   * Rotates the reformation around the centerline.
   *
   * @param degrees - Rotation angle in degrees
   */
  public setCPRRotation(degrees: number): void {
    this.cprRotation = ((degrees % 360) + 360) % 360;
    this.updateReformation();
  }

  public getCPRRotation(): number {
    return this.cprRotation;
  }

  /**
   * Sets how far the volume is sampled on each side of the centerline. The
   * default covers the whole volume.
   *
   * @param width - Total sampled width in world units
   */
  public setCPRWidth(width: number): void {
    this.cprWidth = width;
    this.mapper.setWidth(width);
    this.updateReformation();
  }

  public getCPRWidth(): number {
    return this.mapper.getWidth();
  }

  /**
   * Renders a slab around the reformation surface, combined with the blend
   * mode, instead of the surface alone.
   *
   * @param slabThickness - Slab thickness in world units
   */
  public setSlabThickness(slabThickness: number): void {
    const enabled = slabThickness > RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS;
    const spacing = this.mapper.getInputData(0)?.getSpacing() || [1, 1, 1];
    // Sample once per voxel across the slab, keeping the surface itself
    // sampled with an odd count
    const samples = enabled
      ? Math.min(
          2 * Math.ceil(slabThickness / (2 * Math.min(...spacing))) + 1,
          MAXIMUM_SLAB_SAMPLES
        )
      : 1;

    this.mapper.setProjectionSlabThickness(
      Math.max(slabThickness, RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS)
    );
    this.mapper.setProjectionSlabNumberOfSamples(samples);
    this.viewportProperties.slabThickness = slabThickness;
    this.render();
  }

  public getSlabThickness(): number {
    return this.mapper.isProjectionEnabled()
      ? this.mapper.getProjectionSlabThickness()
      : RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS;
  }

  public resetSlabThickness(): void {
    this.setSlabThickness(RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS);
  }

  /**
   * Sets how the slab samples are combined when a slab thickness is set.
   */
  public setBlendMode(blendMode: BlendModes): void {
    const projectionMode = projectionModes.get(blendMode);

    if (projectionMode === undefined) {
      return;
    }

    this.mapper.setProjectionMode(projectionMode);
    this.render();
  }

  public getBlendMode(): BlendModes {
    const projectionMode = this.mapper.getProjectionMode();

    for (const [blendMode, mode] of projectionModes) {
      if (mode === projectionMode) {
        return blendMode;
      }
    }

    return BlendModes.MAXIMUM_INTENSITY_BLEND;
  }

  public resetProperties(volumeId?: string): void {
    this.cprMode = 'straightened';
    this.cprRotation = 0;
    this.cprWidth = undefined;
    this.viewportProperties = {};
    this.resetSlabThickness();
    this.mapper.setProjectionMode(ProjectionMode.MAX);

    const imageData = this.mapper.getInputData(0);
    const volume = cache.getVolume(volumeId || this.getVolumeId());

    if (imageData) {
      const [x, y, z] = imageData.getDimensions();
      const [dx, dy, dz] = imageData.getSpacing();
      this.mapper.setWidth(Math.hypot(x * dx, y * dy, z * dz));
    }

    if (volume) {
      setDefaultVolumeVOI(this.actor, volume).then(() => this.render());
    }

    this.updateReformation();
  }

  public resetCamera(options?: {
    resetPan?: boolean;
    resetZoom?: boolean;
    resetToCenter?: boolean;
    storeAsInitialCamera?: boolean;
  }): boolean {
    if (!this.centerline) {
      return super.resetCamera(options);
    }

    const {
      resetPan = true,
      resetZoom = true,
      storeAsInitialCamera = true,
    } = options || {};
    const previousCamera = this.getCamera();
    const width = this.mapper.getWidth();
    const height = this.mapper.getHeight();
    const { bitangent, normal } = this.getWorldDirections();
    const center = vec3.transformMat4(
      vec3.create(),
      [width / 2, height / 2, 0],
      this.actorMatrix
    );
    const canvasRatio = this.sWidth / this.sHeight;
    const parallelScale =
      width / height > canvasRatio ? width / canvasRatio / 2 : height / 2;
    const focalPoint = resetPan
      ? ([center[0], center[1], center[2]] as Point3)
      : previousCamera.focalPoint;
    const position = vec3.scaleAndAdd(
      vec3.create(),
      focalPoint,
      bitangent,
      -(width + height)
    );

    this.setCamera({
      parallelScale: resetZoom ? parallelScale : previousCamera.parallelScale,
      focalPoint,
      position: [position[0], position[1], position[2]],
      viewUp: [normal[0], normal[1], normal[2]],
      viewAngle: 90,
    });

    const camera = this.getCamera();
    this.setFitToCanvasCamera(camera);

    if (storeAsInitialCamera) {
      this.setInitialCamera(camera);
    }

    if (resetZoom) {
      this.setZoom(1, storeAsInitialCamera);
    }

    this.triggerCameraModifiedEventIfNecessary(previousCamera, camera);

    return true;
  }

  /**
   * Any annotation in the frame of reference can fall on the reformation,
   * so only the frame of reference and volume are checked here. Points that
   * are not on the sampled surface map off canvas.
   */
  public isReferenceViewable(viewRef: ViewReference): boolean {
    const FrameOfReferenceUID = this.getFrameOfReferenceUID();

    if (
      !FrameOfReferenceUID ||
      viewRef.FrameOfReferenceUID !== FrameOfReferenceUID
    ) {
      return false;
    }

    return !viewRef.volumeId || this.hasVolumeId(viewRef.volumeId);
  }

  public getCurrentImageId(): string | undefined {
    return undefined;
  }

  public getCurrentImageIdIndex(): number {
    return 0;
  }

  public getSliceIndex(): number {
    return 0;
  }

  public getNumberOfSlices = (): number => 1;

  public getRotation = (): number => 0;

  public isInAcquisitionPlane(): boolean {
    return false;
  }

  /**
   * Zooms about the given canvas point when one is provided, keeping the
   * image under it in place.
   */
  public setZoom(value: number, canvasPoint?: Point2 | boolean): void {
    if (!Array.isArray(canvasPoint)) {
      super.setZoom(value, canvasPoint);
      return;
    }

    const before = this.projectCanvasToWorld(canvasPoint);
    super.setZoom(value);
    const after = this.projectCanvasToWorld(canvasPoint);
    const { focalPoint, position } = this.getCamera();

    this.setCamera({
      focalPoint: vec3.add(vec3.create(), focalPoint, [
        before[0] - after[0],
        before[1] - after[1],
        before[2] - after[2],
      ]) as Point3,
      position: vec3.add(vec3.create(), position, [
        before[0] - after[0],
        before[1] - after[1],
        before[2] - after[2],
      ]) as Point3,
    });
  }

  public dispose(): void {
    this.removeVolumeListener?.();
    super.dispose();
  }

  protected cameraCanvasToWorld(canvasPos: Point2): Point3 {
    return this.projectCanvasToWorld(canvasPos);
  }

  protected cameraWorldToCanvas(worldPos: Point3): Point2 {
    return this.projectWorldToCanvas(worldPos);
  }

  protected setRotation = (): void => {
    // The reformation is rotated around the centerline with setCPRRotation
  };

  protected isVolumeActorEntry(actorEntry: ActorEntry): boolean {
    return (
      actorEntry.actor === this.actor || super.isVolumeActorEntry(actorEntry)
    );
  }

  protected setCameraClippingRange(): void {
    this.getVtkActiveCamera().setClippingRange(
      -RENDERING_DEFAULTS.MAXIMUM_RAY_DISTANCE,
      RENDERING_DEFAULTS.MAXIMUM_RAY_DISTANCE
    );
  }

  /**
   * World points farther than this from the reformation surface are treated
   * as not shown: one voxel, plus half the slab when one is rendered.
   */
  private getSurfaceTolerance(): number {
    const spacing = this.mapper.getInputData(0)?.getSpacing() || [1, 1, 1];
    const halfSlab = this.mapper.isProjectionEnabled()
      ? this.mapper.getProjectionSlabThickness() / 2
      : 0;

    return Math.min(...spacing) + halfSlab;
  }

  private updateActorVisibility(): void {
    this.actor.setVisibility(
      !!this.centerline && !!this.mapper.getInputData(0)
    );
  }

  private updateReformation(): void {
    if (!this.centerline) {
      return;
    }

    this.applyMode();
    this.updateGeometry();
    this.updateCamera(true);
    this.render();
  }

  private updateReferenceFrame(): void {
    const { points, orientations } = this.centerline;
    let length = 0;
    let index = 0;

    while (index < points.length - 1 && length < this.centerlineLength / 2) {
      length += vec3.distance(points[index], points[index + 1]);
      index++;
    }

    const frame = mat3.fromMat4(
      mat3.create(),
      orientations.subarray(index * 16, index * 16 + 16) as unknown as mat4
    );
    quat.normalize(
      this.referenceFrame,
      quat.fromMat3(this.referenceFrame, frame)
    );
  }

  private applyMode(): void {
    if (this.cprMode === 'stretched') {
      this.mapper.useStretchedMode();
      // Sample every row along the rotated lateral axis of the reference frame
      this.mapper.setUniformOrientation(this.referenceFrame);
    } else {
      this.mapper.useStraightenedMode();
    }
  }

  /**
   * Directions of the reformation in world space: `tangent` is the lateral
   * sampling direction, `bitangent` the viewing direction and `normal` runs
   * along the centerline, all rotated by the CPR rotation.
   */
  private getWorldDirections(): {
    tangent: vec3;
    bitangent: vec3;
    normal: vec3;
  } {
    const angle = (this.cprRotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotate = (direction: vec3) =>
      vec3.transformQuat(vec3.create(), direction, this.referenceFrame);

    return {
      tangent: rotate([cos, sin, 0]),
      bitangent: rotate([-sin, cos, 0]),
      normal: rotate([0, 0, 1]),
    };
  }

  /**
   * Applies the rotation to the mapper and places the reformation in world
   * space, centred on the middle of the centerline, the way the vtk.js
   * ImageCPRMapper example does.
   */
  private updateGeometry(): void {
    const angle = (this.cprRotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const width = this.mapper.getWidth();
    const height = this.mapper.getHeight();
    const { tangent, bitangent, normal } = this.getWorldDirections();

    this.mapper.setDirectionMatrix(
      mat3.fromValues(cos, sin, 0, -sin, cos, 0, 0, 0, 1)
    );

    const center =
      this.mapper.getCenterlinePositionAndOrientation(height / 2).position ||
      vec3.create();
    const translation = vec3.scaleAndAdd(
      vec3.create(),
      center,
      tangent,
      -width / 2
    );
    vec3.scaleAndAdd(translation, translation, normal, -height / 2);

    // Image x runs along the lateral axis, image y from the end of the
    // centerline back to its start
    mat4.set(
      this.actorMatrix,
      tangent[0],
      tangent[1],
      tangent[2],
      0,
      normal[0],
      normal[1],
      normal[2],
      0,
      -bitangent[0],
      -bitangent[1],
      -bitangent[2],
      0,
      translation[0],
      translation[1],
      translation[2],
      1
    );
    mat4.invert(this.inverseActorMatrix, this.actorMatrix);
    this.actor.setUserMatrix(this.actorMatrix);
  }

  private updateCamera(preserveView: boolean): void {
    if (!preserveView || !this.initialCamera) {
      this.resetCamera();
      return;
    }

    const pan = this.getPan();
    const zoom = this.getZoom();

    this.resetCamera();
    this.setZoom(zoom);
    this.setPan(pan);
  }
}

export default CPRViewport;
