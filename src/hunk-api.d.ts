import type { ExtensionReviewSnapshotNote } from "hunkdiff/extension";

// API 16 additions absent from the minimum-release-age-eligible development SDK.
// Exact public contract: modem-dev/hunk v0.21.1 src/extension-api/types.ts,
// ExtensionReviewSnapshotNote, ExtensionReviewNote, and ExtensionEventPayloads.
// Runtime remains API 16+; these declarations do not implement a compatibility layer.
declare module "hunkdiff/extension" {
  interface ExtensionReviewSnapshotNote {
    readonly parentId?: string;
  }

  interface ExtensionReviewNote {
    parentId?: string;
  }

  interface ExtensionEventPayloads {
    note_changed: {
      kind: "created" | "updated" | "removed";
      note: ExtensionReviewSnapshotNote;
    };
  }
}
