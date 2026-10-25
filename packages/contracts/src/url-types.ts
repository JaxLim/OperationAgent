// Zod 4's declarations mention the WHATWG URL instance type even for non-URL schemas.
// Supply only its data interface to ES-only consumers, not a constructor, DOM or network globals.
// These members merge with the real DOM/Node URL interface in host projects.
declare global {
  interface URL {
    hash: string;
    host: string;
    hostname: string;
    href: string;
    readonly origin: string;
    password: string;
    pathname: string;
    port: string;
    protocol: string;
    search: string;
    username: string;
    toJSON(): string;
    toString(): string;
  }
}
export {};
