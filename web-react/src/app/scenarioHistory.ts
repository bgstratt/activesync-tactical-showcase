import type { DemoScenarioRunResponse } from "../../../shared/contracts/runtime";

const MAX_SCENARIO_HISTORY = 12;

export interface ScenarioHistoryEntry {
  scenarioId: string;
  mode: string;
  completedAtUtc: string;
  ok: boolean;
  passed: number;
  total: number;
  message: string;
  buildRef: string;
}

function historyKey(mode: string): string {
  return `scenario-history:${mode}`;
}

function resolveBuildRef(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_GIT_COMMIT ?? env.VITE_COMMIT_SHA ?? env.VITE_BUILD_REF ?? "dev";
}

export function loadScenarioHistory(mode: string): ScenarioHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(historyKey(mode));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as ScenarioHistoryEntry[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.slice(0, MAX_SCENARIO_HISTORY);
  } catch {
    return [];
  }
}

export function recordScenarioRun(mode: string, response: DemoScenarioRunResponse): ScenarioHistoryEntry[] {
  const passed = response.assertions.filter((item) => item.passed).length;
  const total = response.assertions.length;

  const next: ScenarioHistoryEntry = {
    scenarioId: response.scenarioId,
    mode: response.mode,
    completedAtUtc: response.completedAtUtc,
    ok: response.ok,
    passed,
    total,
    message: response.message,
    buildRef: resolveBuildRef()
  };

  const history = [next, ...loadScenarioHistory(mode)].slice(0, MAX_SCENARIO_HISTORY);
  try {
    window.localStorage.setItem(historyKey(mode), JSON.stringify(history));
  } catch {
    // Non-fatal when storage is unavailable.
  }

  return history;
}
