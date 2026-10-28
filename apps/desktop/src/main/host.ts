import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EmptyInputSchema, IPC_CHANNELS, SmokeBatchSchema } from '@operation-agent/contracts';
import { SidecarSupervisor } from './sidecar.js';

export async function startDesktop(options: { stageDirectory: string; dataDirectory: string; show?: boolean }): Promise<{
  window: BrowserWindow; supervisor: SidecarSupervisor; stop(): Promise<void>;
}> {
  const supervisor = new SidecarSupervisor(options.stageDirectory, options.dataDirectory);
  const renderer = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
  const expectedUrl = pathToFileURL(renderer).href;
  const window = new BrowserWindow({ show: options.show ?? true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
    preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const authorize = (event: IpcMainInvokeEvent): void => {
    const frame = event.senderFrame;
    if (stopping || window.isDestroyed() || event.sender !== window.webContents || !frame ||
      frame !== window.webContents.mainFrame || frame.url !== expectedUrl || frame.origin !== 'file://') throw new Error('IPC_SENDER_REJECTED');
  };
  const register = (channel: string, handle: (input: unknown) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      authorize(event);
      if (args.length !== 1) throw new Error('VALIDATION_ERROR');
      try { return await handle(args[0]); }
      catch { throw new Error('CONTROL_PLANE_REQUEST_FAILED'); }
    });
  };
  register(IPC_CHANNELS.health, input => { EmptyInputSchema.parse(input); return supervisor.getHealth(); });
  register(IPC_CHANNELS.listRecords, input => { EmptyInputSchema.parse(input); return supervisor.listRecords(); });
  register(IPC_CHANNELS.writeRecords, input => supervisor.writeRecords(SmokeBatchSchema.parse(input)));
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel);
      await supervisor.stop();
      if (!window.isDestroyed()) window.destroy();
    })();
    return stopPromise;
  };
  try { await supervisor.start(); await window.loadFile(renderer); }
  catch { await stop(); throw new Error('DESKTOP_START_FAILED'); }
  return { window, supervisor, stop };
}
