import type { Types } from '@cornerstonejs/core';
import {
  Enums as CoreEnums,
  eventTarget,
  getEnabledElement,
  getRenderingEngine,
  utilities as csUtils,
} from '@cornerstonejs/core';
import { vec3 } from 'gl-matrix';
import { ChangeTypes, Events } from '../../enums';
import {
  drawHandles as drawHandlesSvg,
  drawPolyline as drawPolylineSvg,
} from '../../drawingSvg';
import {
  hideElementCursor,
  resetElementCursor,
} from '../../cursors/elementCursor';
import { removeAnnotation } from '../../stateManagement/annotation/annotationState';
import { isAnnotationVisible } from '../../stateManagement/annotation/annotationVisibility';
import {
  triggerAnnotationCompleted,
  triggerAnnotationModified,
} from '../../stateManagement/annotation/helpers/state';
import { state } from '../../store/state';
import { getToolGroup } from '../../store/ToolGroupManager';
import type {
  AnnotationRenderContext,
  Annotations,
  ContourAnnotation,
  EventTypes,
  PublicToolProps,
  ToolHandle,
  ToolProps,
} from '../../types';
import { resampleCenterline } from '../../utilities/centerline';
import getViewportICamera from '../../utilities/getViewportICamera';
import * as lineSegment from '../../utilities/math/line';
import triggerAnnotationRenderForViewportIds from '../../utilities/triggerAnnotationRenderForViewportIds';
import { getViewportIdsWithToolToRender } from '../../utilities/viewportFilters';
import ContourBaseTool from '../base/ContourBaseTool';

const { ViewportType } = CoreEnums;

/**
 * Draws a centerline through a volume as a series of control points clicked
 * on a volume viewport, scrolling between clicks to follow the structure, and
 * reformats the CPR viewports of its tool group along it.
 *
 * Click to add control points and double click (or press Enter) to finish;
 * Backspace removes the last point and Escape cancels. Control points on the
 * current slice can be dragged afterwards, and the CPR viewports follow.
 *
 * The centerline is rendered on every viewport of the frame of reference:
 * the part on the current slice with the annotation style, the rest dashed.
 */
class CenterlineTool extends ContourBaseTool {
  static toolName = 'Centerline';

  editData: {
    annotation: ContourAnnotation;
    viewportIdsToRender: string[];
    element: HTMLDivElement;
    handleIndex?: number;
    newAnnotation?: boolean;
    lastCanvasPoint?: Types.Point2;
  } | null = null;
  isDrawing = false;
  private removeAnnotationListener: (() => void) | undefined;

  constructor(
    toolProps: PublicToolProps = {},
    defaultToolProps: ToolProps = {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: {
        /** Distance between the points of the resampled centerline, in world units */
        spacing: 1,
      },
    }
  ) {
    super(toolProps, defaultToolProps);
  }

  onSetToolEnabled(): void {
    this.initializeListeners();
  }

  onSetToolActive(): void {
    this.initializeListeners();
  }

  onSetToolDisabled(): void {
    this.removeAnnotationListener?.();
  }

  /**
   * Starts a centerline at the clicked point; later clicks add control points
   * until the drawing is finished.
   */
  addNewAnnotation(evt: EventTypes.InteractionEventType): ContourAnnotation {
    const { currentPoints, element } = evt.detail;
    const annotation = this.createAnnotation(evt) as ContourAnnotation;

    annotation.data.handles.points = [[...currentPoints.world] as Types.Point3];
    this.addAnnotation(annotation, element);

    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName(),
      false
    );

    this.editData = {
      annotation,
      viewportIdsToRender,
      element,
      newAnnotation: true,
    };
    this.isDrawing = true;
    this.createMemo(element, annotation, { newAnnotation: true });
    this.activateDraw(element);

    evt.preventDefault();
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);

    return annotation;
  }

  cancel(element: HTMLDivElement): void {
    if (!this.editData) {
      return;
    }

    const { annotation, viewportIdsToRender, newAnnotation } = this.editData;

    this.deactivateDraw(element);
    this._deactivateModify(element);
    resetElementCursor(element);

    if (newAnnotation) {
      removeAnnotation(annotation.annotationUID);
    } else {
      annotation.data.handles.activeHandleIndex = null;
    }

    this.editData = null;
    this.isDrawing = false;
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  }

  handleSelectedCallback(
    evt: EventTypes.InteractionEventType,
    annotation: ContourAnnotation,
    handle: ToolHandle
  ): void {
    const { element } = evt.detail;
    const handleIndex = annotation.data.handles.points.indexOf(
      handle as Types.Point3
    );

    if (handleIndex < 0) {
      return;
    }

    annotation.highlighted = true;
    annotation.data.handles.activeHandleIndex = handleIndex;

    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName(),
      false
    );

    this.editData = { annotation, viewportIdsToRender, element, handleIndex };
    this.createMemo(element, annotation);
    this._activateModify(element);
    hideElementCursor(element);

    evt.preventDefault();
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  }

  toolSelectedCallback(
    evt: EventTypes.InteractionEventType,
    annotation: ContourAnnotation
  ): void {
    annotation.highlighted = true;
    triggerAnnotationRenderForViewportIds(
      getViewportIdsWithToolToRender(
        evt.detail.element,
        this.getToolName(),
        false
      )
    );
  }

  isPointNearTool = (
    element: HTMLDivElement,
    annotation: ContourAnnotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): boolean => {
    const { viewport } = getEnabledElement(element);
    const canvasPoints = this.getPolylinePoints(annotation).map((point) =>
      viewport.worldToCanvas(point)
    );

    return canvasPoints.some(
      (point, index) =>
        index > 0 &&
        lineSegment.distanceToPoint(
          canvasPoints[index - 1],
          point,
          canvasCoords
        ) <= proximity
    );
  };

  /**
   * Only control points on the current slice can be grabbed.
   */
  getHandleNearImagePoint(
    element: HTMLDivElement,
    annotation: ContourAnnotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): ToolHandle | undefined {
    const { viewport } = getEnabledElement(element);
    const isOnSlice = this.getSliceTest(viewport);

    return annotation.data.handles.points.find((point) => {
      const canvasPoint = viewport.worldToCanvas(point);

      return (
        isOnSlice(point) &&
        vec3.distance([...canvasPoint, 0], [...canvasCoords, 0]) <= proximity
      );
    });
  }

  /**
   * A centerline runs through the volume, so it is shown on every viewport of
   * its frame of reference except the CPR viewports it reformats.
   */
  filterInteractableAnnotationsForElement(
    element: HTMLDivElement,
    annotations: Annotations
  ): Annotations {
    const { viewport } = getEnabledElement(element);

    if (viewport.type === ViewportType.CPR) {
      return [];
    }

    const FrameOfReferenceUID = viewport.getFrameOfReferenceUID();

    return annotations.filter(
      (annotation) =>
        annotation.metadata.FrameOfReferenceUID === FrameOfReferenceUID &&
        isAnnotationVisible(annotation.annotationUID)
    );
  }

  protected renderAnnotationInstance(
    renderContext: AnnotationRenderContext
  ): boolean {
    const { enabledElement, annotationStyle, svgDrawingHelper } = renderContext;
    const { viewport } = enabledElement;
    const annotation = renderContext.annotation as ContourAnnotation;
    const { annotationUID, data } = annotation;
    const { points } = data.handles;
    const color = annotationStyle.color as string;
    const lineWidth = annotationStyle.lineWidth as number;
    const lineDash = annotationStyle.lineDash as string;
    const isOnSlice = this.getSliceTest(viewport);
    const polyline = this.getPolylinePoints(annotation);
    const path = polyline.length >= 2 ? polyline : points;
    const canvasPath = path.map((point) => viewport.worldToCanvas(point));

    // The whole path dashed, then the parts on the current slice on top
    drawPolylineSvg(svgDrawingHelper, annotationUID, 'path', canvasPath, {
      color,
      lineWidth: 1,
      lineDash: '2,3',
    });

    let run: Types.Point2[] = [];
    let runIndex = 0;
    const flush = () => {
      if (run.length >= 2) {
        drawPolylineSvg(
          svgDrawingHelper,
          annotationUID,
          `slice-${runIndex++}`,
          run,
          { color, lineWidth, lineDash }
        );
      }
      run = [];
    };

    path.forEach((point, index) => {
      if (isOnSlice(point)) {
        run.push(canvasPath[index]);
      } else {
        flush();
      }
    });
    flush();

    const handles = points
      .filter((point) => isOnSlice(point))
      .map((point) => viewport.worldToCanvas(point));

    if (handles.length) {
      drawHandlesSvg(svgDrawingHelper, annotationUID, 'handles', handles, {
        color,
        handleRadius: '3',
      });
    }

    const { editData } = this;

    if (
      editData?.newAnnotation &&
      editData.annotation === annotation &&
      editData.element === viewport.element &&
      editData.lastCanvasPoint
    ) {
      drawPolylineSvg(
        svgDrawingHelper,
        annotationUID,
        'preview',
        [
          viewport.worldToCanvas(points[points.length - 1]),
          editData.lastCanvasPoint,
        ],
        { color, lineWidth: 1, lineDash: '4,4' }
      );
    }

    return true;
  }

  protected _dragCallback = (evt: EventTypes.InteractionEventType): void => {
    if (!this.editData || this.editData.handleIndex === undefined) {
      return;
    }

    const { annotation, viewportIdsToRender, handleIndex } = this.editData;
    const point = annotation.data.handles.points[handleIndex];
    const delta = evt.detail.deltaPoints.world;

    point[0] += delta[0];
    point[1] += delta[1];
    point[2] += delta[2];

    this.updateCenterline(annotation);
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  };

  protected _endCallback = (evt: EventTypes.InteractionEventType): void => {
    if (!this.editData) {
      return;
    }

    const { annotation, viewportIdsToRender, element } = this.editData;

    annotation.data.handles.activeHandleIndex = null;
    this._deactivateModify(element);
    resetElementCursor(element);
    this.doneEditMemo();
    this.editData = null;

    triggerAnnotationModified(annotation, element, ChangeTypes.HandlesUpdated);
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    evt.preventDefault();
  };

  private activateDraw(element: HTMLDivElement): void {
    state.isInteractingWithTool = true;

    element.addEventListener(
      Events.MOUSE_DOWN,
      this.drawClickCallback as EventListener
    );
    element.addEventListener(
      Events.MOUSE_DOUBLE_CLICK,
      this.drawClickCallback as EventListener
    );
    element.addEventListener(
      Events.TOUCH_TAP,
      this.drawClickCallback as EventListener
    );
    element.addEventListener(
      Events.MOUSE_MOVE,
      this.drawMoveCallback as EventListener
    );
    element.addEventListener(
      Events.KEY_DOWN,
      this.drawKeyDownCallback as EventListener
    );
  }

  private deactivateDraw(element: HTMLDivElement): void {
    state.isInteractingWithTool = false;

    element.removeEventListener(
      Events.MOUSE_DOWN,
      this.drawClickCallback as EventListener
    );
    element.removeEventListener(
      Events.MOUSE_DOUBLE_CLICK,
      this.drawClickCallback as EventListener
    );
    element.removeEventListener(
      Events.TOUCH_TAP,
      this.drawClickCallback as EventListener
    );
    element.removeEventListener(
      Events.MOUSE_MOVE,
      this.drawMoveCallback as EventListener
    );
    element.removeEventListener(
      Events.KEY_DOWN,
      this.drawKeyDownCallback as EventListener
    );
  }

  private drawClickCallback = (evt: EventTypes.InteractionEventType): void => {
    if (!this.editData) {
      return;
    }

    const { annotation, viewportIdsToRender } = this.editData;
    const { element, currentPoints } = evt.detail;
    const { points } = annotation.data.handles;
    const doubleClick =
      evt.type === Events.MOUSE_DOUBLE_CLICK ||
      (evt.type === Events.TOUCH_TAP &&
        (evt.detail as unknown as EventTypes.TouchTapEventDetail).taps >= 2);

    if (
      vec3.distance(points[points.length - 1], currentPoints.world) >
      this.configuration.spacing / 2
    ) {
      points.push([...currentPoints.world] as Types.Point3);
      this.updateCenterline(annotation);
    }

    if (doubleClick) {
      this.finishDrawing(element);
    }

    evt.preventDefault();
    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  };

  private drawMoveCallback = (evt: EventTypes.MouseMoveEventType): void => {
    if (!this.editData) {
      return;
    }

    this.editData.lastCanvasPoint = evt.detail.currentPoints.canvas;
    triggerAnnotationRenderForViewportIds([evt.detail.viewportId]);
  };

  private drawKeyDownCallback = (evt: EventTypes.KeyDownEventType): void => {
    if (!this.editData) {
      return;
    }

    const { annotation, viewportIdsToRender } = this.editData;
    const { key, element } = evt.detail;

    if (key === 'Escape') {
      this.cancel(element);
    } else if (key === 'Enter') {
      this.finishDrawing(element);
    } else if (key === 'Backspace' || key === 'Delete') {
      annotation.data.handles.points.pop();

      if (!annotation.data.handles.points.length) {
        this.cancel(element);
        return;
      }

      this.updateCenterline(annotation);
      triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    }
  };

  private finishDrawing(element: HTMLDivElement): void {
    const { annotation, viewportIdsToRender } = this.editData;

    this.deactivateDraw(element);
    this.editData = null;
    this.isDrawing = false;

    if (annotation.data.handles.points.length < 2) {
      removeAnnotation(annotation.annotationUID);
    } else {
      this.doneEditMemo();
      triggerAnnotationCompleted(annotation);
    }

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  }

  /**
   * Resamples the centerline through the control points and reformats the
   * CPR viewports of the tool group along it.
   */
  private updateCenterline(annotation: ContourAnnotation): void {
    const { points } = annotation.data.handles;

    annotation.data.contour.polyline =
      points.length >= 2
        ? resampleCenterline(points, this.configuration.spacing)
        : [];
    annotation.invalidated = true;

    this.applyToCPRViewports(
      annotation.data.contour.polyline,
      annotation.metadata.FrameOfReferenceUID
    );
  }

  private applyToCPRViewports(
    points: Types.Point3[],
    FrameOfReferenceUID: string
  ): void {
    getToolGroup(this.toolGroupId)
      ?.getViewportsInfo()
      .forEach(({ viewportId, renderingEngineId }) => {
        const viewport = getRenderingEngine(renderingEngineId)?.getViewport(
          viewportId
        ) as Types.ICPRViewport | undefined;

        if (
          viewport?.type === ViewportType.CPR &&
          viewport.getFrameOfReferenceUID() === FrameOfReferenceUID
        ) {
          viewport.setCenterline(points.length >= 2 ? { points } : undefined);
        }
      });
  }

  /**
   * Tells whether a world point lies on the slice a viewport shows.
   */
  private getSliceTest(
    viewport: Types.IViewport
  ): (point: Types.Point3) => boolean {
    const { focalPoint, viewPlaneNormal } = getViewportICamera(viewport);
    const imageData = viewport.getImageData?.();
    const halfSpacing = imageData
      ? csUtils.getSpacingInNormalDirection(imageData, viewPlaneNormal) / 2
      : 0.5;

    return (point) =>
      Math.abs(
        vec3.dot(
          vec3.subtract(vec3.create(), point, focalPoint),
          viewPlaneNormal
        )
      ) <=
      halfSpacing + 1e-3;
  }

  private initializeListeners(): void {
    if (this.removeAnnotationListener) {
      return;
    }

    const isCenterline = (annotation: ContourAnnotation) =>
      annotation?.metadata?.toolName === this.getToolName();
    const onAnnotationRemoved = (
      evt: EventTypes.AnnotationRemovedEventType
    ) => {
      const annotation = evt.detail.annotation as ContourAnnotation;

      if (isCenterline(annotation)) {
        this.applyToCPRViewports([], annotation.metadata.FrameOfReferenceUID);
      }
    };
    // Undo and redo restore the control points, so the CPR viewports follow
    const onAnnotationModified = (
      evt: EventTypes.AnnotationModifiedEventType
    ) => {
      const annotation = evt.detail.annotation as ContourAnnotation;

      if (
        evt.detail.changeType === ChangeTypes.History &&
        isCenterline(annotation)
      ) {
        this.updateCenterline(annotation);
      }
    };

    eventTarget.addEventListener(
      Events.ANNOTATION_REMOVED,
      onAnnotationRemoved
    );
    eventTarget.addEventListener(
      Events.ANNOTATION_MODIFIED,
      onAnnotationModified
    );
    this.removeAnnotationListener = () => {
      eventTarget.removeEventListener(
        Events.ANNOTATION_REMOVED,
        onAnnotationRemoved
      );
      eventTarget.removeEventListener(
        Events.ANNOTATION_MODIFIED,
        onAnnotationModified
      );
      this.removeAnnotationListener = undefined;
    };
  }
}

export default CenterlineTool;
