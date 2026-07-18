import type { HunkExecResult, HunkRunner } from "../../extensions/hunk-session.ts";

export type HunkRoute = (argv: readonly string[]) => HunkExecResult | Promise<HunkExecResult>;

export function hunkTestLayer(route: HunkRoute): {
  run: HunkRunner;
  readonly calls: readonly (readonly string[])[];
} {
  const calls: string[][] = [];
  const run: HunkRunner = async (argv) => {
    const call = [...argv];
    calls.push(call);
    return route(call);
  };
  return {
    run,
    get calls() {
      return calls.map((call) => [...call]);
    },
  };
}
