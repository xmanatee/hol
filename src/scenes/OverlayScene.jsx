import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import HeadAnchor from '../components/organisms/HeadAnchor.jsx'
import { logger } from '../utils/logger.js'

// Camera controller for top-left corner positioning
const CameraController = ({ manualRotation, width, height }) => {
  const { camera } = useThree()
  
  useFrame(() => {
    // Calculate top-left corner position in world space
    // Convert screen coordinates to world coordinates
    const aspect = width / height
    const fov = 63 * Math.PI / 180 // Convert to radians
    const distance = 3 // Distance from model
    
    // Calculate view dimensions at the model's distance
    const viewHeight = 2 * Math.tan(fov / 2) * distance
    const viewWidth = viewHeight * aspect
    
    // Position for top-left corner (offset from center)
    const offsetX = -viewWidth * 0.35  // Left side
    const offsetY = viewHeight * 0.35   // Top side
    
    // Apply manual rotation around the offset position
    const rotX = manualRotation.x
    const rotY = manualRotation.y
    
    // Calculate orbital position around the offset point
    const x = offsetX + distance * Math.sin(rotY) * Math.cos(rotX)
    const y = offsetY + distance * Math.sin(rotX) * 0.3
    const z = distance * Math.cos(rotY) * Math.cos(rotX)
    
    // Position camera
    camera.position.set(x, y, z)
    
    // Look at the offset position (top-left area)
    camera.lookAt(offsetX, offsetY, 0)
    
    // Update camera matrix
    camera.updateMatrixWorld()
  })
  
  return null
}

const OverlayScene = ({ 
  width, 
  height, 
  isAgentSpeaking = false, 
  hiddenMeshes = new Set(), 
  manualRotation = { x: 0, y: 0, z: 0 }, 
  onMeshNamesDiscovered = () => {},
  onLipSyncUpdate = () => {},
  microphoneMode = false
}) => {
  const [dpr, setDpr] = useState(1)

  // iPhone wide camera approximation
  const fov = 63
  const aspect = width / height
  const far = 100
  
  // Calculate view dimensions for top-left positioning
  const distance = 3
  const fovRadians = fov * Math.PI / 180
  const viewHeight = 2 * Math.tan(fovRadians / 2) * distance
  const viewWidth = viewHeight * aspect

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
          position: [0.2, 0.1, 0.3], // Initial position for orbital view
          fov: fov,
          aspect: aspect,
          near: 0.01,
          far: far
        }}
      >
        {/* Camera controller with manual rotation */}
        <CameraController manualRotation={manualRotation} width={width} height={height} />
        
        {/* Lighting for head visibility */}
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2, 2]} intensity={0.6} />
        <directionalLight position={[-1, -1, -1]} intensity={0.3} />
        
        {/* Sparkle effects removed - using 2D canvas sparkles instead */}
        
        {/* HeadAnchor positioned in top-left corner */}
        <group position={[-viewWidth * 0.35, viewHeight * 0.35, 0]}>
          <HeadAnchor 
            visible={true}
            isAgentSpeaking={isAgentSpeaking}
            hiddenMeshes={hiddenMeshes}
            manualRotation={manualRotation}
            onMeshNamesDiscovered={onMeshNamesDiscovered}
            onLipSyncUpdate={onLipSyncUpdate}
            microphoneMode={microphoneMode}
          />
        </group>
      </Canvas>
    </div>
  )
}

export default OverlayScene
