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
    
    loader.load('/3d/face.zip', (gltf) => {
      console.log('[HeadAnchor] glTF loaded:', gltf)
      
      // Find the mesh with morph targets
      const mesh = gltf.scene.children.find(child => 
        (child.type === 'SkinnedMesh' || child.type === 'Mesh') && 
        child.morphTargetDictionary
      )
      
      console.log('[HeadAnchor] Found mesh with morphs:', Object.keys(mesh.morphTargetDictionary || {}))
      
      modelCache.model = mesh
      modelCache.morphTargetDictionary = mesh.morphTargetDictionary
      modelCache.morphTargetInfluences = mesh.morphTargetInfluences
      modelCache.isLoaded = true
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

  // Update pose each frame
  useFrame(() => {
    if (!groupRef.current || !modelCache.isLoaded) return
    
    const pose = calculatePose()
    
    // Apply position
    groupRef.current.position.set(...pose.position)
    
    // Apply rotation
    groupRef.current.quaternion.copy(pose.quaternion)
    
    // Apply scale
    groupRef.current.scale.set(...pose.scale)
  })

  // Don't render until model is loaded
  if (!modelCache.isLoaded || !visible) {
    return null
  }

  return (
    <group ref={groupRef}>
      <primitive 
        ref={meshRef}
        object={modelCache.model.clone()} 
      />
    </group>
  )
}

export default HeadAnchor