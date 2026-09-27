import { useMemo } from "react";
import { cloudMode } from "./api";
import { cloudApi } from "./cloudApi";
import { RuntimePanel } from "./chat/RuntimePanel";
import {
  createFixtureWorkspaceThreadClient,
  createHttpWorkspaceThreadClient,
} from "./chat/workspaceThreadClient";
import { createFixtureWorkspaceClient, fixtureModeFromLocation } from "./workspace/fixtureWorkspaceClient";
import type { WorkspaceAssistantScope } from "./workspace/WorkspacePage";
import { WorkspacePage } from "./workspace/WorkspacePage";

const workspaceThreadClient = cloudMode
  ? createFixtureWorkspaceThreadClient(cloudApi)
  : createHttpWorkspaceThreadClient();

function AssistantPanel(scope: WorkspaceAssistantScope) {
  return <RuntimePanel client={workspaceThreadClient} {...scope} />;
}

export default function App() {
  const workspaceClient = useMemo(() => createFixtureWorkspaceClient(fixtureModeFromLocation()), []);
  return <WorkspacePage client={workspaceClient} assistantPanel={AssistantPanel} />;
}
