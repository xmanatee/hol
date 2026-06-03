export class RandomMorphController {
  constructor(mesh, options = {}) {
    this.mesh = mesh
    this.options = {
      blinkInterval: 4000,       // Base time between blinks (ms)
      blinkVariation: 2000,      // Random variation in blink timing (ms)
      blinkIntensity: 0.8,       // Blink intensity (0-1)
      blinkDuration: 150,        // Blink duration (ms)
      ...options
    }
    
    // Blink tracking
    this.lastBlinkTime = 0
    this.nextBlinkTime = this.getNextBlinkTime()
    this.isBlinking = false
    this.blinkStartTime = 0
    this.blinkIndices = this.findBlinkMorphTargets()
  }
  
  findBlinkMorphTargets() {
    const indices = []
    const morphDict = this.mesh.morphTargetDictionary || {}
    
    // Look for morph targets with blink-related names
    const blinkKeywords = ['blink', 'eyelid', 'eye_close', 'eyes_close', 'lid']
    
    Object.entries(morphDict).forEach(([name, index]) => {
      const lowerName = name.toLowerCase()
      if (blinkKeywords.some(keyword => lowerName.includes(keyword))) {
        indices.push(index)
      }
    })
    return indices
  }
  
  getNextBlinkTime() {
    return Date.now() + this.options.blinkInterval + Math.random() * this.options.blinkVariation
  }
  
  startBlink(currentTime) {
    this.isBlinking = true
    this.blinkStartTime = currentTime
    
    // Apply blink to identified blink morph targets
    this.blinkIndices.forEach(index => {
      if (index < this.mesh.morphTargetInfluences.length) {
        this.mesh.morphTargetInfluences[index] = this.options.blinkIntensity
      }
    })
  }
  
  updateBlink(currentTime) {
    if (!this.isBlinking) return
    
    const elapsed = currentTime - this.blinkStartTime
    
    if (elapsed >= this.options.blinkDuration) {
      // End blink
      this.isBlinking = false
      this.blinkIndices.forEach(index => {
        if (index < this.mesh.morphTargetInfluences.length) {
          this.mesh.morphTargetInfluences[index] = 0
        }
      })
      this.nextBlinkTime = this.getNextBlinkTime()
    }
  }
  
  update() {
    const currentTime = Date.now()
    
    // Handle blinking
    if (currentTime >= this.nextBlinkTime && !this.isBlinking) {
      this.startBlink(currentTime)
    }
    this.updateBlink(currentTime)
  }
  
  stop() {
    for (let i = 0; i < this.mesh.morphTargetInfluences.length; i++) {
      if (!this.blinkIndices.includes(i)) {
        this.mesh.morphTargetInfluences[i] = 0
      }
    }
  }
  
  getDebugInfo() {
    return {
      nextBlinkTime: this.nextBlinkTime - Date.now(),
      isBlinking: this.isBlinking,
      activeTargets: this.isBlinking ? this.blinkIndices.length : 0,
      blinkIndices: this.blinkIndices,
      morphTargetCount: this.mesh.morphTargetInfluences.length
    }
  }
}

// React hook for using random morphing
import { useRef, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'

export function useRandomMorphing(mesh, isActive = true, options = {}) {
  const controllerRef = useRef(null)
  
  // Initialize controller when mesh becomes available
  useEffect(() => {
    if (mesh && mesh.morphTargetInfluences && !controllerRef.current) {
      controllerRef.current = new RandomMorphController(mesh, options)
    }
  }, [mesh, options])
  
  // Update morphing on each frame
  useFrame(() => {
    if (controllerRef.current && isActive) {
      controllerRef.current.update()
    }
  })
  
  // Stop morphing when inactive
  useEffect(() => {
    if (controllerRef.current && !isActive) {
      controllerRef.current.stop()
    }
  }, [isActive])
  
  return {
    controller: controllerRef.current,
    getDebugInfo: () => controllerRef.current?.getDebugInfo() || {}
  }
}
