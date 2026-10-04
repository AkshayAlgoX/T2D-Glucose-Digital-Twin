import React, { Component, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props { children: ReactNode; fallbackText?: string; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };
  public static getDerivedStateFromError(error: Error): State { return { hasError: true, error }; }
  
  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center p-4 text-danger border border-danger/20 rounded bg-danger/5">
          <AlertTriangle className="w-4 h-4 mr-2 shrink-0" />
          <span className="text-xs truncate">{this.props.fallbackText || 'Panel Error'}</span>
        </div>
      );
    }
    return this.props.children;
  }
}
