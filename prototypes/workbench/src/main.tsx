import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { store } from './sim/store';
import './styles/app.css';

// Apply the saved theme before the first paint to avoid a light flash in dark mode.
const { theme, density } = store.getState().settings;
if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme);
document.documentElement.setAttribute('data-density', density);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
