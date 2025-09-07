import { useRef, useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { GLTFLoader } from 'three-stdlib'
import * as THREE from 'three'

const HeadAnchor = ({ 
  position_px = [100, 100], 
  normal_camSpace = [0, 0, 1], 
  depthHint = 2.0,
  visible = true 
}) => {
  const groupRef = useRef()
  const meshRef = useRef()
  const eyesRef = useRef({ leftEye: null, rightEye: null })
  const { camera, size } = useThree()
  
  // Cache for loaded model and morph targets
  const modelCache = useMemo(() => ({
    model: null,
    morphTargetDictionary: null,
    morphTargetInfluences: null,
    isLoaded: false
  }), [])

  // Load the face model
  useEffect(() => {
    if (modelCache.isLoaded) return

    const loader = new GLTFLoader()
    
    loader.load('/3d/scene.gltf', (gltf) => {
      console.log('[HeadAnchor] glTF loaded:', gltf)
      console.log('[HeadAnchor] Scene:', gltf.scene)
      console.log('[HeadAnchor] Scene children:', gltf.scene.children)
      
      // Log all objects in the scene
      gltf.scene.traverse((child) => {
        console.log('[HeadAnchor] Child:', child.name, child.type, child)
        if (child.type === 'Mesh' || child.type === 'SkinnedMesh') {
          console.log('[HeadAnchor] Mesh details:', {
            name: child.name,
            type: child.type,
            morphTargetDictionary: child.morphTargetDictionary,
            morphTargetInfluences: child.morphTargetInfluences,
            geometry: child.geometry
          })
        }
      })
      
      // Find the mesh with morph targets (traverse the entire scene)
      let mesh = null
      gltf.scene.traverse((child) => {
        if ((child.type === 'SkinnedMesh' || child.type === 'Mesh') && 
            child.morphTargetDictionary && 
            !mesh) {
          mesh = child
        }
      })
      
      console.log('[HeadAnchor] Selected mesh:', mesh)
      console.log('[HeadAnchor] Morph target dictionary:', mesh.morphTargetDictionary)
      console.log('[HeadAnchor] Main head mesh material:', mesh.material)
      console.log('[HeadAnchor] Main head mesh bounds:', mesh.geometry.boundingBox)
      
      // Store the entire scene but keep reference to the main head mesh for morphs
      const completeModel = gltf.scene.clone()
      
      // Find and enhance materials for all components
      completeModel.traverse((child) => {
        if (child.type === 'Mesh' || child.type === 'SkinnedMesh') {
          console.log('[HeadAnchor] Processing mesh:', child.name, child.type, 'visible:', child.visible, 'geometry:', !!child.geometry)
          
          if (child.name === 'mesh_2') {
            // Main head mesh - keep morph targets and make bright
            child.material = new THREE.MeshStandardMaterial({
              color: 0xffdbac, // Skin tone
              roughness: 0.6,
              metalness: 0.1
            })
          } else if (child.name === 'Object_5' || child.name === 'Object_8') {
            // Eye meshes - create realistic eye appearance
            // Create a canvas texture for the eye with pupil/iris
            const canvas = document.createElement('canvas')
            canvas.width = 256
            canvas.height = 256
            const ctx = canvas.getContext('2d')
            
            // White sclera background
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, 256, 256)
            
            // Brown iris
            const centerX = 128
            const centerY = 128
            const irisRadius = 80
            const pupilRadius = 35
            
            // Iris gradient
            const irisGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, irisRadius)
            irisGradient.addColorStop(0, '#8B4513') // Brown center
            irisGradient.addColorStop(0.7, '#654321') // Darker brown
            irisGradient.addColorStop(1, '#2F1B14') // Dark outer ring
            
            ctx.fillStyle = irisGradient
            ctx.beginPath()
            ctx.arc(centerX, centerY, irisRadius, 0, Math.PI * 2)
            ctx.fill()
            
            // Black pupil
            ctx.fillStyle = '#000000'
            ctx.beginPath()
            ctx.arc(centerX, centerY, pupilRadius, 0, Math.PI * 2)
            ctx.fill()
            
            // Highlight for realism
            ctx.fillStyle = '#ffffff'
            ctx.globalAlpha = 0.6
            ctx.beginPath()
            ctx.arc(centerX - 15, centerY - 15, 12, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 1.0
            
            // Create texture from canvas
            const eyeTexture = new THREE.CanvasTexture(canvas)
            eyeTexture.wrapS = THREE.ClampToEdgeWrapping
            eyeTexture.wrapT = THREE.ClampToEdgeWrapping
            
            child.material = new THREE.MeshStandardMaterial({
              map: eyeTexture,
              roughness: 0.1,
              metalness: 0.0,
              transparent: false,
              emissive: 0x444444, // Stronger glow to ensure visibility
              emissiveIntensity: 0.3
            })
            
            // Ensure eye is visible and properly scaled
            child.visible = true
            child.renderOrder = 1 // Render after head mesh
            child.material.depthTest = false // Render on top
            
            // Manually position eyes in correct face locations
            // These positions assume the head is rotated and scaled properly
            if (child.name === 'Object_5') { // Left eye
              // Position left eye relative to head center
              child.position.set(-0.05, 0.03, 0.08) // left, up, forward
            } else if (child.name === 'Object_8') { // Right eye  
              // Position right eye relative to head center
              child.position.set(0.05, 0.03, 0.08) // right, up, forward
            }
            
            // Store eye references for gaze tracking
            if (child.name === 'Object_5') {
              eyesRef.current.leftEye = child
            } else if (child.name === 'Object_8') {
              eyesRef.current.rightEye = child
            }
            
            console.log('[HeadAnchor] Applied detailed eye material to:', child.name)
          } else if (child.name === 'Object_13') {
            // Teeth mesh
            child.material = new THREE.MeshStandardMaterial({
              color: 0xffffff, // White teeth
              roughness: 0.3,
              metalness: 0.0
            })
            console.log('[HeadAnchor] Applied teeth material to:', child.name)
          }
        }
      })
      
      // Store the complete model and the main mesh reference for morphs
      modelCache.model = completeModel
      modelCache.headMesh = mesh // Keep reference to the mesh with morphs
      modelCache.morphTargetDictionary = mesh.morphTargetDictionary
      modelCache.morphTargetInfluences = mesh.morphTargetInfluences
      modelCache.isLoaded = true
      
      console.log('[HeadAnchor] Loaded complete model with all components')
      console.log('[HeadAnchor] Morph targets preserved:', {
        morphCount: Object.keys(mesh.morphTargetDictionary || {}).length,
        influencesCount: mesh.morphTargetInfluences?.length || 0,
        morphTargets: Object.keys(mesh.morphTargetDictionary || {}).slice(0, 5) // Show first 5
      })
    })
  }, [modelCache])

  // Convert screen coordinates to world position
  const screenToWorld = (pixelX, pixelY, depth) => {
    // Convert pixel coordinates to NDC
    const ndcX = (pixelX / size.width) * 2 - 1
    const ndcY = -(pixelY / size.height) * 2 + 1
    
    // Unproject using camera parameters
    const vector = new THREE.Vector3(ndcX, ndcY, -1)
    vector.unproject(camera)
    
    // Calculate world position at specified depth
    const direction = vector.sub(camera.position).normalize()
    const distance = Math.abs(depth / direction.z)
    const worldPosition = camera.position.clone().add(direction.multiplyScalar(distance))
    
    return [worldPosition.x, worldPosition.y, worldPosition.z]
  }

  // Calculate head pose from surface normal and position
  const calculatePose = () => {
    const [worldX, worldY, worldZ] = screenToWorld(position_px[0], position_px[1], depthHint)
    
    // Create rotation matrix to align head's +Z with surface normal
    const surfaceNormal = new THREE.Vector3(
      normal_camSpace[0], 
      normal_camSpace[1], 
      normal_camSpace[2]
    ).normalize()
    
    // Head's default forward direction is +Z
    const headForward = new THREE.Vector3(0, 0, 1)
    
    // Calculate rotation to align head with surface
    const quaternion = new THREE.Quaternion()
    quaternion.setFromUnitVectors(headForward, surfaceNormal)
    
    // Scale based on depth (closer = smaller to maintain apparent size)
    const scale = Math.max(0.5, Math.min(2.0, depthHint / 3.0))
    
    return {
      position: [worldX, worldY, worldZ],
      quaternion: quaternion,
      scale: [scale, scale, scale]
    }
  }

  // Update pose and gaze each frame
  useFrame(() => {
    if (!groupRef.current || !modelCache.isLoaded) return
    
    const pose = calculatePose()
    
    // Apply position
    groupRef.current.position.set(...pose.position)
    
    // Apply rotation
    groupRef.current.quaternion.copy(pose.quaternion)
    
    // Apply scale
    groupRef.current.scale.set(...pose.scale)
    
    // Update eye gaze to look at camera
    if (eyesRef.current.leftEye && eyesRef.current.rightEye) {
      // Get camera position in world space
      const cameraWorldPos = camera.position.clone()
      
      // Get head position in world space
      const headWorldPos = groupRef.current.position.clone()
      
      // Calculate direction from head to camera
      const gazeDirection = cameraWorldPos.clone().sub(headWorldPos).normalize()
      
      // Apply limited rotation to eyes (prevent extreme angles)
      const maxRotation = Math.PI / 6 // 30 degrees max rotation
      
      // Calculate eye rotations (simplified - just rotate toward camera)
      const leftEyeRotation = new THREE.Euler()
      const rightEyeRotation = new THREE.Euler()
      
      // Basic gaze tracking - rotate eyes slightly toward camera
      const gazeX = Math.max(-maxRotation, Math.min(maxRotation, gazeDirection.x * 0.5))
      const gazeY = Math.max(-maxRotation, Math.min(maxRotation, gazeDirection.y * 0.5))
      
      leftEyeRotation.set(gazeY, gazeX, 0)
      rightEyeRotation.set(gazeY, gazeX, 0)
      
      eyesRef.current.leftEye.rotation.copy(leftEyeRotation)
      eyesRef.current.rightEye.rotation.copy(rightEyeRotation)
    }
    
    // Debug logging every 60 frames (1 second at 60fps)
    if (Math.random() < 0.016) { // ~1/60 chance per frame
      console.log('[HeadAnchor] Debug pose:', {
        screenPosition: position_px,
        worldPosition: pose.position,
        scale: pose.scale,
        depthHint,
        cameraSize: { width: size.width, height: size.height },
        isVisible: groupRef.current.visible,
        hasEyeTracking: !!(eyesRef.current.leftEye && eyesRef.current.rightEye)
      })
    }
  })

  // Debug logging for render state
  console.log('[HeadAnchor] Render check:', {
    isLoaded: modelCache.isLoaded,
    visible: visible,
    hasModel: !!modelCache.model,
    shouldRender: modelCache.isLoaded && visible
  })

  // Don't render until model is loaded
  if (!modelCache.isLoaded || !visible) {
    console.log('[HeadAnchor] Not rendering - isLoaded:', modelCache.isLoaded, 'visible:', visible)
    return null
  }

  console.log('[HeadAnchor] Rendering HeadAnchor with model:', modelCache.model)

  return (
    <group ref={groupRef}>
      
      {/* Render the complete face model */}
      {modelCache.model && (() => {
        const clonedModel = modelCache.model.clone()
        
        // Calculate bounding box to properly center the complete model
        // Force geometry bounding box calculation first
        clonedModel.traverse((child) => {
          if (child.geometry) {
            child.geometry.computeBoundingBox()
          }
        })
        
        const box = new THREE.Box3().setFromObject(clonedModel)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        
        console.log('[HeadAnchor] Complete model bounds:', { 
          size: { x: size.x.toFixed(3), y: size.y.toFixed(3), z: size.z.toFixed(3) }, 
          center: { x: center.x.toFixed(3), y: center.y.toFixed(3), z: center.z.toFixed(3) }
        })
        
        // Desired head size (in world units) - increased for better visibility
        const desiredSize = 3
        const currentSize = Math.max(size.x, size.y, size.z)
        const scale = desiredSize / currentSize
        
        // Apply transformations to the entire model
        clonedModel.visible = true
        clonedModel.scale.set(scale, scale, scale)
        
        // Center the complete model properly
        clonedModel.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
        
        // Rotation is already fixed by user
        clonedModel.rotation.set(Math.PI/2, 0, 0)
        
        console.log('[HeadAnchor] Complete model - scale:', scale, 'position offset:', clonedModel.position)
        
        // Debug: Check if eyes are present in cloned model and their positions
        let eyeCount = 0
        clonedModel.traverse((child) => {
          if (child.name === 'Object_5' || child.name === 'Object_8') {
            eyeCount++
            console.log('[HeadAnchor] Found eye in clone:', child.name, 'position:', {
              x: child.position.x.toFixed(3),
              y: child.position.y.toFixed(3), 
              z: child.position.z.toFixed(3)
            })
          }
        })
        console.log('[HeadAnchor] Total eyes found in clone:', eyeCount)
        
        // Test morph targets by animating one slightly (for verification)
        const testMorphAnimation = () => {
          if (modelCache.headMesh && modelCache.headMesh.morphTargetInfluences) {
            // Find the corresponding mesh in the cloned model
            let headMeshInClone = null
            clonedModel.traverse((child) => {
              if (child.name === 'mesh_2' && child.morphTargetInfluences) {
                headMeshInClone = child
              }
            })
            
            if (headMeshInClone) {
              // Animate the first morph target slightly for testing
              const time = Date.now() * 0.001
              const morphValue = (Math.sin(time) + 1) * 0.1 // 0 to 0.2 range
              headMeshInClone.morphTargetInfluences[0] = morphValue
              
              // Log occasionally
              if (Math.random() < 0.01) { // ~1% chance per frame
                console.log('[HeadAnchor] Morph test - target 0 value:', morphValue.toFixed(3))
              }
            }
          }
        }
        
        // Apply morph test animation
        testMorphAnimation()
        
        return (
          <primitive 
            ref={meshRef}
            object={clonedModel} 
          />
        )
      })()}
    </group>
  )
}

export default HeadAnchor