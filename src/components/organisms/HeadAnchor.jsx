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
      
      // CRITICAL: Force complete matrix updates before adding to scene
      logger.info('HeadAnchor', '=== FORCING MATRIX UPDATES ===')
      gltf.scene.updateMatrix()
      gltf.scene.updateMatrixWorld(true) // Force update entire hierarchy
      
      // Add the raw GLTF scene directly to Three.js scene (preserves all hierarchy)
      scene.add(gltf.scene)
      
      // Force another matrix update after adding to scene
      gltf.scene.updateMatrix()
      gltf.scene.updateMatrixWorld(true)
      
      // Discover all mesh names and debug transforms
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
        
        // Debug transform data for eye-related objects
        if (child.name.includes('eye') || child.name === 'Object_5' || child.name === 'Object_8' || 
            child.name.includes('Eye') || child.name.includes('grp_eye')) {
          
          logger.info('HeadAnchor', `TRANSFORM_DEBUG_${child.name}`, {
            type: child.type,
            position: child.position.toArray(),
            rotation: child.rotation.toArray(),
            scale: child.scale.toArray(),
            quaternion: child.quaternion.toArray(),
            matrix: child.matrix.toArray().slice(0, 16),
            matrixWorld: child.matrixWorld.toArray().slice(0, 16),
            parentName: child.parent?.name || 'none',
            hasChildren: child.children.length > 0,
            childrenNames: child.children.map(c => c.name)
          })
        }
      })
      
      // After all transforms are logged, force one more update
      logger.info('HeadAnchor', '=== FINAL MATRIX UPDATE ===')
      gltf.scene.traverse((child) => {
        child.updateMatrix()
        child.updateMatrixWorld()
      })
      
      // Verify eye positions after all matrix updates
      logger.info('HeadAnchor', '=== EYE POSITION VERIFICATION AFTER MATRIX UPDATES ===')
      gltf.scene.traverse((child) => {
        if (child.name === 'Object_5' || child.name === 'Object_8') {
          const worldPos = new THREE.Vector3()
          child.getWorldPosition(worldPos)
          
          logger.info('HeadAnchor', `FINAL_EYE_POSITION_${child.name}`, {
            localPosition: child.position.toArray(),
            worldPosition: worldPos.toArray(),
            parentName: child.parent?.name,
            parentMatrix: child.parent?.matrix.toArray().slice(0, 16),
            parentWorldMatrix: child.parent?.matrixWorld.toArray().slice(0, 16),
            parentQuaternion: child.parent?.quaternion.toArray(),
            parentRotation: child.parent?.rotation.toArray(),
            matrixUpdatesApplied: true,
            shouldBeCorrectNow: true
          })
          
          // Additional parent hierarchy analysis
          let parent = child.parent
          let level = 0
          while (parent && level < 5) {
            logger.info('HeadAnchor', `PARENT_HIERARCHY_L${level}_${parent.name || 'unnamed'}`, {
              position: parent.position.toArray(),
              rotation: parent.rotation.toArray(), 
              quaternion: parent.quaternion.toArray(),
              scale: parent.scale.toArray(),
              matrix: parent.matrix.toArray().slice(12, 15), // Translation part
              worldMatrix: parent.matrixWorld.toArray().slice(12, 15) // World translation
            })
            parent = parent.parent
            level++
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