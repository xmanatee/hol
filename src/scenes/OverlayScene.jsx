import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { DoubleSide } from 'three';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import HeadAnchor from '../components/organisms/HeadAnchor.jsx';
import { logger } from '../utils/logger.js';
import { computeAnchorOverlayTransform } from '../utils/anchorProjection.js';
import { writePlanarSurfaceMatrices } from '../utils/planarSurfaceAttachment.js';
import { getRenderableAnchorOverlay } from '../utils/overlayVisibility.js';
import { DemandRenderScheduler } from '../utils/overlayRenderScheduler.js';
import { observeWebGLContext } from '../utils/webglContextLifecycle.js';
import { AnchorMotionPredictor } from '../utils/anchorMotionPredictor.js';

const MAX_DEVICE_PIXEL_RATIO = 1.5;
const WEBGL_OPTIONS = {
  alpha: true,
  antialias: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
};

const useRenderSize = (containerRef) => {
  const [renderSize, setRenderSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const updateSize = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      const width = rect?.width || window.innerWidth;
      const height = rect?.height || window.innerHeight;
      setRenderSize((current) => {
        if (current.width === width && current.height === height) {
          return current;
        }
        return { width, height };
      });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    window.addEventListener('resize', updateSize);
    window.addEventListener('orientationchange', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
      window.removeEventListener('orientationchange', updateSize);
    };
  }, [containerRef]);

  return renderSize;
};

const WebGLContextMonitor = ({ setStatus }) => {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    gl.setClearColor(0x000000, 0);
    logger.info('OverlayScene', 'Canvas created successfully!');

    return observeWebGLContext(gl.domElement, {
      onLost: () => {
        setStatus('lost');
        logger.warn('OverlayScene', 'WebGL context lost');
      },
      onRestored: () => {
        setStatus('active');
        invalidate();
        logger.info('OverlayScene', 'WebGL context restored');
      },
    });
  }, [gl, invalidate, setStatus]);

  return null;
};

const DemandRenderController = ({ active }) => {
  const invalidate = useThree((state) => state.invalidate);
  const schedulerRef = useRef(null);

  useEffect(() => {
    const scheduler = new DemandRenderScheduler({
      invalidate,
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
      now: () => performance.now(),
    });
    schedulerRef.current = scheduler;

    return () => {
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, [invalidate]);

  useEffect(() => {
    schedulerRef.current?.setActive(active);
  }, [active]);

  return null;
};

const LiveAnchorGroup = ({
  width,
  height,
  renderWidth,
  renderHeight,
  fov,
  cameraDistance,
  mirrored,
  anchorSystemState,
  subscribeAnchorSystemState,
  children,
}) => {
  const groupRef = useRef(null);
  const contentRef = useRef(null);
  const surfaceRef = useRef(null);
  const camera = useThree((state) => state.camera);
  const planarProjectionRef = useRef(false);
  const appearedAtRef = useRef(0);
  const [motionPreference] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)'));
  const invalidate = useThree((state) => state.invalidate);
  const liveStateRef = useRef(anchorSystemState);
  const sampledAtRef = useRef(null);
  const anchorIdentityRef = useRef(null);
  const [motionPredictor] = useState(() => new AnchorMotionPredictor());

  const updateObservation = useCallback(
    (state) => {
      liveStateRef.current = state;
      invalidate();
    },
    [invalidate],
  );

  useLayoutEffect(() => {
    updateObservation(anchorSystemState);
  }, [anchorSystemState, updateObservation]);

  useEffect(() => {
    return subscribeAnchorSystemState(updateObservation);
  }, [subscribeAnchorSystemState, updateObservation]);

  useFrame(() => {
    const now = performance.now();
    const group = groupRef.current;
    const liveState = liveStateRef.current;
    const activeAnchor = getRenderableAnchorOverlay(liveState, now);
    const anchorIdentity = activeAnchor ? (activeAnchor.createdAt ?? activeAnchor.id) : null;
    if (!activeAnchor) {
      motionPredictor.reset();
      sampledAtRef.current = null;
      if (!liveState.activeAnchor) anchorIdentityRef.current = null;
      group.visible = false;
      return;
    }

    if (anchorIdentityRef.current !== anchorIdentity) {
      motionPredictor.reset();
      sampledAtRef.current = null;
      anchorIdentityRef.current = anchorIdentity;
      appearedAtRef.current = now;
    }
    const attachment = liveState.anchorState.metrics?.surfaceAttachment;
    if (attachment) {
      group.matrixAutoUpdate = false;
      writePlanarSurfaceMatrices({
        attachment,
        modelMatrix: group.matrix,
        projectionMatrix: camera.projectionMatrix,
        width,
        height,
        renderWidth,
        renderHeight,
        cameraDistance,
        mirrored,
      });
      group.matrixWorldNeedsUpdate = true;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      planarProjectionRef.current = true;
      group.visible = attachment.rotation[8] > 0.12;
      surfaceRef.current.visible = true;
      const progress = motionPreference.matches ? 1 : Math.min(1, (now - appearedAtRef.current) / 450);
      contentRef.current.position.z = -0.5 + 0.75 * (1 - (1 - progress) ** 3);
      if (progress < 1) invalidate();
      return;
    }
    if (planarProjectionRef.current) {
      camera.updateProjectionMatrix();
      planarProjectionRef.current = false;
    }
    group.matrixAutoUpdate = true;
    surfaceRef.current.visible = false;
    contentRef.current.position.z = 0;
    if (sampledAtRef.current !== liveState.sampledAt) {
      motionPredictor.observe(liveState.anchorState.position, liveState.sampledAt);
      sampledAtRef.current = liveState.sampledAt;
    }

    const presentationPosition = motionPredictor.project(now);
    const transform = computeAnchorOverlayTransform({
      width,
      height,
      renderWidth,
      renderHeight,
      activeAnchor,
      anchorState: liveState.anchorState,
      fov,
      cameraDistance,
      mirrored,
      presentationPosition,
    });
    group.visible = transform.visible;
    group.position.set(...transform.position);
    group.rotation.set(...transform.rotation);
    group.scale.setScalar(transform.scale);
    if (motionPredictor.needsRender) {
      invalidate();
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      <mesh ref={surfaceRef} visible={false} renderOrder={-1}>
        <planeGeometry args={[2, 2]} />
        <meshBasicMaterial colorWrite={false} depthWrite side={DoubleSide} />
      </mesh>
      <group ref={contentRef}>{children}</group>
    </group>
  );
};

const OverlayScene = ({
  width,
  height,
  isAgentSpeaking = false,
  hiddenMeshes = new Set(),
  manualRotation = { x: 0, y: 0, z: 0 },
  onMeshNamesDiscovered,
  onMicrophoneTelemetry,
  microphoneMode = false,
  microphoneService,
  ttsService,
  anchorSystemState,
  subscribeAnchorSystemState,
  mirrored = false,
  facialExpression = 'neutral',
  animationIntensity = 0.65,
  style = {},
}) => {
  const [webglStatus, setWebglStatus] = useState('active');
  const containerRef = useRef(null);
  const fov = 63;
  const cameraDistance = 3;
  const far = 100;
  const renderSize = useRenderSize(containerRef);
  const dpr = useMemo(() => [1, Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)], []);

  return (
    <div
      ref={containerRef}
      className="overlay-scene"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 25,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <Canvas
        dpr={dpr}
        gl={WEBGL_OPTIONS}
        frameloop={webglStatus === 'active' ? 'demand' : 'never'}
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
        camera={{
          position: [0, 0, cameraDistance],
          fov,
          near: 0.01,
          far,
        }}
      >
        <WebGLContextMonitor setStatus={setWebglStatus} />
        <DemandRenderController active={webglStatus === 'active' && (isAgentSpeaking || microphoneMode)} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2, 2]} intensity={0.6} />
        <directionalLight position={[-1, -1, -1]} intensity={0.3} />

        <LiveAnchorGroup
          width={width}
          height={height}
          renderWidth={renderSize.width}
          renderHeight={renderSize.height}
          fov={fov}
          cameraDistance={cameraDistance}
          mirrored={mirrored}
          anchorSystemState={anchorSystemState}
          subscribeAnchorSystemState={subscribeAnchorSystemState}
        >
          <HeadAnchor
            visible
            hiddenMeshes={hiddenMeshes}
            manualRotation={manualRotation}
            onMeshNamesDiscovered={onMeshNamesDiscovered}
            onMicrophoneTelemetry={onMicrophoneTelemetry}
            microphoneService={microphoneService}
            ttsService={ttsService}
            facialExpression={facialExpression}
            animationIntensity={animationIntensity}
          />
        </LiveAnchorGroup>
      </Canvas>
      {webglStatus === 'lost' && (
        <div className="fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded border border-yellow-600 bg-yellow-950 px-3 py-2 text-xs text-yellow-100">
          3D overlay paused while WebGL recovers
        </div>
      )}
    </div>
  );
};

export default memo(OverlayScene);
