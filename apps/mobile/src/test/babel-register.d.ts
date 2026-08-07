declare module "@babel/register" {
  interface RegisterOptions {
    babelrc?: boolean;
    cache?: boolean;
    configFile?: boolean;
    extensions?: string[];
    only?: RegExp[];
    presets?: string[];
  }

  export default function register(options?: RegisterOptions): void;
}
