export const CURSOR_CODEX_EFFORTS = ["low", "medium", "high"] as const;

export type CursorCodexEffort = (typeof CURSOR_CODEX_EFFORTS)[number];

export interface CursorCodexModel {
  id: string;
  displayName: string;
  description: string;
  defaultEffort: CursorCodexEffort;
  supportedEfforts: readonly CursorCodexEffort[];
  matchesRequest(model: string): boolean;
  cliSelector(effort: CursorCodexEffort): string;
  availableSelectors: readonly string[];
}

function effortSelectors(
  selector: (effort: CursorCodexEffort) => string,
): string[] {
  return CURSOR_CODEX_EFFORTS.map(selector);
}

export const CURSOR_CODEX_MODELS: readonly CursorCodexModel[] = [
  {
    id: "cursor-claude-fable-5",
    displayName: "Fable 5",
    description: "Cursor Fable 5 via auth2api; thinking enabled",
    defaultEffort: "high",
    supportedEfforts: CURSOR_CODEX_EFFORTS,
    matchesRequest: (model) =>
      /^(?:cursor[-:/])?claude-fable-5(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?$/i.test(
        model,
      ),
    cliSelector: (effort) => `claude-fable-5-thinking-${effort}`,
    availableSelectors: effortSelectors(
      (effort) => `cursor-claude-fable-5-thinking-${effort}`,
    ),
  },
  {
    id: "cursor-grok-4.5-fast",
    displayName: "Grok 4.5 Fast",
    description: "Cursor Grok 4.5 via auth2api; fast enabled",
    defaultEffort: "high",
    supportedEfforts: CURSOR_CODEX_EFFORTS,
    matchesRequest: (model) =>
      /^(?:cursor[-:/])?(?:cursor-)?grok-4\.5(?:-(?:low|medium|high))?(?:-fast)?$/i.test(
        model,
      ),
    cliSelector: (effort) => `cursor-grok-4.5-${effort}-fast`,
    availableSelectors: effortSelectors(
      (effort) => `cursor-grok-4.5-${effort}-fast`,
    ),
  },
] as const;

export function findCursorCodexModel(
  requestedModel: string,
): CursorCodexModel | undefined {
  return CURSOR_CODEX_MODELS.find((model) =>
    model.matchesRequest(requestedModel.trim()),
  );
}

export function cursorCodexModelsAvailableIn(
  modelIds: Iterable<string>,
): readonly CursorCodexModel[] {
  const available = Array.from(modelIds, (id) => id.trim().toLowerCase());
  if (
    available.some((id) =>
      ["cursor-premium", "cursor-fast", "cursor-composer"].includes(id),
    )
  ) {
    return CURSOR_CODEX_MODELS;
  }
  return CURSOR_CODEX_MODELS.filter((model) =>
    available.some(
      (id) =>
        model.matchesRequest(id) ||
        model.availableSelectors.some(
          (selector) => selector.toLowerCase() === id,
        ),
    ),
  );
}
