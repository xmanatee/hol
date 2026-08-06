import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as THREE from 'three';
import { useLipSync } from '../../hooks/useLipSync.js';
import { createHeadModelInstance } from '../../utils/headModel.js';
import { computeHeadLocalRotation, writeEyeGazeRotation } from '../../utils/headPose.js';
import { HEAD_ASSET_URL } from '../../runtime/capabilityPacks.js';

const HEAD_MODEL_URL = HEAD_ASSET_URL;
const MAX_EYE_YAW = 0.32;
const MAX_EYE_PITCH = 0.22;
const configureHeadLoader = (loader) => loader.setMeshoptDecoder(MeshoptDecoder);

const HeadAnchor = ({
  visible = true,
  isAgentSpeaking = false,
  hiddenMeshes = new Set(),
  manualRotation = { x: 0, y: 0, z: 0 },
  onMeshNamesDiscovered,
  onMicrophoneTelemetry,
  onSpeechTelemetry,
  microphoneService,
  ttsService,
  facialExpression = 'neutral',
  animationIntensity = 0.65,
}) => {
  const gltf = useLoader(GLTFLoader, HEAD_MODEL_URL, configureHeadLoader);
  const model = useMemo(() => createHeadModelInstance(gltf.scene), [gltf.scene]);
  const { scene, headMesh, eyeControls, meshNames } = model;
  const { camera } = useThree();
  const invalidate = useThree((state) => state.invalidate);
  const gazeEulerRef = useRef(new THREE.Euler());
  const gazeQuaternionRef = useRef(new THREE.Quaternion());
  const cameraWorldPositionRef = useRef(new THREE.Vector3());
  const cameraLocalPositionRef = useRef(new THREE.Vector3());

  const { initialize, setAgentSpeaking, setExpression, setPerformanceIntensity } = useLipSync(
    microphoneService,
    ttsService,
    onMicrophoneTelemetry,
    onSpeechTelemetry,
  );

  useEffect(() => {
    initialize(headMesh);
    invalidate();
  }, [headMesh, initialize, invalidate]);

  useEffect(() => {
    onMeshNamesDiscovered(meshNames);
  }, [meshNames, onMeshNamesDiscovered]);

  useEffect(() => {
    setPerformanceIntensity(animationIntensity);
    setExpression(facialExpression);
    invalidate();
  }, [animationIntensity, facialExpression, headMesh, invalidate, setExpression, setPerformanceIntensity]);

  useEffect(() => {
    const localRotation = computeHeadLocalRotation(manualRotation);
    scene.rotation.set(localRotation.x, localRotation.y, localRotation.z);
    invalidate();
  }, [invalidate, manualRotation, scene]);

  // Update lip-sync when agent speaking status changes
  useEffect(() => {
    setAgentSpeaking(isAgentSpeaking);
    invalidate();
  }, [invalidate, isAgentSpeaking, setAgentSpeaking]);

  // Local pose and lip-sync update - runs every frame
  useFrame(() => {
    if (!visible) {
      return;
    }

    camera.getWorldPosition(cameraWorldPositionRef.current);
    for (let eyeIndex = 0; eyeIndex < eyeControls.length; eyeIndex++) {
      const { object, baseQuaternion } = eyeControls[eyeIndex];
      if (!object.parent) {
        continue;
      }

      cameraLocalPositionRef.current.copy(cameraWorldPositionRef.current);
      object.parent.worldToLocal(cameraLocalPositionRef.current);
      writeEyeGazeRotation(
        object.position,
        cameraLocalPositionRef.current,
        gazeEulerRef.current,
        MAX_EYE_YAW,
        MAX_EYE_PITCH,
      );
      gazeQuaternionRef.current.setFromEuler(gazeEulerRef.current);
      object.quaternion.copy(baseQuaternion).multiply(gazeQuaternionRef.current);
    }
  });

  // Apply mesh visibility when hiddenMeshes changes
  useEffect(() => {
    scene.traverse((object) => {
      if (object.isMesh) {
        object.visible = !hiddenMeshes.has(object.name);
      }
    });
    invalidate();
  }, [hiddenMeshes, invalidate, scene]);

  if (!visible) {
    return null;
  }

  // Geometry, materials, and textures belong to useLoader's shared cache.
  return <primitive object={scene} dispose={null} />;
};

export default HeadAnchor;
