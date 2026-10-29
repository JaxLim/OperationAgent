import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startPolling } from './state';

const root = document.querySelector('#root');
if (!root) throw new Error('RENDERER_ROOT_MISSING');
createRoot(root).render(createElement(App));
startPolling();
