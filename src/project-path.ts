/**
 * Reads a repository path out of a bb project.
 *
 * The path is NOT a top-level field. A project carries a list of sources:
 *
 *     { id, name, sources: [{ type: "local_path", path, isDefault, hostId }] }
 *
 * Reading `project.path` — the shape one would guess — silently yields
 * undefined, which made the tool report "no repository path configured" for
 * every project. This is the second place in this plugin where an invented
 * shape for an external contract passed review and tests; both were found only
 * by printing the real payload.
 */

export interface ProjectSource {
  readonly type?: string;
  readonly path?: string;
  readonly isDefault?: boolean;
  readonly hostId?: string;
}

export interface ProjectLike {
  readonly path?: string;
  readonly sources?: readonly ProjectSource[];
}

/**
 * Prefers the default local source on the requested host, falls back to the
 * first usable source on that same host.
 *
 * Remote sources are skipped: this plugin scans the server's own filesystem, so
 * a path belonging to another host would be indexed from the wrong disk.
 */
export function readProjectPath(project: ProjectLike | null | undefined, hostId?: string): string | null {
  if (project === null || project === undefined) return null;

  const sources = Array.isArray(project.sources) ? project.sources : [];
  const local = sources.filter(
    (source) => source.type === "local_path" && typeof source.path === "string" && source.path !== "",
  );
  const routed = hostId === undefined ? local : local.filter((source) => source.hostId === hostId);

  const preferred = routed.find((source) => source.isDefault === true) ?? routed[0];
  if (preferred !== undefined) return preferred.path!;

  // A flat path has no host ownership, so it cannot safely stand in for a
  // source selected by a remote thread.
  if (hostId !== undefined) return null;

  // Tolerated as a fallback in case the DTO ever grows a flat field.
  if (typeof project.path === "string" && project.path !== "") return project.path;
  return null;
}
