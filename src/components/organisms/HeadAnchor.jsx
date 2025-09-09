import { useRef, useEffect, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { useHeadLipSync } from '../../hooks/useLipSync.js'
import { useRandomMorphing } from '../../utils/randomMorphing.js'

const HeadAnchor = ({ 
  visible = true,
  isAgentSpeaking = false,
  hiddenMeshes = new Set(),
  manualRotation = { x: 0, y: 0, z: 0 },
  onMeshNamesDiscovered = () => {},
  onLipSyncUpdate = () => {},
  microphoneMode = false
}) => {
  const { scene, camera } = useThree()
  const [gltfScene, setGltfScene] = useState(null)
  const [headMesh, setHeadMesh] = useState(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const headGroupRef = useRef()

  // Initialize lip-sync system
  const lipSync = useHeadLipSync(headMesh)
  
  // Initialize random morphing (active when NOT speaking AND not in microphone mode)
  const randomMorphing = useRandomMorphing(headMesh, !isAgentSpeaking && !microphoneMode, {
    intensity: 0.8,           // Maximum morph intensity (increased for all-target use)
    waveSpeed: 0.9,           // Speed of continuous wave motion
    phaseOffset: 1.8,         // Phase offset between morph targets
    blinkInterval: 4000,      // Time between blinks
    blinkVariation: 2500      // Random variation in blink timing
  })

  // Initialize lip-sync with microphone mode when mesh is loaded
  useEffect(() => {
    if (headMesh && lipSync.initialize) {
      lipSync.initialize(headMesh, microphoneMode);
    }
  }, [headMesh, microphoneMode, lipSync.initialize]);

  // Update lip-sync when agent speaking status changes
  useEffect(() => {
    if (lipSync.setAgentSpeaking) {
      lipSync.setAgentSpeaking(isAgentSpeaking)
    }
  }, [isAgentSpeaking, lipSync.setAgentSpeaking])

  // Update microphone mode in lip-sync system
  useEffect(() => {
    if (lipSync.setMicrophoneMode) {
      lipSync.setMicrophoneMode(microphoneMode);
    }
  }, [microphoneMode, lipSync.setMicrophoneMode]);

  // Eye gaze tracking and lip-sync update - runs every frame
  useFrame(() => {
    if (!gltfScene || !isLoaded) return

    // Get camera position in world space
    const cameraPosition = camera.position.clone()
    
    // Calculate look-at direction from head to camera
    const headPosition = gltfScene.position.clone()
    const lookDirection = cameraPosition.clone().sub(headPosition).normalize()
    
    // Convert to local rotation (limit angles to avoid extreme poses)
    const targetY = Math.atan2(lookDirection.x, lookDirection.z)
    const targetX = Math.asin(-lookDirection.y)
    
    // Limit rotation angles to keep natural head movement
    const maxAngle = Math.PI * 0.15 // ±27 degrees
    const clampedY = Math.max(-maxAngle, Math.min(maxAngle, targetY))
    const clampedX = Math.max(-maxAngle, Math.min(maxAngle, targetX))
    
    // Apply manual rotation from parent component
    const finalY = clampedY + manualRotation.y
    const finalX = clampedX + manualRotation.x
    
    // Apply rotation to the head model
    gltfScene.rotation.y = finalY
    gltfScene.rotation.x = finalX
    gltfScene.rotation.z = manualRotation.z
    
    // Add subtle micro-movements during speech
    if (isAgentSpeaking && headMesh) {
      const time = Date.now() * 0.001
      const energyNod = Math.sin(time * 8) * 0.02 // Small nod motion
      gltfScene.rotation.x += energyNod
    }

    // Update parent with lip-sync data from microphone mode
    if (microphoneMode && lipSync.microphoneService) {
      const audioData = lipSync.microphoneService.getAnalysis();
      const voiceActive = lipSync.microphoneService.isVoiceActive();
      
      onLipSyncUpdate({
        currentViseme: lipSync.currentViseme,
        audioEnergy: audioData.energy,
        isVoiceActive: voiceActive,
        microphoneActive: lipSync.isActive
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
      
      scene.add(gltf.scene)
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
      console.error('GLTF loading error:', error)
    })
  }, [scene, isLoaded])

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

  // Cleanup
  useEffect(() => {
    return () => {
      if (gltfScene && scene) {
        scene.remove(gltfScene)
      }
    }
  }, [scene, gltfScene])



  if (!isLoaded || !visible) {
    return null
  }

  return null // Model is added directly to Three.js scene
}

export default HeadAnchor