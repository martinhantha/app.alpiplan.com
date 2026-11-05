import { readBody } from "h3";
import { requireSession } from "~/server/utils/authz";
import { prisma } from "~/server/utils/prisma";
import { normalizeWebPushToken } from "~/server/utils/web-push";

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const body = ((await readBody(event)) ?? {}) as { token?: unknown };
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  const token = (rawToken && normalizeWebPushToken(rawToken)) || rawToken;
  if (!token) {
    // A DELETE without token used to remove every device of the user (phone included).
    // Stale rows are pruned by the push services themselves, so do nothing here.
    console.warn("[push] token removal without token ignored for user", session.user.id);
    return { ok: true as const };
  }
  const removed = await prisma.devicePushToken.deleteMany({ where: { userId: session.user.id, token } });
  console.info(`[push] token removed user=${session.user.id} rows=${removed.count}`);
  return { ok: true as const };
});
