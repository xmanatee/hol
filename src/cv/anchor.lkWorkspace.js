export const createLucasKanadeWorkspace = (cv) => ({
  previousPoints: new cv.Mat(),
  nextPoints: new cv.Mat(),
  status: new cv.Mat(),
  flowError: new cv.Mat(),
});

export const disposeLucasKanadeWorkspace = (workspace) => {
  for (const matrix of Object.values(workspace)) {
    matrix.delete();
  }
};

export const prepareLucasKanadeWorkspace = (workspace, cv, pointCount) => {
  workspace.previousPoints.create(pointCount, 1, cv.CV_32FC2);
  workspace.nextPoints.create(pointCount, 1, cv.CV_32FC2);
  workspace.status.create(pointCount, 1, cv.CV_8UC1);
  workspace.flowError.create(pointCount, 1, cv.CV_32FC1);
  return workspace;
};
