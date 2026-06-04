import { AffineParallaxPoseEstimator } from './anchor.affinePose.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const transformPoint = (point, affine) => ({
  x: affine.a * point.x + affine.b * point.y + affine.tx,
  y: affine.c * point.x + affine.d * point.y + affine.ty
});

const measureReferenceSpread = correspondences => {
  const xs = correspondences.map(correspondence => correspondence.prev.x);
  const ys = correspondences.map(correspondence => correspondence.prev.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  return {
    width,
    height,
    minAxis: Math.min(width, height),
  };
};

export class ObjectPoseEstimator {
  constructor(config = {}) {
    this.affinePoseEstimator = config.affinePoseEstimator || new AffineParallaxPoseEstimator();
    this.maxResidual = config.maxResidual || 5;
    this.minInlierRatio = config.minInlierRatio || 0.62;
  }

  estimate({ correspondences, anchorReference, previousPose = null }) {
    const affinePose = this.affinePoseEstimator.estimatePose(correspondences, {
      previousNormal: previousPose?.normal,
      maxResidual: this.maxResidual,
      minInlierRatio: this.minInlierRatio,
    });

    if (!affinePose.success) {
      return {
        success: false,
        reason: affinePose.reason,
        method: 'object-pose-affine'
      };
    }

    const scale = affinePose.scale;
    const position2d = transformPoint(anchorReference, affinePose.affine);
    const referenceSpread = measureReferenceSpread(correspondences);
    const residualScore = clamp(1 - affinePose.averageResidual / (this.maxResidual * 1.5), 0, 1);
    const confidence = clamp(
      affinePose.confidence * 0.58 + affinePose.inlierRatio * 0.27 + residualScore * 0.15,
      0,
      1
    );

    return {
      success: true,
      method: 'object-pose-affine',
      position: { x: position2d.x, y: position2d.y, z: 0 },
      normal: affinePose.normal,
      planarTransform: {
        scale,
        rotation: affinePose.rotation,
        confidence,
        inlierCount: affinePose.inlierCount,
        method: 'object-pose-affine',
      },
      affine: affinePose.affine,
      confidence,
      inlierCount: affinePose.inlierCount,
      inlierRatio: affinePose.inlierRatio,
      averageResidual: affinePose.averageResidual,
      foreshortening: affinePose.foreshortening,
      referenceSpread,
    };
  }
}
