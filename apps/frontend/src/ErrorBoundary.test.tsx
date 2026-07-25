import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary.js';

function BrokenComponent(): never {
  throw new Error('sensitive raw internal failure');
}

describe('ErrorBoundary', () => {
  it('renders only a safe support reference', () => {
    render(
      <ErrorBoundary supportReference="018f-support-reference">
        <BrokenComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'We couldn’t load this page' })).toBeInTheDocument();
    expect(screen.getByText(/018f-support-reference/)).toBeInTheDocument();
    expect(screen.queryByText(/sensitive raw internal failure/)).not.toBeInTheDocument();
  });
});
