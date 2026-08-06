export const createHomographyWorkspace = (cv) => ({
  sourcePoints: new cv.Mat(),
  destinationPoints: new cv.Mat(),
  inlierMask: new cv.Mat(),
});

export const prepareHomographyWorkspace = (cv, workspace, pointCount) => {
  workspace.sourcePoints.create(pointCount, 1, cv.CV_32FC2);
  workspace.destinationPoints.create(pointCount, 1, cv.CV_32FC2);
};

export const disposeHomographyWorkspace = (workspace) => {
  workspace.sourcePoints.delete();
  workspace.destinationPoints.delete();
  workspace.inlierMask.delete();
};
