import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROL_ROUTES, ControlErrorSchema, ControlOverviewSchema, ControlRunListSchema, DesktopStatusSchema, EmptyInputSchema,
  IPC_CHANNELS, ProjectAddResultSchema, ProjectInputSchema, ProjectListSchema, ProjectRefSchema, ProjectSchema, SmokeBatchSchema,
  TaskStartInputSchema, TaskStartResultSchema, WorkbenchSettingsSchema, WORKBENCH_LIMITS } from '@operation-agent/contracts';
import type { DesktopStatus, ProjectAddResult, TaskStartResult, WorkbenchSettings } from '@operation-agent/contracts';
import { SidecarSupervisor } from './sidecar.js';

export async function startDesktop(options: { stageDirectory: string; dataDirectory: string; show?: boolean; requireControlPlane?: boolean }): Promise<{
  window: BrowserWindow; supervisor: SidecarSupervisor; stop(): Promise<void>;
}> {
  const supervisor = new SidecarSupervisor(options.stageDirectory, options.dataDirectory);
  const renderer = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
  const expectedUrl = pathToFileURL(renderer).href;
  Menu.setApplicationMenu(null);
  // The Renderer draws its own 44 px titlebar; Windows keeps native caption buttons as an overlay.
  const chrome = (): { color: string; symbolColor: string; height: number } => nativeTheme.shouldUseDarkColors
    ? { color: '#191918', symbolColor: '#ecebe7', height: 43 } : { color: '#f0eee9', symbolColor: '#1c1b19', height: 43 };
  const window = new BrowserWindow({ show: false, width: 1360, height: 860, minWidth: 960, minHeight: 600, title: 'OperationAgent',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151514' : '#f7f6f3', autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: chrome() } : {}), webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false,
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
    } });
  if (options.show ?? true) window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  const repaintChrome = (): void => { if (process.platform === 'win32' && !window.isDestroyed()) window.setTitleBarOverlay(chrome()); };
  nativeTheme.on('updated', repaintChrome);
  window.once('closed', () => nativeTheme.removeListener('updated', repaintChrome));
  // The saved theme (owned by Express) also drives native chrome and dialogs.
  const applyTheme = (theme: WorkbenchSettings['theme']): void => { nativeTheme.themeSource = theme; };
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
      catch (error) {
        // Only fixed control-plane codes cross to the Renderer; nothing else about the failure does.
        const code = ControlErrorSchema.safeParse(error instanceof Error ? error.message : undefined);
        throw new Error(code.success ? code.data : 'CONTROL_PLANE_REQUEST_FAILED', { cause: error });
      }
    });
  };
  const empty = (input: unknown): void => { EmptyInputSchema.parse(input); };
  const status = (): DesktopStatus => {
    const service = supervisor.snapshot();
    return DesktopStatusSchema.parse({ app: { name: 'OperationAgent', version: app.getVersion(), electron: process.versions.electron,
      platform: process.platform, arch: process.arch, packaged: app.isPackaged },
      service: { state: service.state, restarts: service.restarts, expressRunId: service.expressRunId } });
  };
  register(IPC_CHANNELS.health, async input => { empty(input); return supervisor.getHealth(); });
  register(IPC_CHANNELS.listRecords, async input => { empty(input); return supervisor.listRecords(); });
  register(IPC_CHANNELS.writeRecords, async input => supervisor.writeRecords(SmokeBatchSchema.parse(input)));
  register(IPC_CHANNELS.desktopStatus, async input => { empty(input); return status(); });
  register(IPC_CHANNELS.retryControlPlane, async input => { empty(input); await supervisor.restart().catch(() => {}); return status(); });
  register(IPC_CHANNELS.overview, async input => { empty(input); return supervisor.call('GET', CONTROL_ROUTES.overview, ControlOverviewSchema); });
  register(IPC_CHANNELS.getSettings, async input => {
    empty(input); const settings = await supervisor.call('GET', CONTROL_ROUTES.settings, WorkbenchSettingsSchema); applyTheme(settings.theme); return settings;
  });
  register(IPC_CHANNELS.saveSettings, async input => {
    const settings = await supervisor.call('PUT', CONTROL_ROUTES.settings, WorkbenchSettingsSchema, WorkbenchSettingsSchema.parse(input));
    applyTheme(settings.theme); return settings;
  });
  register(IPC_CHANNELS.listProjects, async input => { empty(input); return supervisor.call('GET', CONTROL_ROUTES.projects, ProjectListSchema); });
  register(IPC_CHANNELS.addProject, async (input): Promise<ProjectAddResult> => {
    empty(input);
    // The folder comes from the native picker in Main, never from the Renderer. Only its path is stored.
    const choice = await dialog.showOpenDialog(window, { title: 'Add project folder', properties: ['openDirectory', 'dontAddToRecent'] });
    const path = choice.filePaths[0];
    if (choice.canceled || !path) return { status: 'cancelled' };
    const project = ProjectInputSchema.parse({ name: (basename(path) || path).slice(0, WORKBENCH_LIMITS.maxNameChars), path });
    return ProjectAddResultSchema.parse({ status: 'added', project: await supervisor.call('POST', CONTROL_ROUTES.projects, ProjectSchema, project) });
  });
  register(IPC_CHANNELS.removeProject, async input => supervisor.call('POST', CONTROL_ROUTES.projectRemove, ProjectListSchema, ProjectRefSchema.parse(input)));
  register(IPC_CHANNELS.listRuns, async input => { empty(input); return supervisor.call('GET', CONTROL_ROUTES.runs, ControlRunListSchema); });
  register(IPC_CHANNELS.startTask, async (input): Promise<TaskStartResult> => {
    try { await supervisor.call('POST', CONTROL_ROUTES.taskStart, TaskStartResultSchema, TaskStartInputSchema.parse(input)); }
    catch (error) {
      if (error instanceof Error && error.message === 'WORKER_ISOLATION_UNAVAILABLE') return { accepted: false, error: 'WORKER_ISOLATION_UNAVAILABLE' };
      throw error;
    }
    throw new Error('CONTROL_PLANE_REQUEST_FAILED');
  });
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel);
      await supervisor.stop();
      if (!window.isDestroyed()) window.destroy();
    })();
    return stopPromise;
  };
  // The window renders immediately and shows the service state; a failed control plane stays visible with Retry.
  const loading = window.loadFile(renderer);
  const ready = await supervisor.start().then(() => true, () => false);
  try { await loading; } catch { await stop(); throw new Error('DESKTOP_START_FAILED'); }
  if (options.requireControlPlane && !ready) { await stop(); throw new Error('DESKTOP_START_FAILED'); }
  return { window, supervisor, stop };
}
