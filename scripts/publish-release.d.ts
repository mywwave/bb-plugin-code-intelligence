export function assertPublishable(version: string, root?: string): Promise<void>;
export interface PublishReleaseOptions {
  runCommand?: (root: string, command: string, args: string[], options?: { stdio?: "inherit" }) => Promise<unknown>;
}
export function publishRelease(version: string, root?: string, options?: PublishReleaseOptions): Promise<void>;
