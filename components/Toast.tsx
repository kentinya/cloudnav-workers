import React, { useState, useEffect } from 'react';
import { Check, X, AlertCircle, AlertTriangle, Info } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose?: () => void;
}

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}

const Toast: React.FC<ToastProps> = ({ message, type = 'info', duration = 3000, onClose }) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setIsVisible(false);
        setTimeout(onClose || (() => {}), 300);
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(onClose || (() => {}), 300);
  };

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <Check size={16} className="text-green-500" />;
      case 'error':
        return <X size={16} className="text-red-500" />;
      case 'warning':
        return <AlertTriangle size={16} className="text-yellow-500" />;
      case 'info':
      default:
        return <Info size={16} className="text-blue-500" />;
    }
  };

  const getStyles = () => {
    switch (type) {
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200';
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200';
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200';
      case 'info':
      default:
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200';
    }
  };

  return (
    <div
      className={`
        flex items-center gap-3 p-4 rounded-lg border shadow-lg transition-all duration-300 max-w-md
        ${getStyles()}
        ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}
      `}
    >
      <div className="flex-shrink-0">
        {getIcon()}
      </div>
      <div className="flex-1 text-sm font-medium">
        {message}
      </div>
      <button
        onClick={handleClose}
        className="flex-shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
      >
        <X size={14} className="opacity-60" />
      </button>
    </div>
  );
};

// Toast容器组件
export const ToastContainer: React.FC<{ toasts: ToastItem[]; onRemove: (id: string) => void }> = ({ toasts, onRemove }) => {
  return (
    <div className="fixed top-4 right-4 z-[9999] space-y-2 pointer-events-none">
      <div className="space-y-2 pointer-events-auto">
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            duration={toast.duration}
            onClose={() => onRemove(toast.id)}
          />
        ))}
      </div>
    </div>
  );
};

// 全局Toast管理器
class ToastManager {
  private static instance: ToastManager;
  private listeners: Array<(toasts: ToastItem[]) => void> = [];
  private toasts: ToastItem[] = [];

  static getInstance(): ToastManager {
    if (!ToastManager.instance) {
      ToastManager.instance = new ToastManager();
    }
    return ToastManager.instance;
  }

  subscribe(listener: (toasts: ToastItem[]) => void) {
    this.listeners.push(listener);
    listener(this.toasts);
  }

  unsubscribe(listener: (toasts: ToastItem[]) => void) {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  private notify() {
    this.listeners.forEach(listener => listener(this.toasts));
  }

  add(message: string, type: ToastType = 'info', duration: number = 3000): string {
    const id = Date.now().toString() + Math.random().toString(36);
    const toast: ToastItem = { id, message, type, duration };
    this.toasts.push(toast);
    this.notify();
    return id;
  }

  remove(id: string) {
    this.toasts = this.toasts.filter(toast => toast.id !== id);
    this.notify();
  }

  success(message: string, duration?: number) {
    return this.add(message, 'success', duration);
  }

  error(message: string, duration?: number) {
    return this.add(message, 'error', duration);
  }

  warning(message: string, duration?: number) {
    return this.add(message, 'warning', duration);
  }

  info(message: string, duration?: number) {
    return this.add(message, 'info', duration);
  }
}

// Hook to use Toast in components
export const useToast = () => {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    const manager = ToastManager.getInstance();

    // 初始化时获取当前状态
    const handler = (currentToasts: ToastItem[]) => {
      setToasts([...currentToasts]);
    };

    manager.subscribe(handler);

    return () => {
      manager.unsubscribe(handler);
    };
  }, []);

  const removeToast = React.useCallback((id: string) => {
    ToastManager.getInstance().remove(id);
  }, []);

  const showToast = React.useCallback((message: string, type: ToastType, duration?: number) => {
    return ToastManager.getInstance().add(message, type, duration);
  }, []);

  return {
    toasts,
    removeToast,
    success: (message: string, duration?: number) => showToast(message, 'success', duration),
    error: (message: string, duration?: number) => showToast(message, 'error', duration),
    warning: (message: string, duration?: number) => showToast(message, 'warning', duration),
    info: (message: string, duration?: number) => showToast(message, 'info', duration),
  };
};

// 导出全局实例，用于在非组件中使用
export const toast = ToastManager.getInstance();

export default Toast;