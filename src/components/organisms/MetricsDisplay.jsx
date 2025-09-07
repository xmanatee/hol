import React from 'react';
import { useHudMetrics } from '../../hooks/useHudMetrics.js';

const MetricsDisplay = () => {
  const { metrics } = useHudMetrics();

  return (
    <div style={{
      position: 'fixed',
      top: '10px',
      right: '10px',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      color: 'white',
      padding: '10px',
      borderRadius: '5px',
      fontFamily: 'monospace',
      fontSize: '14px',
      zIndex: 1000,
    }}>
      <h3>HUD Metrics</h3>
      {
        Object.entries(metrics).map(([name, data]) => (
          <div key={name} style={{ color: data.isRed ? 'red' : 'white' }}>
            <strong>{name}:</strong> {data.value !== null ? `${data.value.toFixed(2)} ${data.unit}` : 'N/A'}
          </div>
        ))
      }
    </div>
  );
};

export default MetricsDisplay;
