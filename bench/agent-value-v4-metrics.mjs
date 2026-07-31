export const PLUGIN_TOOL_NAMES = new Set([
  "instant_grep",
  "codebase_query",
  "repository_context",
  "symbol_lookup",
  "code_graph_context",
  "prechange_impact",
  "verify_change",
]);

const SHELL_SEARCH = /\b(?:rg|grep|find|fd|sed|awk|git\s+grep)\b/;

function itemNames(item) {
  return [
    item?.tool,
    item?.toolName,
    item?.name,
    item?.tool?.name,
    item?.function?.name,
    item?.serverToolName,
    item?.commandName,
  ].filter((value) => typeof value === "string");
}

function scopeTurnId(event) {
  return event?.scope?.kind === "turn" && typeof event.scope.turnId === "string"
    ? event.scope.turnId
    : null;
}

function bySequence(left, right) {
  const leftSeq = Number.isFinite(left?.seq) ? left.seq : Number.POSITIVE_INFINITY;
  const rightSeq = Number.isFinite(right?.seq) ? right.seq : Number.POSITIVE_INFINITY;
  return leftSeq - rightSeq;
}

function mergeDuration(intervals) {
  if (intervals.length === 0) return 0;
  const merged = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.start > previous.end) {
      merged.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged.reduce((total, interval) => total + interval.end - interval.start, 0);
}

function finalAnswer(events) {
  return events
    .filter(
      (event) =>
        event.type === "item/completed" &&
        event.data?.item?.type === "agentMessage" &&
        typeof event.data.item.text === "string",
    )
    .at(-1)?.data.item.text ?? "";
}

function blankTiming() {
  return {
    turnTimelineMs: null,
    nativePluginTimelineMs: null,
    shellSearchTimelineMs: null,
    reasoningTimelineMs: null,
    classifiedTimelineMs: null,
    unaccountedTurnTimelineMs: null,
  };
}

/**
 * Extracts observational event-timeline intervals from one completed BB turn.
 * These values are not CPU profiles and do not prove causality between a tool
 * call and full-turn latency.
 */
export function collectAgentValueV4Metrics(rawEvents, expected) {
  const events = rawEvents
    .filter((event) => event !== null && typeof event === "object")
    .sort(bySequence);
  const completedTurns = events.filter(
    (event) => event.type === "turn/completed" && scopeTurnId(event) !== null,
  );
  const selectedCompleted = completedTurns.at(-1);
  const selectedTurnId = selectedCompleted === undefined ? null : scopeTurnId(selectedCompleted);
  const selected = selectedTurnId === null
    ? []
    : events.filter((event) => scopeTurnId(event) === selectedTurnId);
  const answer = finalAnswer(selected);
  const normalizedAnswer = answer.toLowerCase();
  const correct =
    typeof expected?.pathIncludes === "string" &&
    normalizedAnswer.includes(expected.pathIncludes.toLowerCase()) &&
    Array.isArray(expected.requiredTerms) &&
    expected.requiredTerms.every(
      (term) => typeof term === "string" && normalizedAnswer.includes(term.toLowerCase()),
    );

  const diagnostics = {
    unmatchedStartedIds: [],
    orphanCompletedIds: [],
    duplicateStartedIds: [],
    typeMismatchIds: [],
    invalidTimestampIds: [],
    zeroDurationIds: [],
  };
  const starts = new Map();
  const pairs = [];

  for (const event of selected) {
    if (event.type !== "item/started" && event.type !== "item/completed") continue;
    const item = event.data?.item;
    if (item === null || typeof item !== "object" || typeof item.id !== "string" || typeof item.type !== "string") continue;
    if (event.type === "item/started") {
      if (starts.has(item.id)) {
        diagnostics.duplicateStartedIds.push(item.id);
        continue;
      }
      starts.set(item.id, { event, item });
      continue;
    }

    const started = starts.get(item.id);
    if (started === undefined) {
      diagnostics.orphanCompletedIds.push(item.id);
      continue;
    }
    starts.delete(item.id);
    if (started.item.type !== item.type) {
      diagnostics.typeMismatchIds.push(item.id);
      continue;
    }
    if (!Number.isFinite(started.event.createdAt) || !Number.isFinite(event.createdAt) || event.createdAt < started.event.createdAt) {
      diagnostics.invalidTimestampIds.push(item.id);
      pairs.push({ item, start: started.event.createdAt, end: event.createdAt, invalid: true });
      continue;
    }
    pairs.push({ item, start: started.event.createdAt, end: event.createdAt, invalid: false });
  }
  diagnostics.unmatchedStartedIds.push(...starts.keys());

  const nativePairs = pairs.filter(
    (pair) => pair.item.type === "toolCall" && itemNames(pair.item).some((name) => PLUGIN_TOOL_NAMES.has(name)),
  );
  const shellPairs = pairs.filter(
    (pair) => pair.item.type === "commandExecution" && SHELL_SEARCH.test(pair.item.command ?? ""),
  );
  const reasoningPairs = pairs.filter((pair) => pair.item.type === "reasoning");
  const collapsed = (pairs) => pairs.filter((pair) => pair.end === pair.start);
  const nativeCollapsed = collapsed(nativePairs);
  const shellCollapsed = collapsed(shellPairs);
  const reasoningCollapsed = collapsed(reasoningPairs);
  diagnostics.zeroDurationIds.push(...[...nativeCollapsed, ...shellCollapsed, ...reasoningCollapsed].map((pair) => pair.item.id));
  const unobservableTimelineChannels = [
    nativeCollapsed.length > 0 ? "nativePlugin" : null,
    shellCollapsed.length > 0 ? "shellSearch" : null,
    reasoningCollapsed.length > 0 ? "reasoning" : null,
  ].filter((channel) => channel !== null);
  const completedDiscoveryOperations = nativePairs.length + shellPairs.length;
  const turnStarted = selected.find((event) => event.type === "turn/started");
  const turnCompleted = selected.find((event) => event.type === "turn/completed");
  const invalid =
    selectedTurnId === null ||
    turnStarted === undefined ||
    turnCompleted === undefined ||
    !Number.isFinite(turnStarted?.createdAt) ||
    !Number.isFinite(turnCompleted?.createdAt) ||
    turnCompleted.createdAt < turnStarted.createdAt ||
    diagnostics.unmatchedStartedIds.length > 0 ||
    diagnostics.orphanCompletedIds.length > 0 ||
    diagnostics.duplicateStartedIds.length > 0 ||
    diagnostics.typeMismatchIds.length > 0 ||
    diagnostics.invalidTimestampIds.length > 0;

  const timingStatus = selectedTurnId === null || turnStarted === undefined || turnCompleted === undefined
    ? "incomplete"
    : invalid
      ? "invalid"
      : "complete";
  const common = {
    metricsVersion: "v4",
    selectedTurnId,
    timingStatus,
    pairedItemCount: pairs.length,
    ...diagnostics,
    correct,
    finalAnswerPresent: answer.length > 0,
    completedDiscoveryOperations,
    nativePluginCalls: nativePairs.length,
    shellSearchCalls: shellPairs.length,
    unobservableTimelineChannels,
  };
  if (timingStatus !== "complete") return { ...common, ...blankTiming() };

  const nativePluginTimelineMs = nativeCollapsed.length > 0 ? null : mergeDuration(nativePairs.map(({ start, end }) => ({ start, end })));
  const shellSearchTimelineMs = shellCollapsed.length > 0 ? null : mergeDuration(shellPairs.map(({ start, end }) => ({ start, end })));
  const reasoningTimelineMs = reasoningCollapsed.length > 0 ? null : mergeDuration(reasoningPairs.map(({ start, end }) => ({ start, end })));
  const classifiedTimelineMs = unobservableTimelineChannels.length > 0 ? null : mergeDuration([
    ...nativePairs,
    ...shellPairs,
    ...reasoningPairs,
  ].map(({ start, end }) => ({ start, end })));
  const turnTimelineMs = turnCompleted.createdAt - turnStarted.createdAt;
  return {
    ...common,
    turnTimelineMs,
    nativePluginTimelineMs,
    shellSearchTimelineMs,
    reasoningTimelineMs,
    classifiedTimelineMs,
    unaccountedTurnTimelineMs: classifiedTimelineMs === null ? null : turnTimelineMs - classifiedTimelineMs,
  };
}
