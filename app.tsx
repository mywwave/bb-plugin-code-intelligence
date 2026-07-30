import { definePluginApp } from "@bb/plugin-sdk/app";

import { codeNavigationActivityTitle } from "./src/activity-presentation.js";

const TITLE_SELECTOR = ".timeline-row-header span[title]";

function rewriteCodeNavigationTitles(): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(TITLE_SELECTOR))) {
    const replacement = codeNavigationActivityTitle(element.title);
    if (replacement === null || replacement === element.title) continue;
    element.replaceChildren(document.createTextNode(replacement));
    element.title = replacement;
    element.dataset.codeNavigationActivity = "true";
  }
}

/**
 * BB has no timeline-row rendering slot yet. This small, scoped content script
 * keeps the plugin portable: it changes only titles emitted by this plugin's
 * six tools and re-applies after React updates the timeline.
 */
export default definePluginApp((app) => {
  app.experimental_contentScripts.register({
    id: "code-navigation-activity",
    mount({ signal }) {
      let queued = false;
      const schedule = (): void => {
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
    },
  });
});
