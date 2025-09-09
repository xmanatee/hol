import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import HeadAnchor from '../components/organisms/HeadAnchor.jsx'
import { logger } from '../utils/logger.js'

// Camera controller to orbit around the tiny GLTF model
const CameraController = ({ manualRotation }) => {
  const { camera } = useThree()
  
  useFrame(() => {
    // Calculate camera position to orbit around the model at origin
    // Model is tiny (~0.02-0.03 units), so camera needs to be close
    const distance = 0.2 // Very close to see tiny model
    const height = 0.05   // Slight elevation
    
    // Calculate orbital position based on manual rotations
    const x = distance * Math.sin(manualRotation.y) * Math.cos(manualRotation.x)
    const y = height + distance * Math.sin(manualRotation.x) * 0.5
    const z = distance * Math.cos(manualRotation.y) * Math.cos(manualRotation.x)
    
    // Position camera
    camera.position.set(x, y, z)
    
    // Always look at the model center (origin)
    camera.lookAt(0, 0, 0)
    
    // Update camera matrix
    camera.updateMatrixWorld()
  })
  
  return null
}

const OverlayScene = ({ width, height, isAgentSpeaking = false, hiddenMeshes = new Set(), manualRotation = { x: 0, y: 0, z: 0 }, onMeshNamesDiscovered = () => {} }) => {
  const [dpr, setDpr] = useState(1)

  // Debug logging
  logger.info('OverlayScene', 'Rendering with:', { width, height });

  // iPhone wide camera approximation
  const fov = 63
  const aspect = width / height
  const near = 0.01
  const far = 100

  useEffect(() => {
    // Update device pixel ratio
    setDpr(Math.min(window.devicePixelRatio, 2))
    
    // Handle resize events
    const handleResize = () => {
      setDpr(Math.min(window.devicePixelRatio, 2))
    }
    
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])



  return (
    <div 
      className="overlay-scene"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 25,
        boxSizing: 'border-box'
      }}
    >
      
      <Canvas
        gl={{ alpha: true, antialias: true }}
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'none'
        }}
        onCreated={(state) => {
          logger.info('OverlayScene', 'Canvas created successfully!');
          state.gl.setClearColor(0x000000, 0.0); // Transparent background
          state.gl.alpha = true; // Enable alpha blending
        }}
        camera={{ 
          position: [0.1, 0.05, 0.1], // Initial position close to tiny model
          fov: fov,
          aspect: aspect,
          near: 0.001,  // Very close near plane for tiny model
          far: far
        }}
      >
        {/* Camera controller to orbit around tiny model */}
        <CameraController manualRotation={manualRotation} />
        
        {/* Enhanced lighting for tiny model visibility */}
        <ambientLight intensity={1.2} />
        
        {/* Multiple directional lights positioned for tiny model */}
        <directionalLight position={[0.1, 0.1, 0.1]} intensity={0.8} />
        <directionalLight position={[-0.1, -0.1, -0.1]} intensity={0.4} />
        <directionalLight position={[0, 0, 0.1]} intensity={0.6} />
        
        {/* Sparkle effects removed - using 2D canvas sparkles instead */}
        
        {/* HeadAnchor in top left corner */}
        <HeadAnchor 
          position_px={[width * 0.2, height * 0.8]} 
          normal_camSpace={[0, 0, 1]} 
          depthHint={1.0}
          visible={true}
          isAgentSpeaking={isAgentSpeaking}
          hiddenMeshes={hiddenMeshes}
          manualRotation={manualRotation}
          onMeshNamesDiscovered={onMeshNamesDiscovered}
        />
      </Canvas>
      
      {/* Debug info */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        background: 'rgba(0,0,0,0.7)',
        color: 'white',
        padding: '8px 12px',
        borderRadius: '4px',
        fontFamily: 'monospace',
        fontSize: '10px',
        pointerEvents: 'auto'
      }}>
        <div>WebGL Overlay Active</div>
        <div>FOV: {fov}° | DPR: {dpr}</div>
        <div>{width}×{height} | Aspect: {aspect.toFixed(2)}</div>
      </div>
    </div>
  )
}

export default OverlayScene
