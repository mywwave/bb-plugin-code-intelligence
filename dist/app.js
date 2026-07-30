// bb-plugin-runtime-shim:@bb/plugin-sdk/app
var runtime = globalThis.__bbPluginRuntime;
if (runtime == null || runtime.pluginSdkApp == null) {
  throw new Error('Cannot load "@bb/plugin-sdk/app": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod = runtime.pluginSdkApp;
var {
  definePluginApp,
  experimental_Markdown,
  experimental_ThreadChat,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings
} = mod;

// src/activity-presentation.ts
var ACTIVITY_WORDS = {
  instant_grep: {
    completed: "Searched code",
    pending: "Searching code",
    targetKind: "pattern"
  },
  codebase_query: {
    completed: "Explored codebase",
    pending: "Exploring codebase",
    targetKind: "pattern"
  },
  symbol_lookup: {
    completed: "Inspected symbol",
    pending: "Inspecting symbol",
    targetKind: "symbol"
  },
  code_graph_context: {
    completed: "Mapped code context",
    pending: "Mapping code context",
    targetKind: "none"
  },
  repository_context: {
    completed: "Read project overview",
    pending: "Reading project overview",
    targetKind: "none"
  },
  prechange_impact: {
    completed: "Checked change impact",
    pending: "Checking change impact",
    targetKind: "symbol"
  },
  verify_change: {
    completed: "Verified change",
    pending: "Verifying change",
    targetKind: "symbol"
  }
};
function titleTarget(argumentsText, kind) {
  if (kind === "none") return null;
  const pattern = /(?:pattern|query):\s*([^,}]+)/u.exec(argumentsText)?.[1]?.trim();
  const target = /targets:\s*\[\s*["']?([^,"'\]}]+)/u.exec(argumentsText)?.[1]?.trim();
  const value = kind === "pattern" ? pattern : target;
  if (!value) return null;
  if (kind === "symbol") {
    const symbol = value.split("#")[1];
    return symbol && symbol.length > 0 ? symbol : value.split("/").filter(Boolean).pop() ?? value;
  }
  return value;
}
function codeNavigationActivityTitle(rawTitle) {
  const suffixMatch = /\s+(\([^)]*\))$/u.exec(rawTitle);
  const suffix = suffixMatch?.[1] ? ` ${suffixMatch[1]}` : "";
  const body = suffixMatch ? rawTitle.slice(0, suffixMatch.index) : rawTitle;
  const match = /^(Ran tool|Running tool:)\s+([a-z_]+)(?:\s+\{([\s\S]*)\})?$/u.exec(body);
  if (!match) return null;
  const words = ACTIVITY_WORDS[match[2] ?? ""];
  if (!words) return null;
  const target = titleTarget(match[3] ?? "", words.targetKind);
  const verb = match[1] === "Running tool:" ? words.pending : words.completed;
  return `${verb}${target ? ` ${target}` : ""}${suffix}`;
}

// app.tsx
var TITLE_SELECTOR = ".timeline-row-header span[title]";
function rewriteCodeNavigationTitles() {
  for (const element of Array.from(document.querySelectorAll(TITLE_SELECTOR))) {
    const replacement = codeNavigationActivityTitle(element.title);
    if (replacement === null || replacement === element.title) continue;
    element.replaceChildren(document.createTextNode(replacement));
    element.title = replacement;
    element.dataset.codeNavigationActivity = "true";
  }
}
var app_default = definePluginApp((app) => {
  app.experimental_contentScripts.register({
    id: "code-navigation-activity",
    mount({ signal }) {
      let queued = false;
      const schedule = () => {
        if (queued || signal.aborted) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          rewriteCodeNavigationTitles();
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
      return () => observer.disconnect();
    }
  });
});
export {
  app_default as default
};
