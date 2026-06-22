import { AnchorWorkerService } from './AnchorWorkerService.js';

export const createAnchorRuntimeService = () => {
  if (typeof window === 'undefined' || typeof Worker !== 'function') {
    throw new Error('Anchor runtime requires a browser Worker');
  }

  return new AnchorWorkerService();
};
