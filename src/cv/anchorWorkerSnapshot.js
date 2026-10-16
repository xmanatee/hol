const createMaskMetadata = (mask) => {
  const metadata = { ...mask };
  delete metadata.data;
  return metadata;
};

const createActiveAnchorSnapshot = (activeAnchor) => {
  const objectSupportMask = activeAnchor?.selectionRegion?.objectSupportMask;
  if (!objectSupportMask) {
    return activeAnchor;
  }

  return {
    ...activeAnchor,
    selectionRegion: {
      ...activeAnchor.selectionRegion,
      objectSupportMask: createMaskMetadata(objectSupportMask),
    },
  };
};

export const createAnchorWorkerSnapshot = (state) =>
  state
    ? {
        ...state,
        activeAnchor: createActiveAnchorSnapshot(state.activeAnchor),
      }
    : null;
