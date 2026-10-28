import express from 'express';
import type { Express } from 'express';

// Compile-ready control-plane module. Listening/authentication/database are P1.2/P1.3.
export function createControlPlane(): Express {
  const app = express();
  app.disable('x-powered-by');
  // No HTTP routes or readiness response exists before authenticated P1.2/P1.3 startup.
  return app;
}
