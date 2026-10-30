import { getRouterParam, readBody } from "h3";
import { requireTenantAccess, staffAppointmentScope } from "~/server/utils/authz";
import { prisma } from "~/server/utils/prisma";
import { throwValidation } from "~/server/utils/api-errors";
import {
  parseAppointmentIntent,
  resolveExtractedIntent,
  type IntentCatalog,
  type ParseIntentResult,
} from "~/server/utils/parse-intent";
import { aiIntentLabel, extractIntentWithAi, isAiIntentAvailable } from "~/server/utils/ai-intent";
import { suggestNextPrioritySlot } from "~/server/utils/scheduling";

const TIME_ZONE = "Europe/Rome";

export default defineEventHandler(async (event) => {
  const access = await requireTenantAccess(event, getRouterParam(event, "tenantId"));
  const body = ((await readBody(event)) ?? {}) as {
    text?: unknown;
    answers?: Record<string, string>;
  };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    throwValidation("Text ist erforderlich", { field: "text" });
  }
  const answers = body.answers && typeof body.answers === "object" ? body.answers : {};

  const scope = await staffAppointmentScope(access);

  const [teachers, resources, lessonTypes, customers, tenant] = await Promise.all([
    prisma.teacherProfile.findMany({
      where: {
        tenantId: access.tenant.id,
        deletedAt: null,
        membership: { deletedAt: null },
        ...(scope.forceTeacherId ? { id: scope.forceTeacherId } : {}),
      },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
    prisma.resource.findMany({
      where: { tenantId: access.tenant.id, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.lessonType.findMany({
      where: { tenantId: access.tenant.id, deletedAt: null },
      select: { id: true, name: true, defaultDurationMin: true },
      orderBy: { name: "asc" },
    }),
    prisma.customer.findMany({
      where: { tenantId: access.tenant.id, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        phones: {
          where: { deletedAt: null },
          select: { e164: true, raw: true },
        },
      },
      orderBy: { displayName: "asc" },
      take: 300,
    }),
    prisma.tenant.findUnique({
      where: { id: access.tenant.id },
      select: { teacherLabel: true, aiParsingEnabled: true, assistantHints: true },
    }),
  ]);

  const now = new Date();
  const catalog: IntentCatalog = {
    now,
    timeZone: TIME_ZONE,
    teacherLabel: tenant?.teacherLabel?.trim() || "Lehrer",
    teachers,
    resources,
    lessonTypes: lessonTypes.map((item) => ({
      id: item.id,
      displayName: item.name,
      defaultDurationMin: item.defaultDurationMin,
    })),
    customers,
  };

  let result: ParseIntentResult | null = null;
  let source: "ai" | "rules" = "rules";

  if (tenant?.aiParsingEnabled && isAiIntentAvailable()) {
    const started = Date.now();
    try {
      // Customers are not sent to the model; names come back as text and are matched here.
      const ai = await extractIntentWithAi(text, {
        now,
        timeZone: TIME_ZONE,
        teacherLabel: catalog.teacherLabel,
        teachers: teachers.map((item) => item.displayName),
        lessonTypes: lessonTypes.map((item) => ({ name: item.name, defaultDurationMin: item.defaultDurationMin })),
        resources: resources.map((item) => item.name),
        hints: tenant.assistantHints,
      });
      result = resolveExtractedIntent({ ...ai.extraction, contactText: text }, catalog, answers);
      source = "ai";
      console.info(
        `[assistant] ${ai.provider}/${ai.model} ${ai.latencyMs}ms in=${ai.usage.inputTokens} out=${ai.usage.outputTokens} tenant=${access.tenant.slug}`,
      );
      void prisma.assistantUsage
        .create({
          data: {
            tenantId: access.tenant.id,
            userId: access.actorUserId,
            model: `${ai.provider}/${ai.model}`,
            inputTokens: ai.usage.inputTokens,
            outputTokens: ai.usage.outputTokens,
            cacheReadTokens: ai.usage.cacheReadTokens,
            latencyMs: ai.latencyMs,
            ok: true,
          },
        })
        .catch(() => undefined);
    } catch (error) {
      console.error("[assistant] AI parse failed, using rule parser", error);
      void prisma.assistantUsage
        .create({
          data: {
            tenantId: access.tenant.id,
            userId: access.actorUserId,
            model: aiIntentLabel(),
            latencyMs: Date.now() - started,
            ok: false,
          },
        })
        .catch(() => undefined);
    }
  }

  if (!result) {
    result = parseAppointmentIntent(text, catalog, answers);
  }

  if (scope.forceTeacherId) {
    const ownTeacher = teachers.find((teacher) => teacher.id === scope.forceTeacherId);
    result.parsed.teacherId = scope.forceTeacherId;
    result.parsed.teacherName = ownTeacher?.displayName;
    result.fieldConfidence.teacherId = 1;
  }

  if (!result.parsed.time) {
    const lessonType = lessonTypes.find((item) => item.id === result!.parsed.lessonTypeId);
    const slot = await suggestNextPrioritySlot(access.tenant.id, {
      teacherId: result.parsed.teacherId ?? scope.forceTeacherId ?? undefined,
      resourceId: result.parsed.resourceId,
      lessonTypeId: result.parsed.lessonTypeId,
      durationMin: result.parsed.durationMinutes ?? lessonType?.defaultDurationMin ?? 60,
      onDate: result.parsed.date,
    });
    if (slot) {
      result.parsed.date = slot.date;
      result.parsed.time = slot.time;
      result.fieldConfidence.date = result.fieldConfidence.date ?? 0.6;
      result.fieldConfidence.time = 0.6;
      if (!result.parsed.teacherId && slot.teacherId) {
        result.parsed.teacherId = slot.teacherId;
        result.parsed.teacherName = slot.teacherName ?? undefined;
        result.fieldConfidence.teacherId = 0.55;
      }
      if (!result.parsed.resourceId && slot.resourceId) {
        result.parsed.resourceId = slot.resourceId;
        result.fieldConfidence.resourceId = 0.5;
      }
      result.suggestedDefaults = {
        slotSource: "priority",
        priority: slot.priority,
        date: slot.date,
        time: slot.time,
        teacherName: slot.teacherName,
      };
    }
  }

  return { ...result, source };
});
