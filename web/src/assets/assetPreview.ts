import type { ReactNode } from "react";
import type { Asset } from "../productApi/generated";

export type AssetPreviewRenderer = (asset: Asset, mediaId: string) => ReactNode;
