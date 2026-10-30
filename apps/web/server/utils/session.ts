import type { AuthSession } from "~/types/auth";
import { prisma } from "./prisma";

export async function loadUserWithMemberships(userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, deletedAt: null, disabledAt: null },
    include: {
      memberships: {
        where: { deletedAt: null },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
              useDefaultDuration: true,
              teacherLabel: true,
              resourcesEnabled: true,
              speechRecognitionEnabled: true,
              speechLanguage: true,
              aiParsingEnabled: true,
              assistantHints: true,
              autoCompleteAppointments: true,
              autoCompleteAfterMinutes: true,
            },
          },
          teacherProfile: { select: { id: true, deletedAt: true } },
        },
      },
    },
  });
}

export function toAuthSession(user: NonNullable<Awaited<ReturnType<typeof loadUserWithMemberships>>>): AuthSession {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperadmin: user.isSuperadmin,
      nextDayBriefingEnabled: user.nextDayBriefingEnabled,
      nextDayBriefingMinutes: user.nextDayBriefingMinutes,
      appointmentMovedAlertsEnabled: user.appointmentMovedAlertsEnabled,
      appointmentReminderEnabled: user.appointmentReminderEnabled,
      uiScale: user.uiScale === "medium" || user.uiScale === "large" ? user.uiScale : "small",
    },
    memberships: user.memberships.map((m) => ({
      tenantId: m.tenantId,
      tenantName: m.tenant.name,
      tenantSlug: m.tenant.slug,
      role: m.role,
      useDefaultDuration: m.tenant.useDefaultDuration,
      teacherLabel: m.tenant.teacherLabel?.trim() || "Lehrer",
      resourcesEnabled: m.tenant.resourcesEnabled,
      speechRecognitionEnabled: m.tenant.speechRecognitionEnabled,
      speechLanguage: m.tenant.speechLanguage,
      aiParsingEnabled: m.tenant.aiParsingEnabled,
      assistantHints: m.tenant.assistantHints,
      autoCompleteAppointments: m.tenant.autoCompleteAppointments,
      autoCompleteAfterMinutes: m.tenant.autoCompleteAfterMinutes,
      teacherProfileId: m.teacherProfile?.deletedAt ? null : m.teacherProfile?.id ?? null,
      performsAppointments: m.performsAppointments,
    })),
  };
}

/** Superadmins can act in every tenant; expose the ones without a real membership as virtual admin entries. */
export async function withSuperadminTenants(session: AuthSession): Promise<AuthSession> {
  if (!session.user.isSuperadmin) return session;
  const ownTenantIds = session.memberships.map((m) => m.tenantId);
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, id: { notIn: ownTenantIds } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      useDefaultDuration: true,
      teacherLabel: true,
      resourcesEnabled: true,
      speechRecognitionEnabled: true,
      speechLanguage: true,
      aiParsingEnabled: true,
      assistantHints: true,
      autoCompleteAppointments: true,
      autoCompleteAfterMinutes: true,
    },
  });
  return {
    ...session,
    memberships: [
      ...session.memberships,
      ...tenants.map((tenant) => ({
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        role: "ADMIN" as const,
        useDefaultDuration: tenant.useDefaultDuration,
        teacherLabel: tenant.teacherLabel?.trim() || "Lehrer",
        resourcesEnabled: tenant.resourcesEnabled,
        speechRecognitionEnabled: tenant.speechRecognitionEnabled,
        speechLanguage: tenant.speechLanguage,
        aiParsingEnabled: tenant.aiParsingEnabled,
        assistantHints: tenant.assistantHints,
        autoCompleteAppointments: tenant.autoCompleteAppointments,
        autoCompleteAfterMinutes: tenant.autoCompleteAfterMinutes,
        teacherProfileId: null,
        performsAppointments: false,
      })),
    ],
  };
}
