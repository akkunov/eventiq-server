"use client";

import { useRef } from "react";
import { StudioV2ProjectRenderer } from "@/components/studio-v2/studio-v2-project-renderer";
import type { ProjectDocumentV2 } from "@/features/studio-v2/core/document.schema.ts";
import type { RsvpInput } from "@/features/studio-v2/core/invitation.schema.ts";

export function PublishedInvitation({ id, document, mediaUrls }: {
  id: string; document: ProjectDocumentV2; mediaUrls: Record<string, string>;
}) {
  const pending = useRef(new Map<string, { key: string; body: string }>());
  async function submitRsvp(nodeId: string, input: RsvpInput) {
    const body = JSON.stringify(input);
    let attempt = pending.current.get(nodeId);
    if (!attempt || attempt.body !== body) {
      attempt = { body, key: crypto.randomUUID() };
      pending.current.set(nodeId, attempt);
    }
    const response = await fetch(`/api/studio-v2/publications/${id}/rsvp/${encodeURIComponent(nodeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key },
      body,
    });
    if (!response.ok) throw new Error("RSVP unavailable");
    pending.current.delete(nodeId);
  }
  return <main><StudioV2ProjectRenderer document={document} mediaUrls={mediaUrls}
    guest={{ mode: "live", submitRsvp }} /></main>;
}
