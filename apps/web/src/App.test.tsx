import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('T0 web scaffold (R-31 UI boundary)', () => {
  it('renders Yuno', () => {
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <App />
        </MemoryRouter>,
      ),
    ).toContain('Yuno');
  });
});
