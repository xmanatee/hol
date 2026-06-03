import { useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { useLipSync } from '../../hooks/useLipSync.js'
import { useRandomMorphing } from '../../utils/randomMorphing.js'
import { computeHeadLocalRotation } from '../../utils/headPose.js'
import { logger } from '../../utils/logger.js'

const HeadAnchor = ({ 
  visible = true,
  isAgentSpeaking = false,
  hiddenMeshes = new Set(),
  manualRotation = { x: 0, y: 0, z: 0 },
  onMeshNamesDiscovered = () => {},
  onLipSyncUpdate = () => {},
  microphoneMode = false,
  agentAudioAnalysis = null,
  agentAudioAlignment = null
}) => {
  const [gltfScene, setGltfScene] = useState(null)
  const [headMesh, setHeadMesh] = useState(null)
  const [isLoaded, setIsLoaded] = useState(false)

  const {
    initialize,
    setAgentSpeaking,
    setAgentAudioAnalysis,
    setAgentAudioAlignment,
    setMicrophoneMode,
    getMicrophoneAnalysis,
    isVoiceActive,
    isActive,
    currentViseme
  } = useLipSync()
  
  useRandomMorphing(headMesh, !isAgentSpeaking && !microphoneMode, {
    blinkInterval: 4000,      // Time between blinks
    blinkVariation: 2500      // Random variation in blink timing
  })

  // Initialize lip-sync with microphone mode when mesh is loaded
  useEffect(() => {
    if (headMesh) {
      initialize(headMesh);
    }
  }, [headMesh, initialize]);

  // Update lip-sync when agent speaking status changes
  useEffect(() => {
    setAgentSpeaking(isAgentSpeaking)
  }, [isAgentSpeaking, setAgentSpeaking])

  useEffect(() => {
    if (agentAudioAnalysis) {
      setAgentAudioAnalysis(agentAudioAnalysis)
    }
  }, [agentAudioAnalysis, setAgentAudioAnalysis])

  useEffect(() => {
    if (agentAudioAlignment) {
      setAgentAudioAlignment(agentAudioAlignment)
    }
  }, [agentAudioAlignment, setAgentAudioAlignment])

  // Update microphone mode in lip-sync system
  useEffect(() => {
    setMicrophoneMode(microphoneMode);
  }, [microphoneMode, setMicrophoneMode]);

  // Local pose and lip-sync update - runs every frame
  useFrame(() => {
    if (!gltfScene || !isLoaded || !visible) return

    const localRotation = computeHeadLocalRotation(manualRotation)
    gltfScene.rotation.set(localRotation.x, localRotation.y, localRotation.z)
    
    // Update parent with lip-sync data from microphone mode
    if (microphoneMode) {
      const audioData = getMicrophoneAnalysis();
      
      onLipSyncUpdate({
        currentViseme,
        audioEnergy: audioData.energy,
        isVoiceActive: isVoiceActive(),
        microphoneActive: isActive
      });
    }
  })

  // Load GLTF model
  useEffect(() => {
    if (isLoaded) return

    const loader = new GLTFLoader()

    loader.load('/3d/untitled.gltf', (gltf) => {
      // Calculate bounding box and center the model
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      
      // Center the model at origin
      gltf.scene.position.sub(center)
      
      // Scale model to a reasonable size (normalize to ~1 unit)
      const maxDimension = Math.max(size.x, size.y, size.z)
      const targetSize = 1.0 // Target size in world units
      const scaleFactor = targetSize / maxDimension
      gltf.scene.scale.setScalar(scaleFactor)
      
      gltf.scene.updateMatrixWorld(true)
      
      const meshNames = []
      // Find head mesh with morph targets
      gltf.scene.traverse((child) => {
        if (child.type === 'Mesh' || child.type === 'SkinnedMesh') {
          meshNames.push(child.name)
          
          if (child.morphTargetDictionary && child.morphTargetInfluences) {
            setHeadMesh(child)
          }
        }
      })
      
      // Notify parent of discovered mesh names
      onMeshNamesDiscovered(meshNames)

      setGltfScene(gltf.scene)
      setIsLoaded(true)
    }, undefined, (error) => {
      logger.error('HeadAnchor', 'GLTF loading error:', error)
    })
  }, [isLoaded, onMeshNamesDiscovered])

  // Apply mesh visibility when hiddenMeshes changes
  useEffect(() => {
    if (!isLoaded || !gltfScene) return
    
    gltfScene.traverse((child) => {
      if (child.type === 'Mesh' || child.type === 'SkinnedMesh') {
        const shouldHide = hiddenMeshes.has(child.name)
        child.visible = !shouldHide
      }
    })
  }, [hiddenMeshes, isLoaded, gltfScene])

  if (!isLoaded || !visible) {
    return null
  }

  return <primitive object={gltfScene} />
}

export default HeadAnchor
