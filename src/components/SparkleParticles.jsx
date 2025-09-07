import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Sparkle particle effect for stable anchors
 * Creates animated sparkles around a 2D screen position
 */
export function SparkleParticles({ 
  position, 
  isActive = false, 
  particleCount = 12,
  radius = 30,
  color = '#FFD700' 
}) {
  const particlesRef = useRef();
  const materialRef = useRef();
  
  // Generate particle positions and properties
  const particleData = useMemo(() => {
    const positions = new Float32Array(particleCount * 3);
    const scales = new Float32Array(particleCount);
    const phases = new Float32Array(particleCount); // Animation phase offset
    const speeds = new Float32Array(particleCount); // Rotation speed
    
    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      
      // Random position in circle around center
      const angle = (i / particleCount) * Math.PI * 2 + Math.random() * 0.5;
      const distance = radius * (0.5 + Math.random() * 0.5);
      
      positions[i3] = Math.cos(angle) * distance;     // x
      positions[i3 + 1] = Math.sin(angle) * distance; // y
      positions[i3 + 2] = 0;                          // z
      
      scales[i] = 0.5 + Math.random() * 0.5; // Random scale 0.5-1.0
      phases[i] = Math.random() * Math.PI * 2; // Random phase
      speeds[i] = 0.5 + Math.random() * 1.0; // Random speed
    }
    
    return { positions, scales, phases, speeds };
  }, [particleCount, radius]);

  // Sparkle geometry
  const sparkleGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    
    // Create star-like shape for sparkles
    const vertices = [];
    const indices = [];
    const uvs = [];
    
    for (let i = 0; i < particleCount; i++) {
      const baseIndex = i * 8; // 8 vertices per sparkle (star shape)
      
      // Center point
      vertices.push(0, 0, 0);
      uvs.push(0.5, 0.5);
      
      // 6 points for star + center
      for (let j = 0; j < 6; j++) {
        const angle = (j / 6) * Math.PI * 2;
        const isOuter = j % 2 === 0;
        const r = isOuter ? 1.0 : 0.4;
        
        vertices.push(
          Math.cos(angle) * r,
          Math.sin(angle) * r,
          0
        );
        
        uvs.push(
          0.5 + Math.cos(angle) * 0.5,
          0.5 + Math.sin(angle) * 0.5
        );
        
        // Create triangles from center to edges
        if (j < 5) {
          indices.push(baseIndex, baseIndex + j + 1, baseIndex + j + 2);
        } else {
          indices.push(baseIndex, baseIndex + j + 1, baseIndex + 1);
        }
      }
    }
    
    geometry.setIndex(indices);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(particleData.positions, 3));
    geometry.setAttribute('instanceScale', new THREE.InstancedBufferAttribute(particleData.scales, 1));
    geometry.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(particleData.phases, 1));
    geometry.setAttribute('instanceSpeed', new THREE.InstancedBufferAttribute(particleData.speeds, 1));
    
    return geometry;
  }, [particleCount, particleData]);

  // Animation loop
  useFrame((state) => {
    if (!particlesRef.current || !materialRef.current) return;
    
    const time = state.clock.elapsedTime;
    
    // Update particle positions and opacity
    if (isActive) {
      // Animate sparkles
      const positions = particleData.positions;
      const phases = particleData.phases;
      const speeds = particleData.speeds;
      
      for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;
        const phase = phases[i];
        const speed = speeds[i];
        
        // Gentle floating animation
        const floatOffset = Math.sin(time * speed + phase) * 2;
        const rotateOffset = Math.cos(time * speed * 0.7 + phase) * 2;
        
        positions[i3 + 1] += floatOffset * 0.01;
        positions[i3] += rotateOffset * 0.01;
      }
      
      // Update opacity with pulsing effect
      const opacity = 0.7 + Math.sin(time * 2) * 0.3;
      materialRef.current.opacity = opacity;
      
      // Scale animation
      const scale = 1.0 + Math.sin(time * 3) * 0.1;
      particlesRef.current.scale.setScalar(scale);
      
    } else {
      // Fade out when inactive
      materialRef.current.opacity *= 0.95;
    }
  });

  // Update position when prop changes
  useEffect(() => {
    console.log('[SparkleParticles] Position update:', position, 'isActive:', isActive);
    if (particlesRef.current && position) {
      // Convert screen coordinates to NDC coordinates for R3F
      // Assuming position is in screen pixels, we need to convert to NDC (-1 to 1)
      const ndcX = (position.x / window.innerWidth) * 2 - 1;
      const ndcY = -(position.y / window.innerHeight) * 2 + 1;
      console.log('[SparkleParticles] Setting position to NDC:', { ndcX, ndcY });
      particlesRef.current.position.set(ndcX, ndcY, position.z || -0.5);
    }
  }, [position, isActive]);

  console.log(`[SparkleParticles] Rendering with isActive: ${isActive}, position:`, position);
  
  return (
    <instancedMesh
      ref={particlesRef}
      args={[sparkleGeometry, null, particleCount]}
      visible={isActive}
    >
      <shaderMaterial
        ref={materialRef}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        vertexShader={`
          attribute vec3 instancePosition;
          attribute float instanceScale;
          attribute float instancePhase;
          attribute float instanceSpeed;
          
          uniform float time;
          varying vec2 vUv;
          varying float vAlpha;
          
          void main() {
            vUv = uv;
            
            // Instance transformations
            vec3 pos = position * instanceScale;
            
            // Rotation animation
            float rotationSpeed = instanceSpeed * 2.0;
            float rotation = time * rotationSpeed + instancePhase;
            float c = cos(rotation);
            float s = sin(rotation);
            mat2 rotMat = mat2(c, -s, s, c);
            pos.xy = rotMat * pos.xy;
            
            // World position
            pos += instancePosition;
            
            // Alpha based on scale and phase
            vAlpha = instanceScale * (0.7 + sin(time * 3.0 + instancePhase) * 0.3);
            
            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          }
        `}
        fragmentShader={`
          uniform vec3 color;
          uniform float opacity;
          
          varying vec2 vUv;
          varying float vAlpha;
          
          void main() {
            // Create sparkle pattern
            vec2 center = vUv - 0.5;
            float dist = length(center);
            
            // Star-like pattern
            float angle = atan(center.y, center.x);
            float starPattern = sin(angle * 6.0) * 0.5 + 0.5;
            
            // Fade from center
            float fade = 1.0 - smoothstep(0.0, 0.5, dist);
            
            // Combine patterns
            float alpha = fade * starPattern * vAlpha * opacity;
            
            gl_FragColor = vec4(color, alpha);
          }
        `}
        uniforms={{
          color: { value: new THREE.Color(color) },
          opacity: { value: 1.0 },
          time: { value: 0 }
        }}
        onBeforeRender={(renderer, scene, camera, geometry, material) => {
          if (material.uniforms && material.uniforms.time) {
            material.uniforms.time.value = performance.now() * 0.001;
          }
        }}
      />
    </instancedMesh>
  );
}

/**
 * Sparkle manager that handles multiple sparkle effects
 */
export function SparkleManager({ anchors = [] }) {
  console.log('[SparkleManager] Anchors:', anchors);
  
  const stableAnchors = anchors.filter(anchor => anchor.state === 'stable');
  console.log('[SparkleManager] Stable anchors:', stableAnchors);
  
  return (
    <>
      {stableAnchors.map((anchor) => {
        console.log('[SparkleManager] Rendering sparkles for anchor:', anchor.id, anchor.screenPosition);
        return (
          <SparkleParticles
            key={anchor.id}
            position={anchor.screenPosition}
            isActive={true}
            color={anchor.color || '#FFD700'}
          />
        );
      })}
    </>
  );
}