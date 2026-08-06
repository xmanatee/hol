import { Box3, Group, Vector3 } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const TARGET_SIZE = 1;

export const createHeadModelInstance = (sourceScene) => {
  const content = clone(sourceScene);
  content.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(content);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error('Head model must have non-zero finite bounds');
  }

  const scale = TARGET_SIZE / maxDimension;
  const normalizedContent = new Group();
  normalizedContent.name = 'NormalizedHeadContent';
  normalizedContent.add(content);
  normalizedContent.scale.setScalar(scale);
  normalizedContent.position.copy(center).multiplyScalar(-scale);

  const scene = new Group();
  scene.name = 'HeadModelInstance';
  scene.add(normalizedContent);
  scene.updateMatrixWorld(true);

  const meshNames = [];
  const eyeControls = [];
  const facialMeshes = [];
  content.traverse((object) => {
    if (/^grp_eye/i.test(object.name)) {
      eyeControls.push({
        object,
        baseQuaternion: object.quaternion.clone(),
      });
    }

    if (!object.isMesh) {
      return;
    }

    meshNames.push(object.name);
    if (object.morphTargetDictionary && object.morphTargetInfluences) {
      facialMeshes.push(object);
    }
  });

  if (facialMeshes.length !== 1) {
    throw new Error(
      `Head model must contain exactly one facial morph-target mesh; found ${facialMeshes.length}`,
    );
  }

  return {
    scene,
    headMesh: facialMeshes[0],
    eyeControls,
    meshNames,
  };
};
