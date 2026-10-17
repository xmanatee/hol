import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FieldControlsHud } from './FieldControlsHud.jsx';
import FieldControlsDialog from './FieldControlsDialog.jsx';
import FeatureBoundary, { FeatureError } from '../FeatureBoundary.jsx';

const FieldControlsDrawer = lazy(() => import('./FieldControlsDrawer.jsx'));

const FieldControlsDrawerStatus = ({ error = null, onOpenChange }) => (
  <FieldControlsDialog busy={error === null} onOpenChange={onOpenChange}>
    <div className="min-h-0 overflow-y-auto p-4">
      {error ? (
        <FeatureError name="Camera controls" error={error} />
      ) : (
        <p role="status" className="text-xs text-gray-300">
          Loading controls…
        </p>
      )}
    </div>
  </FieldControlsDialog>
);

const FieldControls = (props) => {
  const {
    anchorStatus,
    hasActiveAnchor,
    microphoneActive,
    microphoneMode,
    onClearAnchor,
    onMicrophoneModeChange,
    onOpenChange,
    onStopCamera,
    onStopSpeech,
    open,
    ttsData,
  } = props;
  const [activeTab, setActiveTab] = useState('object');
  const triggerRef = useRef(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current.focus();
    }
  }, [open]);

  return (
    <>
      <FieldControlsHud
        anchorStatus={anchorStatus}
        hasActiveAnchor={hasActiveAnchor}
        microphoneMode={microphoneMode}
        microphoneActive={microphoneActive}
        ttsData={ttsData}
        onClearAnchor={onClearAnchor}
        onStopCamera={onStopCamera}
        onStopSpeech={onStopSpeech}
        onMicrophoneModeChange={onMicrophoneModeChange}
        onOpen={() => onOpenChange(true)}
        triggerRef={triggerRef}
        open={open}
      />

      {open && (
        <FeatureBoundary
          name="FieldControls"
          renderError={(error) => <FieldControlsDrawerStatus error={error} onOpenChange={onOpenChange} />}
        >
          <Suspense fallback={<FieldControlsDrawerStatus onOpenChange={onOpenChange} />}>
            <FieldControlsDrawer
              {...props}
              activeTab={activeTab}
              anchorStatus={anchorStatus}
              onActiveTabChange={setActiveTab}
            />
          </Suspense>
        </FeatureBoundary>
      )}
    </>
  );
};

export default FieldControls;
