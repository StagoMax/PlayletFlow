import { useCallback, useEffect, useReducer } from "react";
import type { WorkspaceResource } from "./types";
import type { WorkspaceClient } from "./workspaceClient";

type QueryState = WorkspaceResource & { request: number };

type QueryAction =
  | { type: "loading"; request: number }
  | { type: "loaded"; request: number; data: Awaited<ReturnType<WorkspaceClient["load"]>> }
  | { type: "failed"; request: number; message: string };

function reducer(state: QueryState, action: QueryAction): QueryState {
  if (action.request < state.request) return state;
  if (action.type === "loading") return { status: "loading", request: action.request };
  if (action.type === "failed") return { status: "error", message: action.message, request: action.request };
  if (action.data.storyboards.length === 0) {
    return { status: "empty", projectName: action.data.project.name, request: action.request };
  }
  return { status: "ready", data: action.data, request: action.request };
}

export function useWorkspaceQueries(client: WorkspaceClient) {
  const [state, dispatch] = useReducer(reducer, { status: "loading", request: 0 });

  const retry = useCallback(() => {
    dispatch({ type: "loading", request: state.request + 1 });
  }, [state.request]);

  useEffect(() => {
    const controller = new AbortController();
    const request = state.request;
    void client.load(controller.signal).then(
      (data) => dispatch({ type: "loaded", request, data }),
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "failed", request, message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => controller.abort();
  }, [client, state.request]);

  return { resource: state as WorkspaceResource, retry };
}
