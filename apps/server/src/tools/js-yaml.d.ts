declare module 'js-yaml' {
  export const FAILSAFE_SCHEMA: object;
  export function load(input: string, options: { schema: object; maxDepth: number }): unknown;
}
