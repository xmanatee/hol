import { Canvas } from '@react-three/fiber'
import { useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import { SparkleManager } from '../components/SparkleParticles.jsx'
import HeadAnchor from '../components/organisms/HeadAnchor.jsx'

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



const OverlayScene = ({ width, height, anchors = [] }) => {
  const canvasRef = useRef()
  const [dpr, setDpr] = useState(1)

  // Debug logging
  console.log('[OverlayScene] Rendering with:', { width, height, anchorsCount: anchors.length });
  anchors.forEach(anchor => {
    console.log(`[OverlayScene] Anchor ${anchor.id}: ${anchor.state} at`, anchor.screenPosition);
  });

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
        zIndex: 15,
        boxSizing: 'border-box',
        border: '5px solid orange', // Verify the container is visible
        backgroundColor: 'rgba(255, 165, 0, 0.2)' // Orange tint to verify container
      }}
    >
      {/* Test if the div container is working */}
      <div style={{
        position: 'absolute',
        top: '200px',
        left: '200px',
        backgroundColor: 'purple',
        padding: '20px',
        color: 'white',
        fontSize: '24px',
        fontWeight: 'bold'
      }}>
        OVERLAY CONTAINER TEST
      </div>
      
      {/* Minimal Canvas test */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: 'blue',
        color: 'white',
        padding: '5px'
      }}>
        About to render Canvas...
      </div>
      
      <Canvas
        style={{
          width: '100%',
          height: '100%',
          border: '3px solid yellow'
        }}
        onCreated={(state) => {
          console.log('[OverlayScene] Canvas created successfully!');
          state.gl.setClearColor(0xff0000, 1.0); // Solid red background
        }}
        camera={{ position: [0, 0, 5] }}
      >
        {/* Ambient light for visibility */}
        <ambientLight intensity={0.5} />
        
        {/* Directional light */}
        <directionalLight position={[1, 1, 1]} intensity={0.5} />
        
        {/* Test: Fixed red cross at screen center */}
        <mesh position={[0, 0, -0.5]}>
          <planeGeometry args={[0.3, 0.06]} />
          <meshBasicMaterial color="red" side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 0, -0.5]} rotation={[0, 0, Math.PI / 2]}>
          <planeGeometry args={[0.3, 0.06]} />
          <meshBasicMaterial color="red" side={THREE.DoubleSide} />
        </mesh>
        
        {/* Test: Fixed blue box at different position */}
        <mesh position={[0.3, 0.3, -0.5]}>
          <boxGeometry args={[0.1, 0.1, 0.1]} />
          <meshBasicMaterial color="blue" />
        </mesh>
        
        {/* Sparkle effects for stable anchors */}
        <SparkleManager anchors={anchors} />
        
        {/* Test HeadAnchor in top right corner */}
        <HeadAnchor 
          position_px={[width * 0.8, height * 0.2]} 
          normal_camSpace={[0, 0, 1]} 
          depthHint={2.0}
          visible={true}
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
