import macro from '@kitware/vtk.js/macros';
import vtkOpenGLImageCPRMapper from '@kitware/vtk.js/Rendering/OpenGL/ImageCPRMapper';
import { ProjectionMode } from '@kitware/vtk.js/Rendering/Core/ImageCPRMapper/Constants';

const { vtkWarningMacro } = macro;

/**
 * vtkPatchedOpenGLImageCPRMapper - vtkOpenGLImageCPRMapper with corrections
 * to the generated shaders.
 *
 * Maximum and minimum projections start from the first slab sample: vtk.js
 * starts them from 0 and 1, the bounds of a normalized texture, while signed
 * and float textures hold raw values, so a maximum projection never fell
 * below 0 and a minimum projection never rose above 1.
 *
 * @param {*} publicAPI The public API to extend
 * @param {*} model The private model to extend.
 */
function vtkPatchedOpenGLImageCPRMapper(publicAPI, model) {
  model.classHierarchy.push('vtkPatchedOpenGLImageCPRMapper');

  const superClass = { ...publicAPI };

  publicAPI.replaceShaderValues = (shaders, ren, actor) => {
    superClass.replaceShaderValues(shaders, ren, actor);

    // Interpolate the position and the offset within the quad at the covered
    // samples: with multisampling, a segment quad thinner than a pixel would
    // otherwise have them extrapolated to the pixel centre, beyond the segment
    for (const varying of [
      'vec2 quadOffsetVSOutput',
      'vec3 centerlinePosVSOutput',
    ]) {
      shaders.Vertex = shaders.Vertex.replace(
        `centroid out ${varying};`,
        `centroid out ${varying};`
      );
      shaders.Fragment = shaders.Fragment.replace(
        `centroid in ${varying};`,
        `centroid in ${varying};`
      );
    }

    if (
      !model.renderable.isProjectionEnabled() ||
      model.renderable.getProjectionMode() === ProjectionMode.AVERAGE
    ) {
      return;
    }

    const initial = 'vec4 tvalue = initialProjectionTextureValue;';

    if (!shaders.Fragment.includes(initial)) {
      vtkWarningMacro('Projection start not found in the CPR shader');
      return;
    }

    shaders.Fragment = shaders.Fragment.replace(
      initial,
      'vec4 tvalue = texture(volumeTexture, projectionStartPosition);'
    );
  };
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

const DEFAULT_VALUES = {};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  // Inheritance
  vtkOpenGLImageCPRMapper.extend(publicAPI, model, initialValues);

  // Object methods
  vtkPatchedOpenGLImageCPRMapper(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = macro.newInstance(
  extend,
  'vtkPatchedOpenGLImageCPRMapper'
);

// ----------------------------------------------------------------------------

export default { newInstance, extend };
