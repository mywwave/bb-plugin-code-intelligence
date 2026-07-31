declare module "@bb/plugin-sdk/app" {
  interface ContentScriptContext {
    readonly signal: AbortSignal;
  }

  interface PluginAppBuilder {
    readonly experimental_contentScripts: {
      register(registration: {
        id: string;
        mount(context: ContentScriptContext): void | (() => void | Promise<void>);
      }): void;
    };
  }

  export function definePluginApp(setup: (app: PluginAppBuilder) => void): unknown;
}
