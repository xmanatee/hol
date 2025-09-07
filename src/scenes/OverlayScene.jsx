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
        zIndex: 25,
        boxSizing: 'border-box'
      }}
    >
      
      <Canvas
        gl={{ alpha: true, antialias: true }}
        style={{
          width: '100%',
          height: '100%',
          transform: 'scaleX(-1)',
          transformOrigin: 'center',
          pointerEvents: 'none'
        }}
        onCreated={(state) => {
          console.log('[OverlayScene] Canvas created successfully!');
          state.gl.setClearColor(0x000000, 0.0); // Transparent background
          state.gl.alpha = true; // Enable alpha blending
        }}
        camera={{ 
          position: [0, 0, 3], 
          fov: fov,
          aspect: aspect,
          near: near,
          far: far
        }}
      >
        {/* Enhanced lighting for model visibility */}
        <ambientLight intensity={0.8} />
        
        {/* Multiple directional lights for better illumination */}
        <directionalLight position={[1, 1, 1]} intensity={0.8} />
        <directionalLight position={[-1, -1, -1]} intensity={0.4} />
        <directionalLight position={[0, 0, 1]} intensity={0.6} />
        
        
        {/* Sparkle effects for stable anchors */}
        <SparkleManager anchors={anchors} />
        
        {/* HeadAnchor in top left corner */}
        <HeadAnchor 
          position_px={[width * 0.2, height * 0.8]} 
          normal_camSpace={[0, 0, 1]} 
          depthHint={1.0}
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
