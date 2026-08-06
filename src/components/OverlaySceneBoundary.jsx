import { Component } from 'react';
import { logger } from '../utils/logger.js';

class OverlaySceneBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    logger.error('OverlayScene', '3D overlay failed:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded border border-red-700 bg-red-950 px-3 py-2 text-xs text-red-100">
          3D overlay unavailable
        </div>
      );
    }

    return this.props.children;
  }
}

export default OverlaySceneBoundary;
