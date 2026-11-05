import { readBody } from "h3";
import { requireSession } from "~/server/utils/authz";
import { prisma } from "~/server/utils/prisma";
import { throwValidation } from "~/server/utils/api-errors";
import { normalizeWebPushToken } from "~/server/utils/web-push";

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const body = ((await readBody(event)) ?? {}) as { token?: unknown; platform?: unknown };
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  if (!rawToken || rawToken.length > 4096) {
    throwValidation("Push-Token ist ungültig", { field: "token" });
  }
  const platform = body.platform === "ios" || body.platform === "web" ? body.platform : "android";
  const token = platform === "web" ? normalizeWebPushToken(rawToken) : rawToken;
  if (!token) {
    throwValidation("Web-Push-Abo ist ungültig", { field: "token" });
  }
  await prisma.devicePushToken.upsert({
    where: { token },
    create: { userId: session.user.id, token, platform },
    update: { userId: session.user.id, platform },
  });
  console.info(`[push] token registered user=${session.user.id} platform=${platform}`);
  return { ok: true as const };
});
