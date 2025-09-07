export const PersonalityPanel = ({ personalityData, ttsData, onGeneratePersonality, onSpeakGreeting, hasActiveTrack }) => {
  const { isProcessing, currentPersona, error, lastRTT } = personalityData;
  const { isSynthesizing, isPlaying, error: ttsError, lastLatency } = ttsData || {};

  if (!hasActiveTrack) {
    return (
      <div className="text-xs text-gray-500 italic">
        Select an object to generate personality
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <div className="w-2 h-2 bg-yellow-400 rounded-full animate-spin"></div>
          <span>Generating personality...</span>
        </div>
      </div>
    );
  }

  if (error) {
    const isConfigError = error.includes('API key') || error.includes('environment variables');
    
    return (
      <div className="space-y-2">
        <div className="text-xs text-red-400">{error}</div>
        
        {isConfigError && (
          <div className="text-xs text-gray-400 bg-gray-800 p-2 rounded">
            Add VITE_OPENAI_API_KEY to your .env file to enable personality generation.
          </div>
        )}
        
        {!isConfigError && (
          <button
            onClick={onGeneratePersonality}
            className="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (currentPersona) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-400 rounded-full"></div>
            <span className="text-xs font-medium">Personality Generated</span>
            {lastRTT > 0 && (
              <span className="text-xs text-gray-400">({Math.round(lastRTT)}ms)</span>
            )}
          </div>
          <button
            onClick={onGeneratePersonality}
            className="px-2 py-1 bg-purple-600 text-white rounded text-xs hover:bg-purple-700"
          >
            New
          </button>
        </div>

        <div className="space-y-2 text-xs">
          <div>
            <span className="text-gray-400">Style:</span>
            <span className="ml-2 text-blue-300 capitalize">{currentPersona.voiceStyle}</span>
          </div>

          <div>
            <span className="text-gray-400">Personality:</span>
            <span className="ml-2 text-gray-200">{currentPersona.tone}</span>
          </div>

          <div>
            <span className="text-gray-400">Greeting:</span>
            <span className="ml-2 text-green-300 italic">"{currentPersona.oneLiners[0]}"</span>
          </div>

          {currentPersona.visionData && (
            <div>
              <span className="text-gray-400">Object:</span>
              <span className="ml-2 text-gray-300">
                {currentPersona.visionData.category}
                {currentPersona.visionData.brandOrTitle && ` (${currentPersona.visionData.brandOrTitle})`}
              </span>
            </div>
          )}
        </div>

        {/* TTS Controls */}
        <div className="space-y-2 border-t border-gray-600 pt-2">
          <div className="flex items-center gap-2">
            <button
              onClick={onSpeakGreeting}
              disabled={isSynthesizing || isPlaying}
              className={`px-3 py-1 text-xs rounded font-medium ${
                isSynthesizing || isPlaying
                  ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {isSynthesizing ? 'Synthesizing...' : isPlaying ? 'Playing...' : 'Speak Greeting'}
            </button>
            
            {(isSynthesizing || isPlaying) && (
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            )}
          </div>

          {lastLatency > 0 && (
            <div className="text-xs text-gray-500">
              Last TTS latency: {Math.round(lastLatency)}ms
            </div>
          )}

          {ttsError && (
            <div className="text-xs text-red-400 bg-red-900/20 p-1 rounded">
              TTS Error: {ttsError}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={onGeneratePersonality}
      className="px-3 py-2 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 w-full"
    >
      Generate Personality
    </button>
  );
};