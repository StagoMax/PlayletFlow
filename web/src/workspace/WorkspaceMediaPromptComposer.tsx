import { MediaPromptComposer, type MediaPromptComposerProps } from "../preview/MediaPromptComposer";
import { useLatestGenerationInput } from "./useLatestGenerationInput";

type Props = MediaPromptComposerProps & {
  projectId: string;
  mediaId: string;
  targetRevision: number;
  generationJobId?: string | null;
};

export function WorkspaceMediaPromptComposer({ projectId, mediaId, targetRevision, generationJobId, ...props }: Props) {
  const initialGenerationInput = useLatestGenerationInput(projectId, mediaId, targetRevision, generationJobId);
  return <MediaPromptComposer {...props} initialGenerationInput={initialGenerationInput} />;
}
