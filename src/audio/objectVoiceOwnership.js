export const ownsObjectVoiceRequest = ({ requestId, currentRequestId, anchorCreatedAt, activeAnchor }) =>
  requestId === currentRequestId && activeAnchor?.createdAt === anchorCreatedAt;
