import { prisma } from "~/server/utils/prisma";
import { requireSuperadmin } from "~/server/utils/authz";

function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export default defineEventHandler(async (event) => {
  await requireSuperadmin(event);
  const body = await readBody<{
    name?: string;
    slug?: string;
    useDefaultDuration?: boolean;
    speechRecognitionEnabled?: boolean;
    aiParsingEnabled?: boolean;
  }>(event);

  const name = body.name?.trim();
  const slug = normalizeSlug(body.slug ?? "");

  if (!name || name.length < 2) {
    throw createError({ statusCode: 400, statusMessage: "Name ist erforderlich (min. 2 Zeichen)" });
  }
  if (!slug || slug.length < 2) {
    throw createError({ statusCode: 400, statusMessage: "Slug ist erforderlich (min. 2 Zeichen)" });
  }

  const tenant = await prisma.tenant.create({
    data: {
      name,
      slug,
      useDefaultDuration: typeof body.useDefaultDuration === "boolean" ? body.useDefaultDuration : true,
      speechRecognitionEnabled: body.speechRecognitionEnabled === true,
      aiParsingEnabled: body.aiParsingEnabled === true,
    },
    select: {
      id: true,
      name: true,
      slug: true,
      useDefaultDuration: true,
      speechRecognitionEnabled: true,
      aiParsingEnabled: true,
      createdAt: true,
    },
  });

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    useDefaultDuration: tenant.useDefaultDuration,
    speechRecognitionEnabled: tenant.speechRecognitionEnabled,
    aiParsingEnabled: tenant.aiParsingEnabled,
    createdAt: tenant.createdAt.toISOString(),
  };
});
