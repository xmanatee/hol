export const createAffineHypothesisWorkspace = () => ({
  augmented: new Float64Array(15),
  solution: new Float64Array(6),
  bestSolution: new Float64Array(6),
  score: new Float64Array(2),
});

export const fitAffineHypothesis = (left, middle, right, workspace) => {
  const { augmented, solution } = workspace;
  const leftX = left.reference.x;
  const leftY = left.reference.y;
  const middleX = middle.reference.x;
  const middleY = middle.reference.y;
  const rightX = right.reference.x;
  const rightY = right.reference.y;
  const leftCurrentX = left.current.x;
  const leftCurrentY = left.current.y;
  const middleCurrentX = middle.current.x;
  const middleCurrentY = middle.current.y;
  const rightCurrentX = right.current.x;
  const rightCurrentY = right.current.y;

  augmented[0] = leftX * leftX + middleX * middleX + rightX * rightX + 1e-6;
  augmented[1] = leftX * leftY + middleX * middleY + rightX * rightY;
  augmented[2] = leftX + middleX + rightX;
  augmented[3] = leftX * leftCurrentX + middleX * middleCurrentX + rightX * rightCurrentX;
  augmented[4] = leftX * leftCurrentY + middleX * middleCurrentY + rightX * rightCurrentY;

  augmented[5] = leftY * leftX + middleY * middleX + rightY * rightX;
  augmented[6] = leftY * leftY + middleY * middleY + rightY * rightY + 1e-6;
  augmented[7] = leftY + middleY + rightY;
  augmented[8] = leftY * leftCurrentX + middleY * middleCurrentX + rightY * rightCurrentX;
  augmented[9] = leftY * leftCurrentY + middleY * middleCurrentY + rightY * rightCurrentY;

  augmented[10] = leftX + middleX + rightX;
  augmented[11] = leftY + middleY + rightY;
  augmented[12] = 3 + 1e-6;
  augmented[13] = leftCurrentX + middleCurrentX + rightCurrentX;
  augmented[14] = leftCurrentY + middleCurrentY + rightCurrentY;

  for (let pivot = 0; pivot < 3; pivot++) {
    let bestRow = pivot;
    for (let candidateRow = pivot + 1; candidateRow < 3; candidateRow++) {
      if (Math.abs(augmented[candidateRow * 5 + pivot]) > Math.abs(augmented[bestRow * 5 + pivot])) {
        bestRow = candidateRow;
      }
    }
    if (Math.abs(augmented[bestRow * 5 + pivot]) < 1e-9) {
      return false;
    }

    if (bestRow !== pivot) {
      for (let column = 0; column < 5; column++) {
        const pivotIndex = pivot * 5 + column;
        const bestIndex = bestRow * 5 + column;
        const value = augmented[pivotIndex];
        augmented[pivotIndex] = augmented[bestIndex];
        augmented[bestIndex] = value;
      }
    }

    const divisor = augmented[pivot * 5 + pivot];
    for (let column = pivot; column < 5; column++) {
      augmented[pivot * 5 + column] /= divisor;
    }
    for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
      if (rowIndex === pivot) continue;
      const factor = augmented[rowIndex * 5 + pivot];
      for (let column = pivot; column < 5; column++) {
        augmented[rowIndex * 5 + column] -= factor * augmented[pivot * 5 + column];
      }
    }
  }

  for (let index = 0; index < 3; index++) {
    solution[index] = augmented[index * 5 + 3];
    solution[index + 3] = augmented[index * 5 + 4];
  }
  return true;
};

export const scoreAffineHypothesis = (observations, transform, residualThreshold, score) => {
  const rowX0 = transform[0];
  const rowX1 = transform[1];
  const rowX2 = transform[2];
  const rowY0 = transform[3];
  const rowY1 = transform[4];
  const rowY2 = transform[5];
  const squaredRejectionThreshold = residualThreshold * residualThreshold * (1 + Number.EPSILON * 8);
  let inlierCount = 0;
  let residualSum = 0;

  for (const observation of observations) {
    const projectedX = rowX0 * observation.reference.x + rowX1 * observation.reference.y + rowX2;
    const projectedY = rowY0 * observation.reference.x + rowY1 * observation.reference.y + rowY2;
    const residualX = projectedX - observation.current.x;
    const residualY = projectedY - observation.current.y;
    if (
      Math.abs(residualX) > residualThreshold ||
      Math.abs(residualY) > residualThreshold ||
      residualX * residualX + residualY * residualY > squaredRejectionThreshold
    ) {
      continue;
    }

    const residual = Math.hypot(residualX, residualY);
    if (residual <= residualThreshold) {
      inlierCount++;
      residualSum += residual;
    }
  }

  score[0] = inlierCount;
  score[1] = inlierCount ? residualSum / inlierCount : Infinity;
};
