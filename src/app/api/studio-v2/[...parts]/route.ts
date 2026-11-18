import { handle } from "@/server/studio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function dispatch(request: Request, context: RouteContext<"/api/studio-v2/[...parts]">) {
  return handle(request, (await context.params).parts);
}

export { dispatch as GET, dispatch as POST, dispatch as PUT };
