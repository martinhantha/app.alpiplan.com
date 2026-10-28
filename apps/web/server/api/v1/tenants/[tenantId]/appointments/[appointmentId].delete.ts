import { getRouterParam, setResponseStatus } from "h3";
import { throwNotFound } from "~/server/utils/api-errors";
import { requireTenantAccess, staffAppointmentScope, staffOwnsAppointment } from "~/server/utils/authz";
import { publishAppointmentLive, toAppointmentLiveEvent } from "~/server/utils/appointment-events";
import { getAppointment, softDeleteAppointment } from "~/server/utils/scheduling";

export default defineEventHandler(async (event) => {
  const access = await requireTenantAccess(event, getRouterParam(event, "tenantId"));
  const scope = await staffAppointmentScope(access);
  if (scope.empty) {
    throwNotFound("Termin nicht gefunden");
  }

  const appointmentId = getRouterParam(event, "appointmentId");
  const existing = await getAppointment(access.tenant.id, appointmentId);

  if (!staffOwnsAppointment(scope.forceTeacherId, existing)) {
    throwNotFound("Termin nicht gefunden", { appointmentId: existing.id });
  }

  await softDeleteAppointment(access.tenant.id, appointmentId, access.actorUserId);

  publishAppointmentLive(
    await toAppointmentLiveEvent("appointment.deleted", access.tenant.id, access.actorUserId, existing),
  );

  setResponseStatus(event, 204);
  return null;
});
