import { notFound } from "next/navigation";
import { mediaUrls, publication } from "@/server/studio";
import { PublishedInvitation } from "./published-invitation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function InvitationPage({ params }: PageProps<"/i/[id]">) {
  const { id } = await params;
  const entry = publication(id);
  if (!entry) notFound();
  return <PublishedInvitation id={id} document={entry.document} mediaUrls={mediaUrls(id, entry.document)} />;
}
