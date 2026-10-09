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
 * The orientation is interpolated within the segment only: with
 * multisampling, a quad that does not cover the pixel centre has its offset
 * extrapolated there, and the orientation of a quad thinner than a pixel was
 * rotated beyond its end frames, which at a sharp corner sampled off the
 * surface.
 *
 * @param {*} publicAPI The public API to extend
 * @param {*} model The private model to extend.
 */
function vtkPatchedOpenGLImageCPRMapper(publicAPI, model) {
  model.classHierarchy.push('vtkPatchedOpenGLImageCPRMapper');

  const superClass = { ...publicAPI };

  publicAPI.replaceShaderValues = (shaders, ren, actor) => {
    superClass.replaceShaderValues(shaders, ren, actor);

    // Keep the orientation within the segment: with multisampling, a quad
    // that does not cover the pixel centre has its offset extrapolated there,
    // and the orientation of a quad thinner than a pixel would be rotated
    // beyond its end frames
    shaders.Fragment = shaders.Fragment.replace(
      'mix(q0, q1, quadOffsetVSOutput.y)',
      'mix(q0, q1, clamp(quadOffsetVSOutput.y, 0.0, 1.0))'
    )
      .replace(
        'float omega = acos(qCosAngle);',
        'float omega = acos(qCosAngle);\n  float qT = clamp(quadOffsetVSOutput.y, 0.0, 1.0);'
      )
      .replace(
        'sin((1.0 - quadOffsetVSOutput.y) * omega) * q0 + sin(quadOffsetVSOutput.y * omega) * q1',
        'sin((1.0 - qT) * omega) * q0 + sin(qT * omega) * q1'
      );

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
