import { useRef, useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { GLTFLoader, DRACOLoader, KTX2Loader, MeshoptDecoder } from 'three-stdlib'
import * as THREE from 'three'
import { useHeadLipSync } from '../../hooks/useLipSync.js'
import { logger } from '../../utils/logger.js'

const HeadAnchor = ({ 
  position_px = [100, 100], 
  normal_camSpace = [0, 0, 1], 
  depthHint = 2.0,
  visible = true,
  isAgentSpeaking = false,
  hiddenMeshes = new Set(),
  manualRotation = { x: 0, y: 0, z: 0 },
  onMeshNamesDiscovered = () => {}
}) => {
  const groupRef = useRef()
  const { scene } = useThree()
  
  // Simple cache for the loaded GLTF model
  const modelCache = useMemo(() => ({
    gltfScene: null,
    headMesh: null,
    isLoaded: false
  }), [])

  // Initialize lip-sync system
  const lipSync = useHeadLipSync(modelCache.headMesh)

  // Update lip-sync when agent speaking status changes
  useEffect(() => {
    if (lipSync.setAgentSpeaking) {
      lipSync.setAgentSpeaking(isAgentSpeaking);
    }
  }, [isAgentSpeaking, lipSync.setAgentSpeaking]);

  // Load GLTF model
  useEffect(() => {
    if (modelCache.isLoaded) return

    // Configure GLTFLoader with extensions for proper loading
    const loader = new GLTFLoader()
    
    // Add GLTF extensions for complete compatibility
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
    loader.setDRACOLoader(dracoLoader)
    
    const ktx2Loader = new KTX2Loader()
    ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/gh/pmndrs/drei-assets/basis/')
    loader.setKTX2Loader(ktx2Loader)
    
    loader.setMeshoptDecoder(MeshoptDecoder)
    
    logger.info('HeadAnchor', 'Loading GLTF with full extension support')
    
    loader.load('/3d/scene.gltf', (gltf) => {
      logger.info('HeadAnchor', 'GLTF loaded successfully')
      
      // Add the raw GLTF scene directly to Three.js scene (preserves all hierarchy)
      scene.add(gltf.scene)
      
      // Discover all mesh names for visibility controls
      const meshNames = []
      gltf.scene.traverse((child) => {
        if (child.type === 'Mesh' || child.type === 'SkinnedMesh') {
          meshNames.push(child.name)
          logger.info('HeadAnchor', `Found mesh: ${child.name} (${child.type})`)
          
          // Find head mesh with morph targets for lip sync
          if (child.morphTargetDictionary && child.morphTargetInfluences) {
            modelCache.headMesh = child
            logger.info('HeadAnchor', `Found head mesh with morph targets: ${child.name}`)
          }
        }
      })
      
      // Store reference and mark as loaded
      modelCache.gltfScene = gltf.scene
      modelCache.isLoaded = true
      
      // Notify parent of discovered mesh names
      onMeshNamesDiscovered(meshNames)
      
      logger.info('HeadAnchor', `GLTF model loaded with ${meshNames.length} meshes`)
    }, (progress) => {
      logger.info('HeadAnchor', `Loading progress: ${(progress.loaded / progress.total * 100).toFixed(1)}%`)
    }, (error) => {
      logger.error('HeadAnchor', 'GLTF loading error:', error)
    })
  }, [modelCache, scene, onMeshNamesDiscovered])

  // Cleanup: Remove GLTF from scene when component unmounts
  useEffect(() => {
    return () => {
      if (modelCache.gltfScene && scene) {
        logger.info('HeadAnchor', 'Cleanup: Removing GLTF from scene')
        scene.remove(modelCache.gltfScene)
        modelCache.gltfScene = null
        modelCache.isLoaded = false
      }
    }
  }, [scene, modelCache])

  // Apply mesh visibility when hiddenMeshes changes
  useEffect(() => {
    if (!modelCache.isLoaded || !modelCache.gltfScene) return
    
    modelCache.gltfScene.traverse((child) => {
      if (child.type === 'Mesh' || child.type === 'SkinnedMesh') {
        const shouldHide = hiddenMeshes.has(child.name)
        child.visible = !shouldHide
        
        // Make eyes more visible for debugging
        if (child.name === 'Object_5' || child.name === 'Object_8') {
          child.visible = true // Always show eyes
          child.material = new THREE.MeshBasicMaterial({
            color: child.name === 'Object_5' ? 0xff0000 : 0x00ff00, // Red/Green for visibility
          })
        }
        
        logger.info('HeadAnchor', `Mesh ${child.name} visibility: ${child.visible}`)
      }
    })
  }, [hiddenMeshes, modelCache.isLoaded, modelCache.gltfScene])

  // Apply transforms and lip-sync animation
  useFrame(() => {
    if (!modelCache.isLoaded || !modelCache.gltfScene || !visible) return
    
    // Apply top-level transforms to the whole GLTF model
    const topLevelScale = 10 // Scale for visibility
    const baseRotation = Math.PI / 2 // Face forward (90 degrees around X)
    
    // Set scale and rotation
    modelCache.gltfScene.scale.set(topLevelScale, topLevelScale, topLevelScale)
    modelCache.gltfScene.rotation.set(
      baseRotation + manualRotation.x, 
      manualRotation.y, 
      manualRotation.z
    )
    
    // Position in front of camera
    modelCache.gltfScene.position.set(0, 0, -2)
    
    // Apply lip-sync to head mesh if available
    if (modelCache.headMesh && modelCache.headMesh.morphTargetInfluences) {
      // Simple test animation (will be replaced by real lip-sync)
      const time = Date.now() * 0.001
      const morphValue = (Math.sin(time) + 1) * 0.1
      if (modelCache.headMesh.morphTargetInfluences.length > 0) {
        modelCache.headMesh.morphTargetInfluences[0] = morphValue
      }
    }
  })

  // Don't render anything in React - model is added directly to Three.js scene
  if (!modelCache.isLoaded || !visible) {
    return null
  }

  return (
    <group ref={groupRef}>
      {/* Empty group - actual model is in Three.js scene directly */}
    </group>
  )
}

export default HeadAnchor