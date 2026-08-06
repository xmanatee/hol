import { DynamicText } from './FieldControlPrimitives.jsx';

export const PersonalityPanel = ({
  personalityData,
  ttsData,
  onGeneratePersonality,
  onSpeakGreeting,
  hasActiveTrack,
}) => {
  const { isProcessing, currentPersona, error, lastRTT } = personalityData;
  const { isSynthesizing, isPlaying, error: ttsError, lastLatency } = ttsData || {};

  if (!hasActiveTrack) {
    return (
      <div className="text-xs text-gray-400 italic [overflow-wrap:anywhere]">
        Select an object to generate personality
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div role="status" aria-live="polite" className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <div aria-hidden="true" className="w-2 h-2 bg-yellow-400 rounded-full animate-spin"></div>
          <span>Generating personality...</span>
        </div>
      </div>
    );
  }

  if (error) {
    const isConfigError = error.includes('VITE_LOCAL_AI');

    return (
      <div role="alert" className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
        <DynamicText className="block text-xs text-red-400">{error}</DynamicText>

        {isConfigError && (
          <div className="text-xs text-gray-400 bg-gray-800 p-2 rounded">
            Configure the local AI endpoint and model in your .env file to enable personality generation.
          </div>
        )}

        {!isConfigError && (
          <button
            type="button"
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
        <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div aria-hidden="true" className="w-2 h-2 bg-green-400 rounded-full"></div>
            <span className="text-xs font-medium">Personality Generated</span>
            {lastRTT > 0 && <span className="text-xs text-gray-400">({Math.round(lastRTT)}ms)</span>}
          </div>
          <button
            type="button"
            onClick={onGeneratePersonality}
            className="px-2 py-1 bg-purple-600 text-white rounded text-xs hover:bg-purple-700"
          >
            New
          </button>
        </div>

        <div className="min-w-0 space-y-2 text-xs [overflow-wrap:anywhere]">
          <div>
            <span className="text-gray-400">Style:</span>
            <DynamicText className="ml-2 text-blue-300 capitalize">{currentPersona.voiceStyle}</DynamicText>
          </div>

          <div>
            <span className="text-gray-400">Personality:</span>
            <DynamicText className="ml-2 text-gray-200">{currentPersona.tone}</DynamicText>
          </div>

          <div>
            <span className="text-gray-400">Greeting:</span>
            <DynamicText className="ml-2 text-green-300 italic">"{currentPersona.oneLiners[0]}"</DynamicText>
          </div>

          {currentPersona.visionData && (
            <div>
              <span className="text-gray-400">Object:</span>
              <DynamicText className="ml-2 text-gray-300">
                {currentPersona.visionData.category}
                {currentPersona.visionData.brandOrTitle && ` (${currentPersona.visionData.brandOrTitle})`}
              </DynamicText>
            </div>
          )}
        </div>

        {/* TTS Controls */}
        <div className="space-y-2 border-t border-gray-600 pt-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSpeakGreeting}
              disabled={isSynthesizing || isPlaying}
              aria-busy={isSynthesizing}
              className={`px-3 py-1 text-xs rounded font-medium ${
                isSynthesizing || isPlaying
                  ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {isSynthesizing ? 'Synthesizing...' : isPlaying ? 'Playing...' : 'Speak Greeting'}
            </button>

            {(isSynthesizing || isPlaying) && (
              <div aria-hidden="true" className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            )}
          </div>

          {lastLatency > 0 && (
            <div className="text-xs text-gray-400">Last TTS latency: {Math.round(lastLatency)}ms</div>
          )}

          {ttsError && (
            <div role="alert" className="min-w-0 rounded bg-red-900/20 p-1 text-xs text-red-400">
              TTS Error: <DynamicText>{ttsError}</DynamicText>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onGeneratePersonality}
      className="px-3 py-2 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 w-full"
    >
      Generate Personality
    </button>
  );
};
