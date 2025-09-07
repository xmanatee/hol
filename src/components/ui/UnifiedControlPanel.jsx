import { useState } from 'react';
import { PersonalityPanel } from './PersonalityPanel.jsx';

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
  onSpeakGreeting
}) => {
  const [isVisible, setIsVisible] = useState(false); // Minimized by default
  const [expandedSections, setExpandedSections] = useState({
    status: false, // Collapsed by default
    controls: true,
    personality: false,
    metrics: false,
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
    <div className="fixed top-4 right-4 w-72 max-h-96 bg-black border border-gray-600 rounded p-3 text-sm z-50 overflow-y-auto pointer-events-auto">
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
        title={`Metrics (${Object.keys(metrics).length})`}
        isExpanded={expandedSections.metrics}
        onToggle={() => toggleSection('metrics')}
      >
        <MetricsSection metrics={metrics} />
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