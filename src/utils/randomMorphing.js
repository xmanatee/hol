export class RandomMorphController {
  constructor(mesh, options = {}) {
    this.mesh = mesh
    this.options = {
      intensity: 0.15,           // Maximum morph intensity (0-1)
      waveSpeed: 0.3,            // Speed of continuous wave motion
      phaseOffset: 1.7,          // Phase offset between morph targets
      blinkInterval: 4000,       // Base time between blinks (ms)
      blinkVariation: 2000,      // Random variation in blink timing (ms)
      blinkIntensity: 0.8,       // Blink intensity (0-1)
      blinkDuration: 150,        // Blink duration (ms)
      ...options
    }
    
    // State tracking for continuous waves
    this.startTime = Date.now()
    this.morphPhases = []
    this.morphFrequencies = []
    this.morphAmplitudes = []
    
    // Generate unique wave parameters for each morph target
    for (let i = 0; i < this.mesh.morphTargetInfluences.length; i++) {
      this.morphPhases.push(Math.random() * Math.PI * 2) // Random starting phase
      this.morphFrequencies.push(0.5 + Math.random() * 1.5) // Frequency multiplier (0.5-2.0)
      this.morphAmplitudes.push(0.3 + Math.random() * 0.7) // Amplitude multiplier (0.3-1.0)
    }
    
    // Blink tracking
    this.lastBlinkTime = 0
    this.nextBlinkTime = this.getNextBlinkTime()
    this.isBlinking = false
    this.blinkStartTime = 0
    
    // Identify potential blink morph targets (usually at the end of the list)
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
    
    // If no named blink targets found, assume they're in the last few indices
    if (indices.length === 0) {
      const totalMorphs = this.mesh.morphTargetInfluences.length
      for (let i = Math.max(0, totalMorphs - 3); i < totalMorphs; i++) {
        indices.push(i)
      }
    }
    
    return indices
  }
  
  getNextBlinkTime() {
    return Date.now() + this.options.blinkInterval + Math.random() * this.options.blinkVariation
  }
  
  calculateContinuousMorphValues(currentTime) {
    const elapsedTime = (currentTime - this.startTime) * 0.001 // Convert to seconds
    const morphValues = []
    
    // Generate continuous wave-based morph values for ALL morph targets
    for (let i = 0; i < this.mesh.morphTargetInfluences.length; i++) {
      if (this.blinkIndices.includes(i)) {
        // Skip blink morphs - they're handled separately
        morphValues.push(0)
        continue
      }
      
      // Create unique wave for each morph target
      const phase = this.morphPhases[i] + (i * this.options.phaseOffset)
      const frequency = this.morphFrequencies[i] * this.options.waveSpeed
      const amplitude = this.morphAmplitudes[i]
      
      // Combine multiple wave functions for more complex motion
      const primary = Math.sin(elapsedTime * frequency + phase)
      const secondary = Math.sin(elapsedTime * frequency * 1.618 + phase * 0.618) * 0.3 // Golden ratio for natural feel
      const tertiary = Math.sin(elapsedTime * frequency * 0.382 + phase * 1.618) * 0.1
      
      const combinedWave = primary + secondary + tertiary
      
      // Convert from [-1,1] to [0,1] range and apply intensity and amplitude
      const normalizedValue = (combinedWave + 1) * 0.5
      const finalValue = normalizedValue * this.options.intensity * amplitude
      
      morphValues.push(Math.max(0, Math.min(1, finalValue))) // Clamp to valid range
    }
    
    return morphValues
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
    
    // Calculate continuous morph values
    const morphValues = this.calculateContinuousMorphValues(currentTime)
    
    // Handle blinking
    if (currentTime >= this.nextBlinkTime && !this.isBlinking) {
      this.startBlink(currentTime)
    }
    this.updateBlink(currentTime)
    
    for (let i = 0; i < this.mesh.morphTargetInfluences.length; i++) {
      if (this.isBlinking && this.blinkIndices.includes(i)) {
        continue
      }
      this.mesh.morphTargetInfluences[i] = morphValues[i]
    }
  }
  
  stop() {
    for (let i = 0; i < this.mesh.morphTargetInfluences.length; i++) {
      if (!this.blinkIndices.includes(i)) {
        this.mesh.morphTargetInfluences[i] = 0
      }
    }
  }
  
  getDebugInfo() {
    const morphValues = this.calculateContinuousMorphValues(Date.now())
    return {
      nextBlinkTime: this.nextBlinkTime - Date.now(),
      isBlinking: this.isBlinking,
      activeTargets: morphValues.filter(v => v > 0.01).length,
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
