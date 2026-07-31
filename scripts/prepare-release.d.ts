export interface PrepareReleaseOptions {
  build?: () => Promise<void>;
}

export function prepareRelease(
  version: string,
  root?: string,
  options?: PrepareReleaseOptions,
): Promise<void>;
