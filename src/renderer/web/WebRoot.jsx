import React from 'react';
import App from '../App';
import WebGate from './WebGate';

export default function WebRoot() {
  return (
    <WebGate>
      <App />
    </WebGate>
  );
}
