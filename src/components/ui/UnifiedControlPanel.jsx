import { useState, useEffect } from 'react';
import { PersonalityPanel } from './PersonalityPanel.jsx';
import { logger } from '../../utils/logger.js';

const CollapsibleSection = ({ title, isExpanded, onToggle, children }) => (
  <div className="mb-2 border border-gray-600 rounded">
    <button
      onClick={onToggle}
      className="w-full px-3 py-2 bg-gray-800 text-white border-0 text-sm cursor-pointer flex justify-between items-center hover:bg-gray-700"
    >
      <span>{title}</span>
      <span className="text-xs text-gray-400">
        {isExpanded ? '▲' : '▼'}
      </span>
    </button>
    {isExpanded && (
      <div className="p-3 bg-gray-900">
        {children}
      </div>
    )}
  </div>
);

const MetricsSection = ({ metrics }) => (
  <div className="grid grid-cols-1 gap-1 max-h-48 overflow-y-auto">
    {Object.entries(metrics).map(([name, metric]) => (
      <div
        key={name}
        className={`px-2 py-1 text-xs border-l-2 ${
          metric.isRed 
            ? 'text-red-400 border-red-500 bg-red-900' 
            : 'text-green-400 border-green-500 bg-green-900'
        }`}
      >
        <div className="text-white text-xs">
          {name}
        </div>
        <div className="text-gray-300">
          {metric.value !== null ? `${typeof metric.value === 'number' ? metric.value.toFixed(1) : metric.value} ${metric.unit}` : 'N/A'}
        </div>
      </div>
    ))}
  </div>
);

const ControlsSection = ({
  showStats,
  activeTrackId,
  onToggleStats,
  onUnlock,
  onStop
}) => (
  <div className="flex gap-2 flex-wrap">
    <button
      onClick={onToggleStats}
      className="px-2 py-1 text-xs bg-gray-700 text-white border border-gray-600 rounded cursor-pointer hover:bg-gray-600"
    >
      {showStats ? 'Hide Debug' : 'Show Debug'}
    </button>
    
    {activeTrackId && (
      <button
        onClick={onUnlock}
        className="px-2 py-1 text-xs bg-orange-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-orange-500"
      >
        Unlock #{activeTrackId}
      </button>
    )}
    
    <button
      onClick={onStop}
      className="px-2 py-1 text-xs bg-red-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-red-500"
    >
      Stop
    </button>
  </div>
);

const StatusSection = ({
  cameraState,
  detectionInitialized,
  isModelLoaded,
  detectionError,
  trackedObjects,
  activeTrackId
}) => (
  <div className="text-xs text-gray-300">
    <div className="grid grid-cols-2 gap-1 mb-2">
      <div>
        Camera: <span className={cameraState === 'active' ? 'text-green-400' : 'text-red-400'}>
          {cameraState.toUpperCase()}
        </span>
      </div>
      <div>
        Detection: <span className={detectionInitialized ? 'text-green-400' : 'text-yellow-400'}>
          {detectionInitialized ? '✓' : '⏳'}
        </span>
      </div>
      <div>
        Model: <span className={isModelLoaded ? 'text-green-400' : 'text-yellow-400'}>
          {isModelLoaded ? '✓' : '⏳'}
        </span>
      </div>
      <div>
        Objects: <span className={trackedObjects.length > 0 ? 'text-green-400' : 'text-gray-500'}>
          {trackedObjects.length}
        </span>
      </div>
    </div>
    
    {detectionError && (
      <div className="p-1 bg-red-600/20 border border-red-400 rounded text-[10px] text-red-400 mb-2">
        Error: {detectionError}
      </div>
    )}
    
    {activeTrackId && (
      <div className="p-1 bg-yellow-600/20 border border-yellow-400 rounded text-[10px] text-yellow-400">
        Locked on track #{activeTrackId}
      </div>
    )}
    
    {cameraState === 'active' && trackedObjects.length > 0 && !activeTrackId && (
      <div className="p-1 bg-blue-600/20 border border-blue-400 rounded text-[10px] text-blue-400">
        💡 Tap on a bottle or cup to select it
      </div>
    )}
  </div>
);

const LogsSection = () => {
  const [discoveredTags, setDiscoveredTags] = useState([]);
  const [enabledTags, setEnabledTags] = useState([]);

  useEffect(() => {
    const updateTags = (discovered, enabled) => {
      setDiscoveredTags(discovered);
      setEnabledTags(enabled);
    };

    updateTags(logger.getAllTags(), logger.getEnabledTags());
    
    const removeListener = logger.addListener(updateTags);
    return removeListener;
  }, []);

  const handleTagToggle = (tag) => {
    logger.toggleTag(tag);
  };

  const handleEnableAll = () => {
    discoveredTags.forEach(tag => logger.enableTag(tag));
  };

  const handleDisableAll = () => {
    discoveredTags.forEach(tag => logger.disableTag(tag));
  };

  return (
    <div className="text-xs">
      <div className="flex gap-2 mb-2">
        <button
          onClick={handleEnableAll}
          className="px-2 py-1 text-[10px] bg-green-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-green-500"
        >
          Enable All
        </button>
        <button
          onClick={handleDisableAll}
          className="px-2 py-1 text-[10px] bg-red-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-red-500"
        >
          Disable All
        </button>
      </div>
      
      <div className="max-h-32 overflow-y-auto">
        {discoveredTags.length === 0 ? (
          <div className="text-gray-400 text-[10px]">
            No log tags discovered yet. Tags appear as code executes.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-1">
            {discoveredTags.map(tag => (
              <label key={tag} className="flex items-center text-gray-300 hover:text-white">
                <input
                  type="checkbox"
                  checked={enabledTags.includes(tag)}
                  onChange={() => handleTagToggle(tag)}
                  className="mr-1.5"
                />
                <span className="text-[10px] font-mono">{tag}</span>
                {enabledTags.includes(tag) && (
                  <span className="ml-auto text-green-400 text-[8px]">✓</span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
      
      <div className="mt-2 pt-2 border-t border-gray-700 text-[10px] text-gray-400">
        Note: Error logs always show regardless of tag settings
      </div>
    </div>
  );
};

const MeshControlsSection = ({ discoveredMeshes, hiddenMeshes, onMeshVisibilityChange, onRotationChange }) => {
  const [rotation, setRotation] = useState({ x: 0, y: 0, z: 0 });

  const handleToggle = (meshName) => {
    const isCurrentlyVisible = !hiddenMeshes.has(meshName);
    onMeshVisibilityChange(meshName, !isCurrentlyVisible);
  };

  const handleShowAll = () => {
    discoveredMeshes.forEach(meshName => {
      onMeshVisibilityChange(meshName, true);
    });
  };

  const handleHideAll = () => {
    discoveredMeshes.forEach(meshName => {
      onMeshVisibilityChange(meshName, false);
    });
  };

  const handleRotationChange = (axis, value) => {
    const newRotation = { ...rotation, [axis]: value };
    setRotation(newRotation);
    onRotationChange?.(newRotation);
  };

  const resetRotation = () => {
    const resetRot = { x: 0, y: 0, z: 0 };
    setRotation(resetRot);
    onRotationChange?.(resetRot);
  };

  if (discoveredMeshes.length === 0) {
    return (
      <div className="text-xs text-gray-400">
        No meshes discovered yet. Meshes will appear when the 3D model loads.
      </div>
    );
  }

  return (
    <div className="text-xs">
      <div className="flex gap-2 mb-2">
        <button
          onClick={handleShowAll}
          className="px-2 py-1 text-[10px] bg-green-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-green-500"
        >
          Show All
        </button>
        <button
          onClick={handleHideAll}
          className="px-2 py-1 text-[10px] bg-red-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-red-500"
        >
          Hide All
        </button>
      </div>

      {/* Rotation Controls */}
      <div className="mb-3 pb-2 border-b border-gray-700">
        <div className="flex justify-between items-center mb-2">
          <span className="text-gray-300 text-[10px] font-medium">Manual Rotation</span>
          <button
            onClick={resetRotation}
            className="px-1.5 py-0.5 text-[9px] bg-gray-600 text-white border border-gray-500 rounded cursor-pointer hover:bg-gray-500"
          >
            Reset
          </button>
        </div>
        
        {['x', 'y', 'z'].map(axis => (
          <div key={axis} className="mb-1">
            <label className="block text-gray-300 mb-0.5 text-[10px]">
              {axis.toUpperCase()}: {(rotation[axis] * 180 / Math.PI).toFixed(0)}°
            </label>
            <input
              type="range"
              min={-Math.PI}
              max={Math.PI}
              step={0.1}
              value={rotation[axis]}
              onChange={(e) => handleRotationChange(axis, parseFloat(e.target.value))}
              className="w-full h-1"
            />
          </div>
        ))}
      </div>
      
      <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
        {discoveredMeshes.map(meshName => (
          <label key={meshName} className="flex items-center text-gray-300">
            <input
              type="checkbox"
              checked={!hiddenMeshes.has(meshName)}
              onChange={() => handleToggle(meshName)}
              className="mr-1.5"
            />
            <span className="font-mono text-[10px]">{meshName}</span>
            {!hiddenMeshes.has(meshName) && (
              <span className="ml-auto text-green-400 text-[8px]">✓</span>
            )}
          </label>
        ))}
      </div>
      
      <div className="mt-2 pt-2 border-t border-gray-700 text-[10px] text-gray-400">
        {discoveredMeshes.length} mesh{discoveredMeshes.length !== 1 ? 'es' : ''} discovered
      </div>
    </div>
  );
};

const MicrophoneSection = ({ 
  microphoneMode, 
  onToggleMicrophoneMode, 
  voiceActivityThreshold, 
  onVoiceActivityThresholdChange,
  microphoneActive,
  currentViseme,
  audioEnergy,
  isVoiceActive,
  // New props for enhanced microphone control
  onMicrophoneGainChange,
  onToggleMicrophoneDebug,
  onResetMicrophoneBaseline,
  microphoneGain = 3.0,
  microphoneDebugMode = true
}) => {
  return (
    <div className="text-xs">
      <div className="flex flex-col gap-2">
        <label className="flex items-center text-gray-300">
          <input
            type="checkbox"
            checked={microphoneMode}
            onChange={(e) => onToggleMicrophoneMode?.(e.target.checked)}
            className="mr-1.5"
          />
          Enable microphone mode
        </label>
        
        {microphoneMode && (
          <>
            <div className="ml-4 p-2 bg-gray-800 border border-gray-600 rounded">
              <div className="text-[10px] text-gray-400 mb-1">Voice Activity Threshold</div>
              <input
                type="range"
                min="0.005"
                max="0.2"
                step="0.005"
                value={voiceActivityThreshold}
                onChange={(e) => onVoiceActivityThresholdChange?.(parseFloat(e.target.value))}
                className="w-full h-1"
              />
              <div className="text-[10px] text-gray-300 text-center">
                {(voiceActivityThreshold * 1000).toFixed(0)}‰
              </div>
            </div>

            <div className="ml-4 p-2 bg-gray-800 border border-gray-600 rounded">
              <div className="text-[10px] text-gray-400 mb-1">Microphone Gain</div>
              <input
                type="range"
                min="0.5"
                max="10"
                step="0.5"
                value={microphoneGain}
                onChange={(e) => onMicrophoneGainChange?.(parseFloat(e.target.value))}
                className="w-full h-1"
              />
              <div className="text-[10px] text-gray-300 text-center">
                {microphoneGain.toFixed(1)}x
              </div>
            </div>

            <div className="ml-4 flex gap-2">
              <button
                onClick={() => onToggleMicrophoneDebug?.(!microphoneDebugMode)}
                className={`px-2 py-1 text-[10px] rounded ${
                  microphoneDebugMode 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-600 text-gray-300'
                }`}
              >
                Debug: {microphoneDebugMode ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => onResetMicrophoneBaseline?.()}
                className="px-2 py-1 text-[10px] bg-yellow-600 text-white rounded hover:bg-yellow-700"
              >
                Reset Baseline
              </button>
            </div>

            <div className="ml-4 p-2 bg-gray-800 border border-gray-600 rounded">
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  Status: <span className={microphoneActive ? 'text-green-400' : 'text-gray-400'}>
                    {microphoneActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div>
                  Voice: <span className={isVoiceActive ? 'text-green-400' : 'text-gray-400'}>
                    {isVoiceActive ? 'Active' : 'Silent'}
                  </span>
                </div>
                <div>
                  Energy: <span className="text-blue-400">
                    {audioEnergy ? (audioEnergy * 100).toFixed(0) : 0}%
                  </span>
                </div>
                <div>
                  Viseme: <span className="text-yellow-400 font-mono">
                    {currentViseme || 'M'}
                  </span>
                </div>
              </div>
              
              <div className="mt-2 h-2 bg-gray-700 rounded overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-green-600 to-green-400 transition-all duration-150"
                  style={{ width: `${(audioEnergy || 0) * 100}%` }}
                />
              </div>
              
              <div className="mt-1 text-[10px] text-gray-400 text-center">
                Audio Level
              </div>
            </div>
            
            <div className="ml-4 text-[10px] text-blue-400">
              💡 Speak into your microphone to see the head react in real-time
            </div>
          </>
        )}
        
        {!microphoneMode && (
          <div className="ml-4 text-[10px] text-gray-400">
            Enable microphone mode to test lip-sync without ElevenLabs
          </div>
        )}
      </div>
    </div>
  );
};

const ConfigSection = ({ onConfigChange, currentConfig, needsRestart, onRestart }) => {
  const [detectionInterval, setDetectionInterval] = useState(4);
  const [showSparkles, setShowSparkles] = useState(true);
  const [normalEstimation, setNormalEstimation] = useState(true);
  const [useWorkerPersistence, setUseWorkerPersistence] = useState(currentConfig?.useWorkerPersistence || false);
  
  return (
    <div className="text-xs">
      <div className="mb-2">
        <label className="block text-gray-300 mb-0.5">
          Detection Interval: {detectionInterval} frames
        </label>
        <input
          type="range"
          min="1"
          max="8"
          value={detectionInterval}
          onChange={(e) => {
            const value = parseInt(e.target.value);
            setDetectionInterval(value);
            onConfigChange?.({ detectionInterval: value });
          }}
          className="w-full"
        />
      </div>
      
      <div className="flex flex-col gap-1">
        <label className="flex items-center text-gray-300">
          <input
            type="checkbox"
            checked={showSparkles}
            onChange={(e) => {
              setShowSparkles(e.target.checked);
              onConfigChange?.({ showSparkles: e.target.checked });
            }}
            className="mr-1.5"
          />
          Show sparkles for stable anchors
        </label>
        
        <label className="flex items-center text-gray-300">
          <input
            type="checkbox"
            checked={normalEstimation}
            onChange={(e) => {
              setNormalEstimation(e.target.checked);
              onConfigChange?.({ normalEstimation: e.target.checked });
            }}
            className="mr-1.5"
          />
          Enable normal estimation
        </label>

        <label className="flex items-center text-gray-300">
          <input
            type="checkbox"
            checked={useWorkerPersistence}
            onChange={(e) => {
              setUseWorkerPersistence(e.target.checked);
              onConfigChange?.({ useWorkerPersistence: e.target.checked });
            }}
            className="mr-1.5"
          />
          Use worker-based persistence (OpenCV)
        </label>
        
        {useWorkerPersistence && !needsRestart && (
          <div className="ml-4 text-green-400 text-[10px]">
            ✓ Worker persistence enabled
          </div>
        )}
        
        {needsRestart && (
          <div className="ml-4 mt-2">
            <div className="text-yellow-400 text-[10px] mb-1">
              ⚠️ Configuration changed - restart recommended
            </div>
            <button
              onClick={onRestart}
              className="px-2 py-1 text-xs bg-blue-600 text-white border border-gray-600 rounded cursor-pointer hover:bg-blue-500"
            >
              Restart Camera System
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const UnifiedControlPanel = ({
  cameraState,
  detectionInitialized,
  isModelLoaded,
  detectionError,
  trackedObjects,
  activeTrackId,
  showStats,
  onToggleStats,
  onUnlock,
  onStop,
  onConfigChange,
  onRestart,
  needsRestart,
  currentConfig,
  metrics,
  personalityData,
  ttsData,
  onGeneratePersonality,
  onSpeakGreeting,
  discoveredMeshes,
  hiddenMeshes,
  onMeshVisibilityChange,
  onRotationChange,
  // Microphone props
  microphoneMode = false,
  onToggleMicrophoneMode,
  voiceActivityThreshold = 0.02,
  onVoiceActivityThresholdChange,
  microphoneActive = false,
  currentViseme = 'M',
  audioEnergy = 0,
  isVoiceActive = false,
  // Enhanced microphone controls
  onMicrophoneGainChange,
  onToggleMicrophoneDebug,
  onResetMicrophoneBaseline,
  microphoneGain = 3.0,
  microphoneDebugMode = true
}) => {
  const [isVisible, setIsVisible] = useState(false); // Minimized by default
  const [expandedSections, setExpandedSections] = useState({
    status: false, // Collapsed by default
    controls: true,
    microphone: false,
    personality: false,
    meshControls: false,
    metrics: false,
    logs: false,
    config: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  if (!isVisible) {
    return (
      <button
        onClick={() => setIsVisible(true)}
        className="fixed top-4 right-4 z-50 px-3 py-2 text-sm bg-gray-800 text-white border border-gray-600 rounded cursor-pointer hover:bg-gray-700 transition-all duration-200"
      >
        Controls
      </button>
    );
  }

  return (
    <div className="fixed top-4 right-4 w-72 max-h-full bg-black border border-gray-600 rounded p-3 text-sm z-50 overflow-y-auto pointer-events-auto">
      <div className="flex justify-between items-center mb-3 pb-2 border-b border-gray-600">
        <div>
          <h3 className="text-base font-medium text-white">
            Control Panel
          </h3>
          {currentConfig?.useWorkerPersistence && (
            <div className="text-xs text-blue-400">
              Worker Persistence Mode
            </div>
          )}
          {needsRestart && (
            <div className="text-xs text-yellow-400 animate-pulse">
              ⚠️ Restart Needed
            </div>
          )}
        </div>
        <button
          onClick={() => setIsVisible(false)}
          className="px-2 py-1 text-xs bg-gray-700 text-white border border-gray-600 rounded cursor-pointer hover:bg-gray-600"
        >
          Hide
        </button>
      </div>

      <CollapsibleSection
        title="Status"
        isExpanded={expandedSections.status}
        onToggle={() => toggleSection('status')}
      >
        <StatusSection
          cameraState={cameraState}
          detectionInitialized={detectionInitialized}
          isModelLoaded={isModelLoaded}
          detectionError={detectionError}
          trackedObjects={trackedObjects}
          activeTrackId={activeTrackId}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Controls"
        isExpanded={expandedSections.controls}
        onToggle={() => toggleSection('controls')}
      >
        <ControlsSection
          showStats={showStats}
          activeTrackId={activeTrackId}
          onToggleStats={onToggleStats}
          onUnlock={onUnlock}
          onStop={onStop}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title={`Microphone ${microphoneMode ? '(Active)' : ''}`}
        isExpanded={expandedSections.microphone}
        onToggle={() => toggleSection('microphone')}
      >
        <MicrophoneSection
          microphoneMode={microphoneMode}
          onToggleMicrophoneMode={onToggleMicrophoneMode}
          voiceActivityThreshold={voiceActivityThreshold}
          onVoiceActivityThresholdChange={onVoiceActivityThresholdChange}
          microphoneActive={microphoneActive}
          currentViseme={currentViseme}
          audioEnergy={audioEnergy}
          isVoiceActive={isVoiceActive}
          onMicrophoneGainChange={onMicrophoneGainChange}
          onToggleMicrophoneDebug={onToggleMicrophoneDebug}
          onResetMicrophoneBaseline={onResetMicrophoneBaseline}
          microphoneGain={microphoneGain}
          microphoneDebugMode={microphoneDebugMode}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Personality"
        isExpanded={expandedSections.personality}
        onToggle={() => toggleSection('personality')}
      >
        <PersonalityPanel
          personalityData={personalityData}
          ttsData={ttsData}
          onGeneratePersonality={onGeneratePersonality}
          onSpeakGreeting={onSpeakGreeting}
          hasActiveTrack={!!activeTrackId}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Mesh Controls"
        isExpanded={expandedSections.meshControls}
        onToggle={() => toggleSection('meshControls')}
      >
        <MeshControlsSection
          discoveredMeshes={discoveredMeshes}
          hiddenMeshes={hiddenMeshes}
          onMeshVisibilityChange={onMeshVisibilityChange}
          onRotationChange={onRotationChange}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title={`Metrics (${Object.keys(metrics).length})`}
        isExpanded={expandedSections.metrics}
        onToggle={() => toggleSection('metrics')}
      >
        <MetricsSection metrics={metrics} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Logs"
        isExpanded={expandedSections.logs}
        onToggle={() => toggleSection('logs')}
      >
        <LogsSection />
      </CollapsibleSection>

      <CollapsibleSection
        title="Configuration"
        isExpanded={expandedSections.config}
        onToggle={() => toggleSection('config')}
      >
        <ConfigSection 
          onConfigChange={onConfigChange}
          currentConfig={currentConfig}
          needsRestart={needsRestart}
          onRestart={onRestart}
        />
      </CollapsibleSection>
    </div>
  );
};

export default UnifiedControlPanel;