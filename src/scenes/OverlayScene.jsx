import { Canvas } from '@react-three/fiber'
import { useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import { SparkleManager } from '../components/SparkleParticles.jsx'

// Axis gizmo component for testing alignment
const AxisGizmo = () => {
  return (
    <group>
      {/* X axis - Red */}
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={2}
            array={new Float32Array([0, 0, 0, 0.1, 0, 0])}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="red" />
      </line>
      
      {/* Y axis - Green */}
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={2}
            array={new Float32Array([0, 0, 0, 0, 0.1, 0])}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="green" />
      </line>
      
      {/* Z axis - Blue */}
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={2}
            array={new Float32Array([0, 0, 0, 0, 0, 0.1])}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="blue" />
      </line>
      
      {/* Center sphere for better visibility */}
      <mesh>
        <sphereGeometry args={[0.005]} />
        <meshBasicMaterial color="white" />
      </mesh>
    </group>
  )
}

// Utility functions for world ↔ NDC conversion
export const useProjection = (camera) => {
  const [projectionMatrix, setProjectionMatrix] = useState(new THREE.Matrix4())
  const [viewMatrix, setViewMatrix] = useState(new THREE.Matrix4())

  useEffect(() => {
    if (camera) {
      setProjectionMatrix(camera.projectionMatrix.clone())
      setViewMatrix(camera.matrixWorldInverse.clone())
    }
  }, [camera])

  const worldToNDC = (worldPos) => {
    const ndc = worldPos.clone()
    ndc.applyMatrix4(viewMatrix)
    ndc.applyMatrix4(projectionMatrix)
    return ndc
  }

  const ndcToWorld = (ndcPos, depth = 1.0) => {
    const world = ndcPos.clone()
    world.z = depth
    world.applyMatrix4(projectionMatrix.clone().invert())
    world.applyMatrix4(viewMatrix.clone().invert())
    return world
  }

  const screenToWorld = (screenX, screenY, canvasWidth, canvasHeight, depth = 1.0) => {
    // Convert screen coordinates to NDC (-1 to 1)
    const ndcX = (screenX / canvasWidth) * 2 - 1
    const ndcY = -(screenY / canvasHeight) * 2 + 1
    return ndcToWorld(new THREE.Vector3(ndcX, ndcY, 0), depth)
  }

  return { worldToNDC, ndcToWorld, screenToWorld }
}

const OverlayScene = ({ width, height, anchors = [] }) => {
  const canvasRef = useRef()
  const [camera, setCamera] = useState(null)
  const [dpr, setDpr] = useState(1)

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

  const projection = useProjection(camera)

  return (
    <div 
      className="overlay-scene"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none', // Allow touch events to pass through when needed
        zIndex: 5
      }}
    >
      <Canvas
        ref={canvasRef}
        dpr={dpr}
        camera={{
          fov,
          aspect,
          near,
          far,
          position: [0, 0, 0]
        }}
        onCreated={(state) => {
          setCamera(state.camera)
          // Make canvas background transparent
          state.gl.setClearColor(0x000000, 0)
          // Disable depth testing for overlay rendering
          state.gl.sortObjects = false
        }}
        style={{
          background: 'transparent',
          width: '100%',
          height: '100%'
        }}
        gl={{
          alpha: true,
          antialias: true,
          powerPreference: "high-performance"
        }}
      >
        {/* Ambient light for visibility */}
        <ambientLight intensity={0.5} />
        
        {/* Directional light */}
        <directionalLight position={[1, 1, 1]} intensity={0.5} />
        
        {/* Axis gizmo at screen center for testing */}
        <AxisGizmo />
        
        {/* Sparkle effects for stable anchors */}
        <SparkleManager anchors={anchors} />
        
        {/* Test objects at different positions */}
        <mesh position={[0.2, 0, -1]}>
          <boxGeometry args={[0.05, 0.05, 0.05]} />
          <meshStandardMaterial color="orange" />
        </mesh>
        
        <mesh position={[-0.2, 0, -1]}>
          <sphereGeometry args={[0.025]} />
          <meshStandardMaterial color="cyan" />
        </mesh>
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
