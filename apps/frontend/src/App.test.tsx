import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('Business Hub landing page', () => {
  it('renders the read-only product identity without fake controls', () => {
    render(<App />);

    expect(screen.getByText('BookNowTech')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Business Hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
