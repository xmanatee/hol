import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { logger } from '../utils/logger.js';

/**
 * Simple sparkle particle effect for stable anchors
 * Creates animated sparkles around a 2D screen position using individual meshes
 */
export function SparkleParticles({ 
  position, 
  isActive = false, 
  particleCount = 6,
  radius = 0.15,
  color = '#FFD700' 
}) {
  const groupRef = useRef();
  
  // Generate particle data
  const particles = useMemo(() => {
    return Array.from({ length: particleCount }, (_, i) => {
      const angle = (i / particleCount) * Math.PI * 2;
      const distance = radius * (0.8 + Math.random() * 0.4);
      
      return {
        basePosition: [
          Math.cos(angle) * distance,
          Math.sin(angle) * distance,
          (Math.random() - 0.5) * 0.01
        ],
        scale: 0.8 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2,
        speed: 1.0 + Math.random() * 0.5,
        twinkleSpeed: 2.0 + Math.random() * 1.0
      };
    });
  }, [particleCount, radius]);

  // Animation loop
  useFrame((state) => {
    if (!groupRef.current || !isActive) return;
    
    const time = state.clock.elapsedTime;
    
    groupRef.current.children.forEach((sparkle, i) => {
      const particle = particles[i];
      const { phase, speed, scale, basePosition, twinkleSpeed } = particle;
      
      // Gentle floating animation
      const floatY = Math.sin(time * speed + phase) * 0.008;
      const floatX = Math.cos(time * speed * 0.8 + phase) * 0.006;
      
      // Twinkling effect - sparkles appear/disappear
      const twinkle = Math.sin(time * twinkleSpeed + phase) * 0.5 + 0.5;
      const isVisible = twinkle > 0.3; // Sparkles flicker in and out
      
      sparkle.position.set(
        basePosition[0] + floatX,
        basePosition[1] + floatY,
        basePosition[2]
      );
      
      // Scale pulsing with twinkling
      const pulseScale = 0.8 + Math.sin(time * 4 + phase) * 0.3;
      sparkle.scale.setScalar(scale * pulseScale * twinkle);
      
      // Rotate to create sparkle effect
      sparkle.rotation.z = time * 2 + phase;
      
      // Twinkling opacity
      if (sparkle.material) {
        sparkle.material.opacity = isVisible ? twinkle * 0.9 : 0;
      }
      
      sparkle.visible = isVisible;
    });
  });

  // Update group position - run on every frame to ensure correct positioning
  useFrame(() => {
    if (groupRef.current && position && isActive) {
      // Get the detection canvas dimensions dynamically
      const detectionCanvas = document.querySelector('canvas');
      
      let canvasWidth = window.innerWidth;
      let canvasHeight = window.innerHeight;
      
      if (detectionCanvas) {
        // Use actual canvas internal dimensions (not CSS display size)
        canvasWidth = detectionCanvas.width;
        canvasHeight = detectionCanvas.height;
      }
      
      // Convert from detection canvas coordinates to NDC
      let ndcX = (position.x / canvasWidth) * 2 - 1;
      let ndcY = -(position.y / canvasHeight) * 2 + 1;
      
      // Clamp NDC coordinates to visible range with some margin
      ndcX = Math.max(-0.9, Math.min(0.9, ndcX));
      ndcY = Math.max(-0.9, Math.min(0.9, ndcY));
      
      // Log more frequently for debugging
      if (Math.random() < 0.1) { // 10% chance per frame
        logger.info('SparkleParticles', 'Raw position:', position.x, position.y);
        logger.info('SparkleParticles', 'Canvas dimensions used:', canvasWidth, 'x', canvasHeight);
        logger.info('SparkleParticles', 'Position as % of canvas:', (position.x/canvasWidth*100).toFixed(1), '%, ', (position.y/canvasHeight*100).toFixed(1), '%');
        logger.info('SparkleParticles', 'Calculated NDC position:', { ndcX, ndcY });
      }
      
      groupRef.current.position.set(ndcX, ndcY, -0.5);
    }
  });
  
  if (!isActive) return null;
  
  return (
    <group ref={groupRef}>
      {particles.map((particle, i) => (
        <mesh key={i} position={particle.basePosition}>
          {/* Star-shaped sparkle using crossed planes */}
          <group>
            {/* Horizontal cross */}
            <mesh>
              <planeGeometry args={[0.08, 0.02]} />
              <meshBasicMaterial
                color={color}
                transparent={true}
                side={THREE.DoubleSide}
              />
            </mesh>
            {/* Vertical cross */}
            <mesh rotation={[0, 0, Math.PI / 2]}>
              <planeGeometry args={[0.08, 0.02]} />
              <meshBasicMaterial
                color={color}
                transparent={true}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        </mesh>
      ))}
    </group>
  );
}

/**
 * Sparkle manager that handles multiple sparkle effects
 */
export function SparkleManager({ anchors = [] }) {
  // Show sparkles for tracking and stable anchors (not just stable)
  const trackingAnchors = anchors.filter(anchor => 
    anchor.state === 'stable' || anchor.state === 'tracking'
  );
  
  // Debug: temporarily show sparkles for ALL anchors to test visibility  
  const debugShowAllAnchors = true; // Enabled - show sparkles for all states to debug
  const anchorsToRender = debugShowAllAnchors ? anchors : trackingAnchors;
  
  // Debug logging
  if (anchors.length > 0) {
    logger.info('SparkleManager', 'Total anchors:', anchors.length);
    logger.info('SparkleManager', 'Tracking anchors:', trackingAnchors.length);
    logger.info('SparkleManager', 'Debug mode - rendering for all anchors:', debugShowAllAnchors);
    anchors.forEach(anchor => {
      logger.info('SparkleManager', `Anchor ${anchor.id}: state=${anchor.state}, position=`, anchor.screenPosition);
    });
  }
  
  return (
    <>
      {anchorsToRender.map((anchor) => {
        logger.info('SparkleManager', `Rendering sparkles for anchor ${anchor.id} at position:`, anchor.screenPosition);
        return (
          <SparkleParticles
            key={anchor.id}
            position={anchor.screenPosition}
            isActive={true}
            color={debugShowAllAnchors && anchor.state !== 'stable' ? '#FF6B6B' : anchor.color || '#FFD700'}
          />
        );
      })}
    </>
  );
}