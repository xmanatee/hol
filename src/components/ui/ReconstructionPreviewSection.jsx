import {
  formatDegrees,
  formatNumber,
  formatPercent,
  formatPoint2,
  formatVector3,
} from './diagnosticFormat.js';
import { DiagnosticRow } from './DiagnosticRow.jsx';
import { isReconstructionMode } from '../../cv/anchor.reconstructionModes.js';

const PREVIEW_WIDTH = 112;
const PREVIEW_HEIGHT = 82;
const EMPTY_POINTS = [];
const EMPTY_SURFACE = { hull: EMPTY_POINTS, edges: EMPTY_POINTS, faces: EMPTY_POINTS, mesh: EMPTY_POINTS };

const normalizePreviewPoints = (points, projector, width = PREVIEW_WIDTH, height = PREVIEW_HEIGHT) => {
  const projected = points.map(point => ({
    id: point.id,
    reliability: point.reliability ?? 0,
    ...projector(point),
  }));
  const xs = projected.map(point => point.x);
  const ys = projected.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(
    width / Math.max(1e-6, maxX - minX),
    height / Math.max(1e-6, maxY - minY)
  );
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;

  return projected.map(point => ({
    id: point.id,
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
    depth: point.depth ?? 0,
    reliability: point.reliability,
  }));
};

const pointTone = reliability => {
  if (reliability >= 0.72) return '#22c55e';
  if (reliability >= 0.52) return '#38bdf8';
  return '#f59e0b';
};

const edgeSegments = (edges, byId) => edges
  .map(edge => ({
    edge,
    from: byId.get(edge.from),
    to: byId.get(edge.to),
  }))
  .filter(segment => segment.from && segment.to);

const facePolygons = (faces, byId) => faces
  .map(face => ({
    face,
    points: face.points.map(pointId => byId.get(pointId)).filter(Boolean),
  }))
  .filter(item => item.points.length >= 3);

const PreviewSvg = ({ title, points, anchor, surface, normal, projector, embedded = false }) => {
  if (!points.length && !(surface.mesh || []).length) {
    return (
      <div className={embedded
        ? 'px-1 py-3 text-center text-[10px] text-gray-500'
        : 'rounded border border-gray-800 bg-gray-950 px-2 py-3 text-center text-[10px] text-gray-500'}
      >
        {title}: no points
      </div>
    );
  }

  const meshPoints = (surface.mesh || []).map(point => ({ ...point, id: `mesh:${point.id}`, meshPoint: true }));
  const meshEdges = (surface.edges || []).map(edge => ({
    ...edge,
    from: `mesh:${edge.from}`,
    to: `mesh:${edge.to}`,
  }));
  const meshFaces = (surface.faces || []).map(face => ({
    ...face,
    points: face.points.map(id => `mesh:${id}`),
  }));
  const meshHull = (surface.hull || []).map(id => `mesh:${id}`);
  const hasMesh = meshPoints.length > 0;
  const faces = hasMesh ? meshFaces : (surface.faces || []);
  const edges = hasMesh ? meshEdges : (surface.edges || []);
  const hull = hasMesh ? meshHull : (surface.hull || []);
  const pointsWithAnchor = anchor ? [...meshPoints, ...points, { ...anchor, id: 'anchor' }] : [...meshPoints, ...points];
  const projectedPoints = normalizePreviewPoints(pointsWithAnchor, projector);
  const anchorPoint = projectedPoints.find(point => point.id === 'anchor');
  const landmarkPoints = projectedPoints.filter(point => point.id !== 'anchor' && !String(point.id).startsWith('mesh:'));
  const byId = new Map(projectedPoints.map(point => [point.id, point]));
  const hullPoints = hull.map(id => byId.get(id)).filter(Boolean);
  const normalEnd = anchorPoint && normal ? {
    x: anchorPoint.x + normal.x * 24,
    y: anchorPoint.y - normal.y * 24,
  } : null;

  return (
    <div className={embedded ? 'px-0 py-1' : 'rounded border border-gray-800 bg-gray-950 px-2 py-2'}>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">{title}</div>
      <svg
        viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
        className={embedded ? 'h-24 w-full bg-black/30' : 'h-24 w-full rounded bg-black'}
      >
        <rect x="0" y="0" width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} fill="#020617" />
        {facePolygons(faces, byId).map(({ face, points: polygonPoints }, index) => (
          <polygon
            key={`${title}:face:${index}`}
            points={polygonPoints.map(point => `${point.x},${point.y}`).join(' ')}
            fill={face.reliability >= 0.68 ? '#115e59' : '#1e293b'}
            opacity={face.reliability >= 0.68 ? '0.28' : '0.16'}
            stroke="#0f766e"
            strokeWidth="0.25"
          />
        ))}
        {hullPoints.length >= 3 && (
          <polygon
            points={hullPoints.map(point => `${point.x},${point.y}`).join(' ')}
            fill="#0f766e"
            opacity="0.16"
            stroke="#14b8a6"
            strokeWidth="0.7"
          />
        )}
        {edgeSegments(edges, byId).map(({ edge, from, to }) => (
          <line
            key={`${edge.from}:${edge.to}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={edge.reliability >= 0.7 ? '#0f766e' : '#334155'}
            strokeWidth="0.55"
            opacity={edge.reliability >= 0.7 ? '0.8' : '0.5'}
          />
        ))}
        {landmarkPoints.map(point => (
          <circle
            key={point.id}
            cx={point.x}
            cy={point.y}
            r="1.7"
            fill={pointTone(point.reliability)}
            opacity="0.88"
          />
        ))}
        {anchorPoint && normalEnd && (
          <line
            x1={anchorPoint.x}
            y1={anchorPoint.y}
            x2={normalEnd.x}
            y2={normalEnd.y}
            stroke="#f8fafc"
            strokeWidth="1.1"
            opacity="0.86"
          />
        )}
        {anchorPoint && (
          <g>
            <circle cx={anchorPoint.x} cy={anchorPoint.y} r="4" fill="none" stroke="#22c55e" strokeWidth="1.4" />
            <circle cx={anchorPoint.x} cy={anchorPoint.y} r="1.6" fill="#22c55e" />
          </g>
        )}
      </svg>
    </div>
  );
};

export const ReconstructionPreviewSection = ({ details, embedded = false }) => {
  const preview = details.reconstructionPreview;
  const current = preview?.current;
  const planar = details.planarTransform ?? current?.planarTransform;
  const normal = details.normal ?? current?.normal;
  const position = details.position ?? current?.anchor;
  const previewPoints = preview?.points ?? EMPTY_POINTS;
  const currentPoints = current?.points ?? EMPTY_POINTS;
  const previewSurface = preview?.surface ?? EMPTY_SURFACE;
  const currentSurface = current?.surface ?? previewSurface;
  const mapConfidence = details.reconstructionMapConfidence ?? preview?.statistics?.mapConfidence;
  const averageSupport = details.reconstructionAverageSupport ?? preview?.statistics?.averageSupport;
  const geometricConsistency = details.reconstructionGeometricConsistency ?? preview?.statistics?.geometricConsistency;
  const matureLandmarks = details.reconstructionMatureLandmarks ?? preview?.statistics?.matureLandmarks ?? 0;
  const totalLandmarks = preview?.landmarkCount ?? details.reconstructionLandmarks ?? 0;

  return (
    <div className={embedded ? 'space-y-2' : 'mt-3 rounded border border-gray-800 bg-gray-950/70 p-2'}>
      {!embedded && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">3D Reconstruction</span>
          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${
            isReconstructionMode(details.poseModel)
              ? 'border-green-700 bg-green-950 text-green-300'
              : 'border-gray-700 bg-gray-900 text-gray-400'
          }`}>
            {isReconstructionMode(details.poseModel) ? 'ON' : 'OFF'}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-1 text-[10px] sm:grid-cols-2">
        <PreviewSvg
          title="Map"
          points={previewPoints}
          anchor={preview?.anchor}
          surface={previewSurface}
          projector={point => ({
            x: point.x - point.z * 0.45,
            y: point.y * 0.35 + point.z * 0.75,
            depth: point.z,
          })}
          embedded={embedded}
        />
        <PreviewSvg
          title="Live"
          points={currentPoints}
          anchor={current?.anchor}
          surface={currentSurface}
          normal={normal}
          projector={point => ({
            x: point.x,
            y: point.y,
            depth: 0,
          })}
          embedded={embedded}
        />
      </div>

      <div className="mt-2 text-[10px]">
        <DiagnosticRow label="Inferred position" value={formatPoint2(position)} tone={position ? 'good' : 'warn'} />
        <DiagnosticRow label="Inferred normal" value={formatVector3(normal)} tone={normal ? 'good' : 'warn'} />
        <DiagnosticRow label="Inferred scale" value={formatNumber(planar?.scale, 2)} tone={planar?.scale ? 'good' : 'warn'} />
        <DiagnosticRow label="Inferred roll" value={formatDegrees(planar?.rotation)} tone={typeof planar?.rotation === 'number' ? 'good' : 'warn'} />
        <DiagnosticRow label="Target class" value={details.targetClass || 'N/A'} tone={details.targetClass ? 'good' : 'warn'} />
        <DiagnosticRow label="Surface model" value={previewSurface.model || 'N/A'} tone={previewSurface.model ? 'good' : 'warn'} />
        <DiagnosticRow label="Depth model" value={details.reconstructionDepthStatus || 'N/A'} tone={details.reconstructionDepthStatus === 'ready' ? 'good' : 'warn'} />
        <DiagnosticRow label="Depth provider" value={details.reconstructionDepthProvider || 'N/A'} />
        <DiagnosticRow label="Depth inference" value={`${formatNumber(details.reconstructionDepthInferenceTime, 1)} ms`} />
        <DiagnosticRow label="Preview points" value={`${previewPoints.length}/${totalLandmarks}`} tone={previewPoints.length >= 18 ? 'good' : 'warn'} />
        <DiagnosticRow label="Map confidence" value={formatPercent(mapConfidence)} tone={(mapConfidence ?? 0) > 0.55 ? 'good' : 'warn'} />
        <DiagnosticRow label="Avg support" value={formatPercent(averageSupport)} tone={(averageSupport ?? 0) > 0.65 ? 'good' : 'warn'} />
        <DiagnosticRow label="Geometry consistency" value={formatPercent(geometricConsistency)} tone={(geometricConsistency ?? 0) > 0.62 ? 'good' : 'warn'} />
        <DiagnosticRow label="Mature points" value={matureLandmarks} tone={matureLandmarks >= 18 ? 'good' : 'warn'} />
        <DiagnosticRow label="Surface edges" value={previewSurface.edges.length} tone={previewSurface.edges.length >= 18 ? 'good' : 'warn'} />
        <DiagnosticRow label="Surface faces" value={previewSurface.faces.length} tone={previewSurface.faces.length >= 12 ? 'good' : 'warn'} />
      </div>
    </div>
  );
};
