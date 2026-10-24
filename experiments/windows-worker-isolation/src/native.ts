import { createRequire } from 'node:module';

export interface Native {
  identity(pid: number): unknown;
  deriveSid(moniker: string): string;
  grantReadExecute(path: string, sid: string): boolean;
  launch(config: { exe: string; cwd: string; mode: string; moniker: string; leakPath: string; args: string[]; env: Record<string, string> }): unknown;
  read(id: number): { data: Buffer; output: Buffer; eof: boolean; exitCode: number };
  write(id: number, bytes: Buffer): boolean;
  disconnect(id: number): boolean;
  close(id: number): { wait: number; exitCode: number };
  assignJob(pid: number): number;
  probeFile(path: string, mode: string): unknown;
  probeParent(pid: number): unknown;
  probeSpawn(exe: string, breakaway: boolean): unknown;
  probeInheritedHandle(handle: number): unknown;
  probeTcp(host: string, port: number): unknown;
  isAlive(pid: number): boolean;
}
export function loadNative(path: string): Native {
  // This trusted experiment path is fixed by the harness, never received from a Worker.
  return createRequire(import.meta.url)(path) as Native;
}
