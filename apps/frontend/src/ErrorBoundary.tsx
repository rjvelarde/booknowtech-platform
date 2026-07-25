import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  supportReference?: string;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {
    // A client telemetry provider is intentionally deferred. Never render raw error details.
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="error-page" tabIndex={-1}>
          <section className="error-card" aria-labelledby="error-title">
            <p className="eyebrow">BookNowTech Business Hub</p>
            <h1 id="error-title">We couldn’t load this page</h1>
            <p>Please refresh and try again. If the problem continues, contact support.</p>
            {this.props.supportReference ? (
              <p className="support-reference">
                Support reference: <code>{this.props.supportReference}</code>
              </p>
            ) : null}
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
