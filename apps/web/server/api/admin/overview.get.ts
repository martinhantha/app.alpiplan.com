import { prisma } from "~/server/utils/prisma";
import { requireSuperadmin } from "~/server/utils/authz";
import type { SuperadminOverview } from "~/types/superadmin";

export default defineEventHandler(async (event) => {
  await requireSuperadmin(event);

  const [tenants, users] = await Promise.all([
    prisma.tenant.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        useDefaultDuration: true,
        speechRecognitionEnabled: true,
        aiParsingEnabled: true,
        createdAt: true,
      },
    }),
    prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperadmin: true,
        disabledAt: true,
        memberships: {
          where: { deletedAt: null },
          select: {
            role: true,
            tenant: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    }),
  ]);

  const payload: SuperadminOverview = {
    tenants: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      useDefaultDuration: t.useDefaultDuration,
      speechRecognitionEnabled: t.speechRecognitionEnabled,
      aiParsingEnabled: t.aiParsingEnabled,
      createdAt: t.createdAt.toISOString(),
    })),
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isSuperadmin: u.isSuperadmin,
      disabledAt: u.disabledAt?.toISOString() ?? null,
      memberships: u.memberships.map((m) => ({
        tenantId: m.tenant.id,
        tenantName: m.tenant.name,
        tenantSlug: m.tenant.slug,
        role: m.role,
      })),
    })),
  };

  return payload;
});
