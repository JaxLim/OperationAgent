// Only the narrow loader used for the fixed, package-relative Node-API artifact. No Node globals.
declare module 'node:module' {
  export function createRequire(path: string): (id: string) => unknown;
}
interface ImportMeta { readonly url: string }
