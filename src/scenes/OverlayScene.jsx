import { Canvas } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import HeadAnchor from '../components/organisms/HeadAnchor.jsx'
import { logger } from '../utils/logger.js'
import { computeAnchorOverlayTransform } from '../utils/anchorProjection.js'

const useRenderSize = () => {
  const [renderSize, setRenderSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    const handleResize = () => {
      setRenderSize({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
    }
  }, [])

  return renderSize
}

const OverlayScene = ({ 
  width, 
  height, 
  isAgentSpeaking = false, 
  hiddenMeshes = new Set(), 
  manualRotation = { x: 0, y: 0, z: 0 }, 
  onMeshNamesDiscovered = () => {},
  onLipSyncUpdate = () => {},
  microphoneMode = false,
  activeAnchor = null,
  anchorState = null,
  agentAudioAnalysis = null,
  agentAudioAlignment = null
}) => {
  const [webglStatus, setWebglStatus] = useState('active')
  const fov = 63
  const cameraDistance = 3
  const far = 100
  const renderSize = useRenderSize()
  const anchorTransform = useMemo(() => computeAnchorOverlayTransform({
    width,
    height,
    renderWidth: renderSize.width,
    renderHeight: renderSize.height,
    activeAnchor,
    anchorState,
    fov,
    cameraDistance,
  }), [width, height, renderSize.width, renderSize.height, activeAnchor, anchorState])

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

          const canvas = state.gl.domElement
          canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault()
            setWebglStatus('lost')
            logger.warn('OverlayScene', 'WebGL context lost')
          })
          canvas.addEventListener('webglcontextrestored', () => {
            setWebglStatus('active')
            logger.info('OverlayScene', 'WebGL context restored')
          })
        }}
        camera={{
          position: [0, 0, cameraDistance],
          fov: fov,
          near: 0.01,
          far: far
        }}
      >
        {/* Lighting for head visibility */}
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2, 2]} intensity={0.6} />
        <directionalLight position={[-1, -1, -1]} intensity={0.3} />

        <group
          position={anchorTransform.position}
          rotation={anchorTransform.rotation}
          scale={[anchorTransform.scale, anchorTransform.scale, anchorTransform.scale]}
        >
          <HeadAnchor 
            visible={anchorTransform.visible}
            isAgentSpeaking={isAgentSpeaking}
            hiddenMeshes={hiddenMeshes}
            manualRotation={manualRotation}
            onMeshNamesDiscovered={onMeshNamesDiscovered}
            onLipSyncUpdate={onLipSyncUpdate}
            microphoneMode={microphoneMode}
            agentAudioAnalysis={agentAudioAnalysis}
            agentAudioAlignment={agentAudioAlignment}
          />
        </group>
      </Canvas>
      {webglStatus === 'lost' && (
        <div className="fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded border border-yellow-600 bg-yellow-950 px-3 py-2 text-xs text-yellow-100">
          3D overlay paused while WebGL recovers
        </div>
      )}
    </div>
  )
}

export default OverlayScene
