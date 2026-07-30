import { describe, expect, it } from "vitest";

import { readProjectPath } from "../src/project-path.js";

/** Copied from a live `bb project list --json` payload. */
const realProject = {
  id: "proj_gggmytijti",
  kind: "standard",
  name: "Bambi",
  gitRemoteUrl: "https://github.com/Modelion/Bambi.git",
  sources: [
    {
      id: "src_u37u9vc8h5",
      projectId: "proj_gggmytijti",
      type: "local_path",
      hostId: "host_rq8z7qjg4x",
      path: "/Users/mywwave/VSprojects/Bambi",
      isDefault: true,
    },
  ],
};

describe("readProjectPath", () => {
  it("reads the path out of sources, where it actually lives", () => {
    // `project.path` does not exist. Reading it returned undefined for every
    // project, so the tool reported "no repository configured" always.
    expect(readProjectPath(realProject)).toBe("/Users/mywwave/VSprojects/Bambi");
    expect((realProject as { path?: string }).path).toBeUndefined();
  });

  it("prefers the default source over the first one", () => {
    expect(
      readProjectPath({
        sources: [
          { type: "local_path", path: "/secondary" },
          { type: "local_path", path: "/primary", isDefault: true },
        ],
      }),
    ).toBe("/primary");
  });

  it("skips sources that are not local paths", () => {
    // A remote source belongs to another host; scanning it would index the
    // wrong disk.
    expect(
      readProjectPath({
        sources: [
          { type: "remote", path: "/on/another/host" },
          { type: "local_path", path: "/here" },
        ],
      }),
    ).toBe("/here");
  });

  it("selects only the source belonging to the thread host", () => {
    const project = {
      sources: [
        { type: "local_path", hostId: "host-a", path: "/workspace-a", isDefault: true },
        { type: "local_path", hostId: "host-b", path: "/workspace-b" },
      ],
    };

    expect(readProjectPath(project, "host-b")).toBe("/workspace-b");
    expect(readProjectPath(project, "host-missing")).toBeNull();
  });

  it("returns null rather than guessing", () => {
    expect(readProjectPath(null)).toBeNull();
    expect(readProjectPath(undefined)).toBeNull();
    expect(readProjectPath({})).toBeNull();
    expect(readProjectPath({ sources: [] })).toBeNull();
    expect(readProjectPath({ sources: [{ type: "local_path", path: "" }] })).toBeNull();
  });
});
