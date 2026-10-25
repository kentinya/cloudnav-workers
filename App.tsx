import React from 'react';
import { AppProvider } from './src/contexts/AppProvider';
import { AppLayout } from './src/components/layout/AppLayout';
import { ToastContainer, useToast } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppLayout />
        <ToastWrapper />
      </AppProvider>
    </ErrorBoundary>
  );
}

function ToastWrapper() {
  const { toasts = [], removeToast } = useToast();
  return <ToastContainer toasts={toasts} onRemove={removeToast} />;
}

export default App;
