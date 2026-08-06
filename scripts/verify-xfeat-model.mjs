import { createLaminatedCardSequence, createPlanarBookSequence } from '../src/cv/synthetic/visionFixtures.js';
import { OrbKeyframeRelocalizer } from '../src/cv/anchor.relocalization.js';
import { XFeatKeyframeRelocalizer } from '../src/cv/xfeat.relocalization.js';
import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { createXFeatFeatureExtractorForNode } from '../src/cv/synthetic/xfeatNodeLoader.js';
import { assertXFeatVerificationContract } from '../src/cv/xfeatVerificationContract.js';

const createGrayImage = (cv, imageData) => {
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
};

const isInsideObject = (point, frame) => {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  return frame.objectMask
    ? frame.objectMask.data[y * frame.imageData.width + x] > 0
    : x >= frame.boundingBox.x1 &&
        x <= frame.boundingBox.x2 &&
        y >= frame.boundingBox.y1 &&
        y <= frame.boundingBox.y2;
};

const createReferenceLandmarks = (cv, grayImage, frame) => {
  const detector = new cv.ORB();
  detector.setMaxFeatures(1000);
  detector.setScaleFactor(1.2);
  detector.setNLevels(8);
  detector.setEdgeThreshold(23);
  detector.setPatchSize(23);
  detector.setFastThreshold(6);
  const mask = new cv.Mat();
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  detector.detectAndCompute(grayImage, mask, keypoints, descriptors);
  const candidates = [];
  for (let index = 0; index < keypoints.size(); index++) {
    const keypoint = keypoints.get(index);
    if (isInsideObject(keypoint.pt, frame)) candidates.push(keypoint);
  }
  candidates.sort((left, right) => right.response - left.response);
  const landmarks = candidates.slice(0, 96).map((keypoint, id) => ({
    id,
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 5,
    recentDropout: false,
    original: { x: keypoint.pt.x, y: keypoint.pt.y },
    current: { x: keypoint.pt.x, y: keypoint.pt.y },
    totalSuccessfulFrames: 8,
    successfulTrackingStreak: 8,
    landmarkQuality: 0.9,
    response: keypoint.response,
  }));
  detector.delete();
  mask.delete();
  keypoints.delete();
  descriptors.delete();
  return landmarks;
};

const main = async () => {
  const extractor = await createXFeatFeatureExtractorForNode();
  const frame = createPlanarBookSequence({ frameCount: 2 }).frames[0];
  const startedAt = performance.now();
  const features = await extractor.extract(frame.imageData, 500);
  const inferenceMs = performance.now() - startedAt;
  if (
    features.some(
      (feature) =>
        !Number.isFinite(feature.point.x) ||
        !Number.isFinite(feature.point.y) ||
        feature.descriptor.length !== 64 ||
        !feature.descriptor.every(Number.isFinite),
    )
  ) {
    throw new Error('XFeat produced an invalid keypoint or descriptor');
  }

  const cv = await loadOpenCvForNode();
  const recoverySequence = createLaminatedCardSequence();
  const referenceFrame = recoverySequence.frames[0];
  const queryFrame = recoverySequence.frames[23];
  const referenceGray = createGrayImage(cv, referenceFrame.imageData);
  const queryGray = createGrayImage(cv, queryFrame.imageData);
  const landmarks = createReferenceLandmarks(cv, referenceGray, referenceFrame);
  const orbRelocalizer = new OrbKeyframeRelocalizer();
  const xfeatRelocalizer = new XFeatKeyframeRelocalizer({
    extractFeatures: extractor.extract,
  });
  const orbStorage = orbRelocalizer.storeKeyframe({
    cv,
    grayImage: referenceGray,
    trackedPoints: landmarks,
    anchorPoint: referenceFrame.groundTruth.anchor,
  });
  const xfeatStorage = await xfeatRelocalizer.storeReference({
    imageData: referenceFrame.imageData,
    trackedPoints: landmarks,
    anchorPoint: referenceFrame.groundTruth.anchor,
  });
  const orbRecovery = orbRelocalizer.relocalize(cv, queryGray);
  const xfeatRecovery = await xfeatRelocalizer.relocalize(queryFrame.imageData);
  const xfeatAnchorError = xfeatRecovery.success
    ? Math.hypot(
        xfeatRecovery.anchorPoint.x - queryFrame.groundTruth.anchor.x,
        xfeatRecovery.anchorPoint.y - queryFrame.groundTruth.anchor.y,
      )
    : Infinity;
  if (!orbStorage.success || orbRecovery.success) {
    throw new Error('The learned-recovery contract fixture no longer isolates an ORB consensus failure');
  }
  if (!xfeatStorage.success || !xfeatRecovery.success) {
    throw new Error(
      `XFeat failed the learned-recovery contract: ${xfeatRecovery.reason || `${xfeatAnchorError}px anchor error`}`,
    );
  }
  assertXFeatVerificationContract({
    featureCount: features.length,
    recoveryInlierCount: xfeatRecovery.inlierCount,
    anchorError: xfeatAnchorError,
  });
  referenceGray.delete();
  queryGray.delete();
  orbRelocalizer.dispose();
  xfeatRelocalizer.dispose();
  await extractor.dispose();
  console.log(
    `Verified XFeat with ${features.length} features and ${xfeatRecovery.inlierCount} recovery inliers ` +
      `at ${xfeatAnchorError.toFixed(2)}px anchor error (${inferenceMs.toFixed(2)}ms cold extraction)`,
  );
};

main();
