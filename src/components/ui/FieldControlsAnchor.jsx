import { useMemo, useSyncExternalStore } from 'react';
import { collectAnchorDetails } from '../../utils/anchorDiagnostics.js';
import { DiagnosticRow } from './DiagnosticRow.jsx';
import { DrawerSection, DynamicText } from './FieldControlPrimitives.jsx';
import { ReconstructionPreviewSection } from './ReconstructionPreviewSection.jsx';
import { formatNumber, formatPercent, formatRegion } from './diagnosticFormat.js';
import { cx } from './uiClassNames.js';

const AnchorDiagnostics = ({ diagnostics }) => {
  const details = diagnostics.details;
  const refreshCoverage =
    details.landmarkRefreshCoverageCellCount != null
      ? ` · cells ${details.landmarkRefreshOccupiedBefore}→${details.landmarkRefreshOccupiedAfter}/${details.landmarkRefreshCoverageCellCount}`
      : '';
  const refreshValue = details.landmarkRefreshReason
    ? `${details.landmarkRefreshReason} +${details.landmarkRefreshAdded ?? 0}/${details.landmarkRefreshTotal ?? 0}${refreshCoverage}`
    : 'idle';
  const supportValue =
    details.segmentationRefreshStatus !== 'idle'
      ? [
          details.segmentationRefreshStatus,
          details.segmentationRefreshTrigger,
          details.segmentationRefreshOutcomeReason,
          details.segmentationRefreshMaskSource,
        ]
          .filter(Boolean)
          .join(' · ')
      : details.segmentationRefreshReason
        ? `${details.segmentationRefreshReason} @ ${details.segmentationRefreshFrame ?? 'N/A'}`
        : 'idle';
  const supportTone =
    details.segmentationRefreshStatus === 'accepted'
      ? 'good'
      : details.segmentationRefreshStatus === 'fallback'
        ? 'warn'
        : details.segmentationRefreshStatus === 'rejected'
          ? 'bad'
          : 'neutral';
  const normalRejectionValue =
    Object.entries(details.normalPoseRejectedCandidates)
      .map(([source, reason]) => `${source}: ${reason}`)
      .join(' · ') || 'N/A';

  return (
    <div className="space-y-1 text-xs">
      <div
        className={cx(
          'mb-2 rounded-md border px-2 py-2',
          diagnostics.severity === 'good'
            ? 'border-emerald-600 bg-emerald-950/60 text-emerald-100'
            : diagnostics.severity === 'bad'
              ? 'border-red-600 bg-red-950/60 text-red-100'
              : diagnostics.severity === 'warn'
                ? 'border-yellow-600 bg-yellow-950/60 text-yellow-100'
                : 'border-white/10 bg-white/5 text-gray-200',
        )}
      >
        <DynamicText className="block font-medium">{diagnostics.message}</DynamicText>
        <DynamicText className="mt-1 block text-[10px] opacity-75">{diagnostics.recommendation}</DynamicText>
      </div>
      <DiagnosticRow label="Status" value={diagnostics.status} tone={diagnostics.severity} />
      <DiagnosticRow
        label="Keypoints"
        value={details.keypointCount}
        tone={details.keypointCount >= 12 ? 'good' : 'warn'}
      />
      <DiagnosticRow
        label="Object landmarks"
        value={details.objectOwnedLandmarks}
        tone={details.objectOwnedLandmarks >= 8 ? 'good' : 'warn'}
      />
      <DiagnosticRow
        label="Mask coverage"
        value={formatPercent(details.maskCoverage)}
        tone={(details.maskCoverage ?? 0) > 0.03 ? 'good' : 'warn'}
      />
      <DiagnosticRow label="Mask source" value={details.objectSupportMaskSource || 'N/A'} />
      <DiagnosticRow label="Surface" value={details.surfacePrior || details.surfaceModel || 'N/A'} />
      <DiagnosticRow
        label="Surface coverage"
        value={formatPercent(details.surfaceCoverage)}
        tone={(details.surfaceCoverage ?? 0) > 0.45 ? 'good' : 'warn'}
      />
      <DiagnosticRow
        label="Silhouette"
        value={formatPercent(details.silhouetteCoverage)}
        tone={(details.silhouetteCoverage ?? 0) > 0.35 ? 'good' : 'warn'}
      />
      <DiagnosticRow
        label="Contour residual"
        value={formatNumber(details.contourFitResidual, 1)}
        tone={(details.contourFitResidual ?? 0) <= 5 ? 'good' : 'warn'}
      />
      <DiagnosticRow
        label="Locked landmarks"
        value={details.surfaceLockedLandmarks}
        tone={details.surfaceLockedLandmarks >= 12 ? 'good' : 'warn'}
      />
      <DiagnosticRow
        label="Occlusion"
        value={details.occlusionState || 'N/A'}
        tone={details.occlusionState === 'visible' ? 'good' : 'warn'}
      />
      <DiagnosticRow label="Support refresh" value={supportValue} tone={supportTone} />
      <DiagnosticRow
        label="Landmark refresh"
        value={refreshValue}
        tone={details.landmarkRefreshAdded > 0 ? 'good' : 'neutral'}
      />
      <DiagnosticRow label="Rejected by mask" value={details.landmarkRefreshRejectedByMask} />
      <DiagnosticRow label="Tracking success" value={formatPercent(details.trackingSuccessRate)} />
      <DiagnosticRow label="Pose model" value={details.poseModel || 'auto'} />
      <DiagnosticRow label="Pose source" value={details.poseSource || 'N/A'} />
      <DiagnosticRow label="Position candidate" value={details.posePositionCandidateSource || 'N/A'} />
      <DiagnosticRow label="Normal candidate" value={details.poseNormalCandidateSource || 'N/A'} />
      <DiagnosticRow label="Attachment candidate" value={details.poseAttachmentCandidateSource || 'N/A'} />
      <DiagnosticRow label="Overlay candidate" value={details.poseOverlayCandidateSource || 'N/A'} />
      <DiagnosticRow
        label="Position owner"
        value={
          details.posePositionRole ? `${details.posePositionRole} · ${details.posePositionReason}` : 'N/A'
        }
      />
      <DiagnosticRow
        label="Normal owner"
        value={details.poseNormalRole ? `${details.poseNormalRole} · ${details.poseNormalReason}` : 'N/A'}
      />
      <DiagnosticRow label="Normal rejection" value={normalRejectionValue} />
      <DiagnosticRow
        label="Pose rejection"
        value={details.poseRejectedReason || details.poseSourceHoldReason || 'N/A'}
      />
      <DiagnosticRow
        label="3D map"
        value={details.reconstructionState || 'inactive'}
        tone={details.reconstructionReady ? 'good' : 'warn'}
      />
      <DiagnosticRow label="3D landmarks" value={details.reconstructionLandmarks} />
      <DiagnosticRow
        label="3D rejection"
        value={details.reconstructionPoseRejectedReason || details.reconstructionFailureReason || 'N/A'}
      />
      <DiagnosticRow label="Processing" value={`${formatNumber(details.processingTime, 1)} ms`} />
      <DiagnosticRow label="Template region" value={formatRegion(details.templateRegion)} />
      <DiagnosticRow label="Tracking region" value={formatRegion(details.trackingRegion)} />
      <DiagnosticRow
        label="Support bounds"
        value={formatRegion(details.currentObjectSupportMaskBounds || details.objectSupportMaskBounds)}
      />
    </div>
  );
};

export const FieldControlsAnchor = ({
  anchorStatus,
  anchorSystemState,
  anchorTrackingMode,
  depthStateStore,
}) => {
  const depthState = useSyncExternalStore(depthStateStore.subscribe, depthStateStore.getSnapshot);
  const anchorDiagnostics = useMemo(
    () => ({
      ...anchorStatus,
      details: collectAnchorDetails({
        anchorState: anchorSystemState.anchorState,
        segmentationRefresh: anchorSystemState.segmentationRefresh,
      }),
    }),
    [anchorStatus, anchorSystemState.anchorState, anchorSystemState.segmentationRefresh],
  );

  return (
    <>
      <DrawerSection title="Anchor">
        <AnchorDiagnostics diagnostics={anchorDiagnostics} />
      </DrawerSection>
      <DrawerSection title="3D reconstruction">
        <ReconstructionPreviewSection
          details={{
            ...anchorDiagnostics.details,
            poseModel: anchorDiagnostics.details.poseModel || anchorTrackingMode,
            reconstructionDepthStatus:
              anchorDiagnostics.details.reconstructionDepthStatus ?? depthState.state,
            reconstructionDepthProvider:
              anchorDiagnostics.details.reconstructionDepthProvider ?? depthState.provider,
            reconstructionDepthInferenceTime:
              anchorDiagnostics.details.reconstructionDepthInferenceTime ?? depthState.processingTime,
          }}
          embedded
        />
      </DrawerSection>
    </>
  );
};
