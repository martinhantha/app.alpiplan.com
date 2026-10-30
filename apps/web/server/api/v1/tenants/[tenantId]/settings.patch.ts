import { getRouterParam, readBody } from "h3";
import { prisma } from "~/server/utils/prisma";
import { assertUuid, requireTenantAccess } from "~/server/utils/authz";
import { throwValidation } from "~/server/utils/api-errors";
import { isSpeechLanguage } from "~/utils/speech-languages";

const TENANT_SETTINGS_SELECT = {
  id: true,
  name: true,
  slug: true,
  useDefaultDuration: true,
  defaultTeacherId: true,
  defaultLessonTypeId: true,
  teacherLabel: true,
  resourcesEnabled: true,
  speechRecognitionEnabled: true,
  speechLanguage: true,
  aiParsingEnabled: true,
  assistantHints: true,
  autoCompleteAppointments: true,
  autoCompleteAfterMinutes: true,
} as const;

function normalizeTeacherLabel(value: unknown): string {
  if (typeof value !== "string") {
    throwValidation("Bezeichnung ist erforderlich", { field: "teacherLabel" });
  }
  const label = value.trim();
  if (!label || label.length > 40) {
    throwValidation("Bezeichnung muss 1–40 Zeichen haben", { field: "teacherLabel" });
  }
  return label;
}

export default defineEventHandler(async (event) => {
  const access = await requireTenantAccess(event, getRouterParam(event, "tenantId"), ["ADMIN"]);
  const body =
    (await readBody<{
      useDefaultDuration?: boolean;
      defaultTeacherId?: string | null;
      defaultLessonTypeId?: string | null;
      teacherLabel?: string;
      resourcesEnabled?: boolean;
      speechRecognitionEnabled?: boolean;
      speechLanguage?: string;
      aiParsingEnabled?: boolean;
      assistantHints?: string | null;
      autoCompleteAppointments?: boolean;
      autoCompleteAfterMinutes?: number;
    }>(event)) ?? {};

  const data: {
    useDefaultDuration?: boolean;
    defaultTeacherId?: string | null;
    defaultLessonTypeId?: string | null;
    teacherLabel?: string;
    resourcesEnabled?: boolean;
    speechRecognitionEnabled?: boolean;
    speechLanguage?: string;
    aiParsingEnabled?: boolean;
    assistantHints?: string | null;
    autoCompleteAppointments?: boolean;
    autoCompleteAfterMinutes?: number;
  } = {};
  if (typeof body.useDefaultDuration === "boolean") {
    data.useDefaultDuration = body.useDefaultDuration;
  }
  if (typeof body.resourcesEnabled === "boolean") {
    data.resourcesEnabled = body.resourcesEnabled;
  }
  // Speech recognition and AI parsing are enabled per tenant by the operator (superadmin) only.
  const isSuperadmin = Boolean(access.session.user.isSuperadmin);
  if (typeof body.speechRecognitionEnabled === "boolean") {
    if (!isSuperadmin) {
      throwValidation("Spracherkennung wird vom Betreiber freigeschaltet", { field: "speechRecognitionEnabled" });
    }
    data.speechRecognitionEnabled = body.speechRecognitionEnabled;
  }
  if (typeof body.aiParsingEnabled === "boolean") {
    if (!isSuperadmin) {
      throwValidation("KI-Textauswertung wird vom Betreiber freigeschaltet", { field: "aiParsingEnabled" });
    }
    data.aiParsingEnabled = body.aiParsingEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(body, "speechLanguage")) {
    if (!isSpeechLanguage(body.speechLanguage)) {
      throwValidation("Sprache wird nicht unterstützt", { field: "speechLanguage" });
    }
    data.speechLanguage = body.speechLanguage;
  }
  if (Object.prototype.hasOwnProperty.call(body, "assistantHints")) {
    if (body.assistantHints === null || body.assistantHints === "") {
      data.assistantHints = null;
    } else if (typeof body.assistantHints === "string" && body.assistantHints.trim().length <= 2000) {
      data.assistantHints = body.assistantHints.trim();
    } else {
      throwValidation("Hinweise dürfen maximal 2000 Zeichen haben", { field: "assistantHints" });
    }
  }
  if (typeof body.autoCompleteAppointments === "boolean") {
    data.autoCompleteAppointments = body.autoCompleteAppointments;
  }
  if (Object.prototype.hasOwnProperty.call(body, "autoCompleteAfterMinutes")) {
    const minutes = Number(body.autoCompleteAfterMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
      throwValidation("Minuten müssen zwischen 0 und 1440 liegen", { field: "autoCompleteAfterMinutes" });
    }
    data.autoCompleteAfterMinutes = minutes;
  }
  if (Object.prototype.hasOwnProperty.call(body, "teacherLabel")) {
    data.teacherLabel = normalizeTeacherLabel(body.teacherLabel);
  }
  if (Object.prototype.hasOwnProperty.call(body, "defaultTeacherId")) {
    if (body.defaultTeacherId === null || body.defaultTeacherId === "") {
      data.defaultTeacherId = null;
    } else if (typeof body.defaultTeacherId === "string") {
      const teacherId = assertUuid(body.defaultTeacherId, "defaultTeacherId");
      const teacher = await prisma.teacherProfile.findFirst({
        where: {
          id: teacherId,
          tenantId: access.tenant.id,
          deletedAt: null,
          membership: { deletedAt: null },
        },
        select: { id: true },
      });
      if (!teacher) {
        throwValidation("Lehrer nicht gefunden", { field: "defaultTeacherId" });
      }
      data.defaultTeacherId = teacher.id;
    } else {
      throwValidation("defaultTeacherId ist ungültig", { field: "defaultTeacherId" });
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "defaultLessonTypeId")) {
    if (body.defaultLessonTypeId === null || body.defaultLessonTypeId === "") {
      data.defaultLessonTypeId = null;
    } else if (typeof body.defaultLessonTypeId === "string") {
      const lessonTypeId = assertUuid(body.defaultLessonTypeId, "defaultLessonTypeId");
      const lessonType = await prisma.lessonType.findFirst({
        where: {
          id: lessonTypeId,
          tenantId: access.tenant.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!lessonType) {
        throwValidation("Terminart nicht gefunden", { field: "defaultLessonTypeId" });
      }
      data.defaultLessonTypeId = lessonType.id;
    } else {
      throwValidation("defaultLessonTypeId ist ungültig", { field: "defaultLessonTypeId" });
    }
  }

  if (!Object.keys(data).length) {
    throwValidation("Keine Änderungen übermittelt");
  }

  return prisma.tenant.update({
    where: { id: access.tenant.id },
    data,
    select: TENANT_SETTINGS_SELECT,
  });
});
