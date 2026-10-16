import { Component } from 'react';
import { logger } from '../utils/logger.js';
import { DynamicText } from './ui/FieldControlPrimitives.jsx';

export const FeatureError = ({ name, error }) => (
  <div role="alert" className="min-w-0 space-y-2 text-sm text-red-100">
    <p className="font-semibold">{name} unavailable</p>
    <DynamicText className="block text-xs">{error.message}</DynamicText>
    <p className="text-xs">Reload the app to retry. This stops the camera.</p>
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="min-h-11 rounded-md border border-red-400/40 bg-red-950 px-3 text-sm hover:bg-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      Reload app
    </button>
  </div>
);

class FeatureBoundary extends Component {
  state = null;

  static getDerivedStateFromError(error) {
    return { error: error instanceof Error ? error : new Error(String(error), { cause: error }) };
  }

  componentDidCatch(error) {
    logger.error(this.props.name, 'Feature failed:', error);
  }

  render() {
    return this.state ? this.props.renderError(this.state.error) : this.props.children;
  }
}

export default FeatureBoundary;
