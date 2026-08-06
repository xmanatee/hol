import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { describeAnchorStatus } from '../../utils/anchorStatus.js';
import { FieldControlsHud } from './FieldControlsHud.jsx';

const FieldControlsDrawer = lazy(() => import('./FieldControlsDrawer.jsx'));

const FieldControlsDrawerLoading = ({ onClose }) => {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    closeButtonRef.current.focus();
  }, []);

  return (
    <div
      id="field-controls-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="field-controls-loading-title"
      aria-busy="true"
      className="fixed inset-x-0 bottom-0 z-50 flex min-h-32 flex-col rounded-t-xl border border-white/10 bg-black/90 pb-[env(safe-area-inset-bottom)] text-white shadow-2xl backdrop-blur-xl md:inset-y-3 md:left-auto md:right-3 md:w-[24rem] md:rounded-xl md:pb-0"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0" role="status" aria-live="polite">
          <h2 id="field-controls-loading-title" className="text-sm font-semibold">
            Field controls
          </h2>
          <p className="mt-1 text-xs text-gray-300">Loading controls…</p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close debug drawer"
          onClick={onClose}
          className="ml-auto min-h-11 rounded-md border border-white/10 bg-white/5 px-3 text-sm hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          Close
        </button>
      </div>
    </div>
  );
};

const FieldControls = (props) => {
  const {
    anchorSystemState,
    cameraState,
    hasActiveAnchor,
    microphoneActive,
    microphoneMode,
    onClearAnchor,
    onMicrophoneModeChange,
    onOpenChange,
    onStopCamera,
    open,
    ttsData,
  } = props;
  const [activeTab, setActiveTab] = useState('anchor');
  const triggerRef = useRef(null);
  const wasOpenRef = useRef(false);
  const anchorStatus = useMemo(
    () => describeAnchorStatus({ cameraState, anchorSystemState }),
    [cameraState, anchorSystemState],
  );

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
        onMicrophoneModeChange={onMicrophoneModeChange}
        onOpen={() => onOpenChange(true)}
        triggerRef={triggerRef}
        open={open}
      />

      {open && (
        <Suspense fallback={<FieldControlsDrawerLoading onClose={() => onOpenChange(false)} />}>
          <FieldControlsDrawer
            {...props}
            activeTab={activeTab}
            anchorStatus={anchorStatus}
            onActiveTabChange={setActiveTab}
          />
        </Suspense>
      )}
    </>
  );
};

export default FieldControls;
