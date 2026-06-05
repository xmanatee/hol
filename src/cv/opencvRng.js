const HOMOGRAPHY_RANSAC_SEED = 0x484f4c;

export const seedHomographyRansac = cv => {
  if (typeof cv.setRNGSeed === 'function') {
    cv.setRNGSeed(HOMOGRAPHY_RANSAC_SEED);
  }
};
