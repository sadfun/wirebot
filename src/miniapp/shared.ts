/** Small helpers shared by the Mini App screens. */
import { useEffect, useState } from "react";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

export interface AsyncState<Value> {
  readonly value?: Value | undefined;
  readonly error?: string | undefined;
}

/**
 * Shared fetch effect: clears its state and reloads when the dependencies
 * change, dropping results from superseded attempts. A missing loader keeps
 * the state empty.
 */
export function useAsync<Value>(
  load: (() => Promise<Value>) | undefined,
  deps: readonly unknown[],
): AsyncState<Value> {
  const [state, setState] = useState<AsyncState<Value>>({});
  useEffect(() => {
    setState({});
    if (load === undefined) return;
    let active = true;
    load()
      .then((value) => {
        if (active) setState({ value });
      })
      .catch((error: unknown) => {
        if (active) setState({ error: messageOf(error) });
      });
    return () => {
      active = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller owns the dependency list.
  }, deps);
  return state;
}
